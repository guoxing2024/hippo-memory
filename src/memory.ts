/**
 * Hippocampus-inspired memory store (v2).
 *
 * The class mirrors the hippocampus → cortex division of labor:
 *
 *   remember()        ~ DG sparse binding + CA3 pattern separation:
 *                      near-duplicate → strengthen; near-contradiction on the
 *                      same event/entity scope → versioned override (old
 *                      revision archived, never silently lost); otherwise a
 *                      new sparse trace.
 *   recall()          ~ cue-driven pattern completion with a single scan of
 *                      the store; results annotated with provenance and
 *                      conflict warnings (a "source monitoring" affordance).
 *   consolidate()     ~ systems consolidation: well-established episodic
 *                      traces are abstracted into durable semantic rules.
 *   forget()          ~ adaptive forgetting: Ebbinghaus-style decay of weak
 *                      traces and soft-deletion of long-idle ones.
 *   sourceMonitor()   ~ prefrontal stand-in: substantiated / unsubstantiated /
 *                      contradicted verdicts so the agent can say "I don't
 *                      know" instead of confabulating.
 *   composeContext()  ~ working-memory gate: pick the few traces that matter
 *                      for the current goal, not the whole history.
 *
 * Storage is SQLite (node:sqlite) with an in-process vector tier — zero
 * external services. Embeddings are pluggable; without a provider we fall
 * back to a deterministic feature-hash bag-of-words encoder (enough for
 * tests/demos). All active rows live in one table: episode / semantic /
 * procedure are kinds of the same engram, versioned per id.
 */

import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  DEFAULT_OPTIONS,
  type CompressPlan,
  type CompressResult,
  type ConflictOutcome,
  type ConsolidationCandidate,
  type EmbeddingProvider,
  type MemoryKind,
  type MemoryPayload,
  type RecallBundle,
  type RelatedTrace,
  type RetrievedMemory,
  type RetrievalCue,
  type StoredMemory,
  type StoreOptions,
  type Summarizer,
  type WriteNeighbour,
  nowIso
} from './schema.js';
import { SCOPE_RULE, SqliteStore, surveyStores, vecFromBlob, vecToBlob, type MemoryRow, type StoreSurveyEntry } from './sqlite.js';
import { cosine, embedHashing } from './vectors.js';
import { dataFrame, rangeCheck, sanitizeMemoryText } from './guard.js';

function tagList(tagsJson: string): string[] {
  try {
    return (JSON.parse(tagsJson || '[]') as string[]).map((t) => String(t).toLowerCase());
  } catch {
    return [];
  }
}

/** Marker/pattern rows never join compression groups (already condensed). */
function isCondensedRow(r: { tags_json: string }): boolean {
  const tags = tagList(r.tags_json);
  return tags.includes('retraction') || tags.includes('guard') || tags.includes('invariant');
}

function isRetractionRow(r: { tags_json: string }): boolean {
  return tagList(r.tags_json).includes('retraction');
}

/**
 * Evidence freshness (S2保鲜期): passing evidence counts as VERIFIED only
 * inside its TTL. A missing timestamp is stale by definition (unproven
 * freshness); a `fail` never counts. Stale rows render [ASSERTED] and lose
 * the retirement shield — re-run the check to refresh verifiedAt.
 */
function evidenceFresh(
  result: string | null | undefined,
  verifiedAt: string | null | undefined,
  nowMs: number,
  ttlSec: number
): boolean {
  if (result !== 'pass' || !verifiedAt) return false;
  const at = Date.parse(verifiedAt);
  if (!Number.isFinite(at) || at > nowMs) return false;
  return nowMs - at <= Math.max(0, ttlSec) * 1000;
}

/**
 * Evidence standing (audit #5): the engine never executes verify.cmd, so a
 * reported pass has two trust tiers. `attested` = the caller demonstrably ran
 * a reproducible check (full shield + plain [VERIFIED]); `self-reported` =
 * an honest agent assertion (renders [VERIFIED self-reported], shield
 * degraded to a warning). Anything else is not evidence.
 */
function evidenceStanding(row: {
  verify_result: string | null | undefined;
  verified_at: string | null | undefined;
  verify_attested?: number | null;
}, nowMs: number, ttlSec: number): 'attested' | 'self-reported' | 'none' {
  if (!evidenceFresh(row.verify_result, row.verified_at, nowMs, ttlSec)) return 'none';
  return row.verify_attested === 1 ? 'attested' : 'self-reported';
}

/**
 * Fillers that carry no value information when comparing claim values.
 * NOTE: the article "a" is deliberately NOT a filler here. claimParts lowercases
 * values, so an enumerator label ("cluster A" vs "cluster B") arrives as "cluster
 * a" / "cluster b" — dropping "a" made {cluster} a subset of {cluster,b} and the
 * clash read as a refinement (field report: single-letter values never
 * contradicted). Keeping "a" is safe because a genuine article refinement
 * ("a postgres" vs "postgres") is still caught by the containment test, and the
 * copula parser already strips a leading "a/an/the" before this comparison.
 */
const VALUE_FILLER = new Set(['and', 'or', 'with', 'the', 'an', 'of', 'to', 'in', 'on', 'for', 'at', 'by', 'as', 'per']);

/** Terms of a claim value (latin/digit runs whole, CJK per run), fillers dropped. */
function valueTokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9._+-]*|[一-鿿]+/g) ?? []).filter((t) => !VALUE_FILLER.has(t)));
}

/**
 * Do two claim values actually disagree? (audit #7, refined)
 *
 * The first cut compared raw strings, so a dropped connective ("uses github
 * actions **and** caches node_modules" vs "…uses github actions caches
 * node_modules") read as a value flip and manufactured CONTRADICTED verdicts
 * on ordinary paraphrase (caught by memory.test's supported-claim case).
 * Comparison is now token-based, mirrored on the scope-premise rule: one side
 * containing the other is a refinement (`postgres` vs `postgres 15`), and
 * values sharing half their terms or more are restatements, not disagreements.
 * Only a real clash (postgres vs mysql, slow vs fast) fires.
 */
function valueClash(a: string, b: string): boolean {
  if (a === b) return false;
  const sa = valueTokens(a);
  const sb = valueTokens(b);
  if (sa.size === 0 || sb.size === 0) return false; // nothing to compare
  const smaller = sa.size <= sb.size ? sa : sb;
  const larger = smaller === sa ? sb : sa;
  if ([...smaller].every((t) => larger.has(t))) return false; // containment = refinement
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union > 0 && inter / union < 0.5;
}

function rowToMemory(row: MemoryRow, withEmbedding: boolean): StoredMemory {
  return {
    id: row.id,
    version: row.version,
    kind: row.kind,
    summary: row.summary,
    detail: row.detail ?? undefined,
    episode:
      row.episode_place || row.episode_time || row.participants_json
        ? {
            time: row.episode_time ?? undefined,
            place: row.episode_place ?? undefined,
            participants: row.participants_json ? (JSON.parse(row.participants_json) as string[]) : undefined
          }
        : undefined,
    semantic: row.rule ? { rule: row.rule } : undefined,
    entities: JSON.parse(row.entities_json) as string[],
    tags: JSON.parse(row.tags_json) as string[],
    occurredAt: row.occurred_at ?? undefined,
    source: row.source ?? undefined,
    verify: row.verify_json ? (JSON.parse(row.verify_json) as { cmd?: string; expect?: string; artifact?: string }) : undefined,
    verifyResult: row.verify_result === 'pass' || row.verify_result === 'fail' ? row.verify_result : undefined,
    verifyAttested: row.verify_attested === 1 ? true : undefined,
    verifiedAt: row.verified_at ?? undefined,
    scope: row.scope ?? undefined,
    retracts: row.retracts ?? undefined,
    guard: row.guard_json ? (JSON.parse(row.guard_json) as { trigger: string; action: string }) : undefined,
    demoted: row.demoted === 1,
    demotedTo: row.demoted_to ?? undefined,
    confidence: row.confidence,
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessAt: row.last_access_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    superseded: row.superseded === 1,
    supersededBy: row.superseded_by ?? undefined,
    embedding: withEmbedding ? (vecFromBlob(row.vec) ?? undefined) : undefined
  };
}

// `no(?!-)` so hyphenated compounds ("no-code", "no-op") are not read as a
// negation. `错误\d+` requires a digit: a bare "错误处理" (error handling) is a
// topic, not a correction — only markers like "错误1" / "错误2" count.
const NEGATION_RE = /\b(not|never|no longer|doesn'?t|isn'?t|aren'?t|no(?!-)|none|dislike|reject|deny|stopped|quit)\b|[不没未非](?![a-z0-9])|((?:与|和|跟|同)[^，。,]{0,12}(?:无关|无涉|独立|不同))|(?:推翻|否证|改口)(?:了|为)?|(?:否定|排除|更正)(?:了|为|:|：)|(错误\d+)/i;

export class HippoMemory {
  readonly db: SqliteStore;
  readonly options: Required<StoreOptions>;
  private embedder: EmbeddingProvider | null = null;
  /** Store file path (exposed via diagnostics for observability). */
  private readonly dbPath: string;
  /**
   * How often the working-memory gate stayed quiet. Counted in memory, per
   * process: a persisted counter would read like history, and the question it
   * answers ("did recall fire on this session?") is about the live process.
   */
  private readonly digestCoverage = { turns: 0, misses: 0, guesses: 0 };
  /** LLM consolidation hook (audit #4); template path is the fallback. */
  private summarizer: Summarizer | null = null;

  /**
   * @param opts.createFile  false = open lazily: a store whose file does not
   *                         exist yet is held in memory until the first write
   *                         (default true, the historical eager behaviour).
   * @param opts.summarizer  LLM abstraction hook used by consolidate()
   *                         (falls back to the FACT:-template on absence or
   *                         error — consolidation never fails the store).
   */
  constructor(opts: { dbPath: string; options?: StoreOptions; createFile?: boolean; summarizer?: Summarizer }) {
    this.db = new SqliteStore(opts.dbPath, { create: opts.createFile !== false });
    this.options = { ...DEFAULT_OPTIONS, ...opts.options };
    this.dbPath = opts.dbPath;
    this.summarizer = opts.summarizer ?? null;
  }

  /** Attach (or replace) a real embedding provider. */
  setEmbedder(e: EmbeddingProvider): void {
    this.embedder = e;
  }

  /** Attach (or replace) the LLM consolidation hook. */
  setSummarizer(s: Summarizer | null): void {
    this.summarizer = s;
  }

  /**
   * One-shot migration to the attached embedder. Uses a persisted marker
   * (PRAGMA user_version) so it runs at most once per store: re-embeds every
   * active row with the current embedder and records the migration.
   * @returns number of rows re-embedded (0 = nothing to do / already done).
   */
  async ensureEmbeddingMigration(): Promise<number> {
    if (!this.embedder) return 0;
    if (this.db.marker() >= 1) return 0;
    const rows = this.db.allActive();
    if (rows.length === 0) {
      // Nothing to migrate. Skip the marker write for a store that has not
      // materialized yet — writing it would create an empty file on disk,
      // which is exactly what lazy opening exists to avoid. A later real
      // write re-runs this check and records the marker then.
      if (!this.db.isLazy()) this.db.setMarker(1);
      return 0;
    }
    const texts = rows.map((r) => {
      const entities = JSON.parse(r.entities_json || '[]') as string[];
      const guardBits: string[] = [];
      try {
        const g = r.guard_json ? (JSON.parse(r.guard_json) as { trigger?: string; action?: string }) : null;
        if (g?.trigger) guardBits.push(g.trigger);
        if (g?.action) guardBits.push(g.action);
      } catch {
        /* malformed guard JSON embeds as empty */
      }
      return [r.summary, r.detail ?? '', r.episode_place ?? '', r.rule ?? '', ...guardBits, r.scope ?? '', ...entities].join('\n');
    });
    const vecs = await this.embedder.embed(texts);
    const now = nowIso();
    let n = 0;
    for (let i = 0; i < rows.length; i++) {
      const v = vecs[i];
      const row = rows[i];
      if (!v || v.length === 0 || !row) continue;
      this.db.update({
        id: row.id,
        version: row.version,
        kind: row.kind,
        summary: row.summary,
        detail: row.detail,
        episode_time: row.episode_time,
        episode_place: row.episode_place,
        participants_json: row.participants_json,
        rule: row.rule,
        entities_json: row.entities_json,
        tags_json: row.tags_json,
        occurred_at: row.occurred_at,
        source: row.source,
        verify_json: row.verify_json,
        verify_result: row.verify_result,
        verified_at: row.verified_at,
        verify_attested: row.verify_attested ?? 0,
        retracts: row.retracts,
        guard_json: row.guard_json,
        scope: row.scope ?? null,
        demoted: row.demoted,
        demoted_to: row.demoted_to,
        demoted_at: row.demoted_at,
        confidence: row.confidence,
        importance: row.importance,
        access_count: row.access_count,
        last_access_at: row.last_access_at,
        created_at: row.created_at,
        updated_at: now,
        superseded: row.superseded,
        superseded_by: row.superseded_by,
        vec: vecToBlob(v)
      });
      n++;
    }
    this.db.setMarker(1);
    return n;
  }

  get embedDim(): number {
    return this.embedder?.dim ?? 512;
  }

  private async embedOne(text: string): Promise<number[]> {
    if (this.embedder) {
      try {
        const [v] = await this.embedder.embed([text]);
        if (v && v.length > 0) return v;
      } catch {
        /* fall through to the local encoder */
      }
    }
    return embedHashing(text);
  }

  /** Same-event test used by conflict resolution (a 1 h window). */
  private sameEventWindowMs(payload: MemoryPayload, row: MemoryRow): boolean {
    const a = payload.occurredAt;
    const b = row.occurred_at;
    if (!a || !b) return true; // unstated time ⇒ assume the current report
    return Math.abs(Date.parse(a) - Date.parse(b)) <= 60 * 60 * 1000;
  }

  private entityNames(p: MemoryPayload): string[] {
    // Tolerant of plain strings (direct-DB callers) as well as EntityRef
    // objects (the documented contract, what the adapter sends) — update()
    // already normalises both shapes, the write path should not TypeError.
    const names = (p.entities ?? [])
      .map((e) => (typeof e === 'string' ? e : e.name).trim())
      .filter(Boolean);
    return Array.from(new Set(names.map((n) => n.toLowerCase())));
  }

  /* ============================ write path ============================ */

  /**
   * Hippocampal write. Resolution order:
   *   1. near-duplicate of the same kind        → strengthen (no new trace)
   *   2. cross-kind verbatim restatement        → merge into the semantic
   *      (ONLY when an episode restates a semantic rule with nothing new:
   *      same normalized body after stripping the consolidation "FACT: "
   *      wrapper, same verbatim detail, same entity set; kind pair
   *      episode→semantic. No cosine gate — exact identity outranks any
   *      similarity score. Same-kind restatements rehearse via branch 1
   *      instead; same-subject value changes override via branch 0/3 — merge
   *      never fires for those shapes.)
   *   3. near-contradiction on the same event/entity scope (same kind)
   *                                            → versioned override (archive old)
   *   4. otherwise                             → new sparse trace
   */
  async remember(payload: MemoryPayload): Promise<{
    outcome: ConflictOutcome;
    memory: StoredMemory;
    superseded?: { id: string; version: number; summary: string };
    /** Explicit supersedes edges applied by this write (id + what it said). */
    superseded_traces?: { id: string; summary: string }[];
    /**
     * Rows that matched this write's structured-claim subject key but share
     * no entity, so they were NOT overwritten. Reported instead of silently
     * retired (field report BUG-1: unrelated memories were being replaced).
     *
     * Scope note (field report BUG-D): this is NOT "all blocked
     * candidates" — only same-subject-key rows stopped by the entity gate.
     * Unstructured summaries have no subject key, so this is empty for them
     * even when neighbours exist. Always present (possibly empty) on every
     * outcome; an empty array means "the gate had nothing to report", not
     * "the gate did not run".
     */
    scope_only_matches?: { id: string; summary: string; similarity: number; reason: string }[];
    /** Human-readable notice when this write retired an existing trace. */
    warning?: string;
    /** Top nearest neighbours of the written content (echoed for the caller). */
    neighbours?: WriteNeighbour[];
    /** True when a neighbour plausibly asserts the opposite of this write. */
    suspected_conflict?: boolean;
  }> {
    const summary = payload.summary.trim();
    if (!summary) throw new Error('remember: summary is required');

    const entities = this.entityNames(payload);
    const tags = Array.from(new Set((payload.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)));
    const isRetraction = tags.includes('retraction');
    // Evidence downgrade (suggestion 1, narrowed per R29): a numeric claim in
    // ASSERTION shape (arrow or copula — "X -> 1.5", "cache is 512 MB")
    // is stored as a semantic rule regardless of verification status. The
    // verification status affects rendering (e.g. [VERIFIED] vs [ASSERTED])
    // and the strength of the retirement shield, but does NOT prevent the
    // row from being corrected by a newer value for the same subject.
    // Bare prose that merely mentions numbers ("release 2.1 shipped
    // Tuesday") is NOT a value assertion and keeps its declared kind.
    let kind = payload.kind;
    let downgraded: string | undefined;
    if (kind === 'semantic' && /\d/.test(summary) && claimParts(summary)) {
      // Keep semantic regardless of verifyResult — do not let self-reported
      // "pass" prevent a later correction from overriding this value.
    }
    const guard = payload.guard && payload.guard.trigger?.trim() && payload.guard.action?.trim()
      ? { trigger: payload.guard.trigger.trim(), action: payload.guard.action.trim() }
      : undefined;
    // Stated premises (see MemoryPayload.scope). Part of the encoding, so a
    // premise-aware query finds the row, and it gates the merge/override
    // branches so a same-sentence write under another premise is not folded
    // into the old one.
    const scope = typeof payload.scope === 'string' && payload.scope.trim() ? payload.scope.trim() : undefined;
    const contentText = [
      summary, payload.detail ?? '', payload.episode?.place ?? '', payload.episode?.time ?? '',
      payload.semantic?.rule ?? '', ...(guard ? [guard.trigger, guard.action] : []), ...(scope ? [scope] : []), ...entities
    ].join('\n');
    const vec = await this.embedOne(contentText);
    // Range priors (suggestion 3): warn-only, never block.
    const rangeNotes = rangeCheck(summary);
    // Advisory notes ride along on every outcome (downgrade, range); an
    // explicit override/blocked warning stays first when present.
    const pendingNotes: string[] = [];
    if (downgraded) pendingNotes.push(downgraded);
    for (const n of rangeNotes) pendingNotes.push(n);
    // Guard/tag consistency (R30 suggestion 6): the [GUARD] rendering and
    // trigger recall both need the guard OBJECT, not just the tag — a bare
    // tag looks configured while doing nothing. Either direction warns.
    if (tags.includes('guard') && !guard) {
      pendingNotes.push('guard-note: tags ["guard"] without guard_trigger/guard_action does nothing — pass both fields or drop the tag');
    }
    if (guard && !tags.includes('guard')) {
      pendingNotes.push('guard-note: guard_trigger/guard_action without tags ["guard"] will not boost or render [GUARD] — add the tag');
    }
    const withNotes = (...explicits: Array<string | undefined>): string | undefined => {
      const all = [...explicits.filter((e): e is string => !!e), ...pendingNotes];
      return all.length ? all.join(' ') : undefined;
    };
    // Evidence shield (suggestion 2): set when an unverified write meets a
    // VERIFIED incumbent — the write is kept as its own trace, never an
    // override. Explicit `supersedes` (fast path above) still states intent.
    let shielded: string | undefined;

    const confidence = payload.confidence ?? 'high';
    const importance = clamp01(payload.importance ?? importanceFromConfidence(confidence));
    const now = nowIso();
    const nowMs = Date.parse(now);
    // Freshness stamp (保鲜期): passing evidence reported without a time is
    // taken as "just run" — the report arrives with the write. An explicit
    // old stamp keeps its age (and goes stale past the TTL).
    const verifiedAt = payload.verifyResult === 'pass' ? (payload.verifiedAt ?? now) : payload.verifiedAt;

    // ---- pattern separation: scan existing traces ----
    // Demoted rows are folded detail: invisible to write-path decisions
    // (no rehearse/merge/override against them) unless explicitly named.
    const candidates = this.db
      .allActive()
      .filter((r) => r.demoted !== 1)
      .map((r) => {
        const b = vecFromBlob(r.vec);
        return { r, sim: b && b.length === vec.length ? cosine(b, vec) : 0 };
      });

    const sameKind = candidates.filter((x) => x.r.kind === kind).sort((a, b) => b.sim - a.sim);
    const closest = sameKind[0];

    // P0-2: echo the top-3 nearest neighbours back to the caller. The scan
    // already computes these similarities; returning them costs nothing and
    // closes the "wrote a correction, never saw the old trace" blind spot.
    const newNegated = this.polarityOf(summary);
    const newClaim = claimParts(summary);
    // Rows that matched the structured-claim subject key but share no entity:
    // reported back, never overwritten (see the scope guard at branch 0).
    const scopeOnlyMatches: { id: string; summary: string; similarity: number; reason: string }[] = [];
    // Premise clash (scope field): rows this write must NOT fold into, because
    // they state a different condition under a key both sides name. Collecting
    // them keeps the skip visible instead of silent (same rule as the entity
    // gate above).
    const premiseClash = (rowScope: string | null | undefined): string[] => scopeDifferences(scope, rowScope);
    const premiseSkipped: { id: string; summary: string; keys: string[] }[] = [];
    const notePremiseSkip = (r: MemoryRow, keys: string[]): void => {
      // Several write branches can reject the same incumbent in one pass (a
      // structured claim fails the entity gate, then the verbatim scan sees the
      // same row). Naming it twice would read as two blocked rows.
      const seen = premiseSkipped.find((p) => p.id === r.id);
      if (seen) seen.keys = Array.from(new Set([...seen.keys, ...keys]));
      else premiseSkipped.push({ id: r.id, summary: sanitizeMemoryText(r.summary).slice(0, 60), keys });
    };
    // A re-tell that supplies the premise the incumbent never stated fills it
    // in; one that states nothing leaves the recorded premise alone (a
    // premise-free echo must not erase what a row holds "under").
    const premiseFill = (r: MemoryRow): { scope?: string } => (!r.scope && scope ? { scope } : {});
    const neighbours: WriteNeighbour[] = candidates
      .slice()
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 3)
      .map(({ r, sim }) => {
        // Conflict suspicion is deliberately WIDE — three triggers, any one
        // suffices (field feedback: the polarity-only check fired only when
        // entities happened to match AND negation wording was used):
        //   (1) opposite polarity on a similar-enough neighbour
        //   (2) the neighbour shares an entity with this write (same scope)
        //   (3) structured "<subject> -> value" with the SAME subject
        //       (a value flip on a known subject — the strongest signal)
        // A false positive costs one review glance; a false negative costs a
        // stale "fact" being asserted forever. Asymmetry favours flagging.
        // Rehearsal guard: a neighbour that says the SAME thing (identical
        // normalized text, or same structured claim with the same value) is
        // not a conflict. Without this the entity channel would flag every
        // benign re-tell of a fact that shares an entity.
        const rClaim = claimParts(r.summary);
        const isRehearsal =
          normalizeText(stripAbstractPrefix(r.summary)) === normalizeText(stripAbstractPrefix(summary)) ||
          !!(newClaim && rClaim && rClaim.subject === newClaim.subject && rClaim.value === newClaim.value);
        const sameSubject = !!(newClaim && rClaim && rClaim.subject === newClaim.subject && rClaim.value !== newClaim.value);
        const sharedEntity = entities.length > 0 && this.entitiesOverlap(entities, JSON.parse(r.entities_json || '[]') as string[]);
        return {
          id: r.id,
          kind: r.kind,
          summary: sanitizeMemoryText(r.summary),
          confidence: r.confidence,
          version: r.version,
          updatedAt: r.updated_at,
          similarity: sim,
          suspectedConflict:
            !isRehearsal &&
            ((sim >= this.options.similarityThreshold && this.polarityOf(r.summary) !== newNegated) ||
              (sim >= this.options.similarityThreshold && sharedEntity) ||
              sameSubject)
        };
      });
    const suspectedConflict = neighbours.some((n) => n.suspectedConflict);

    // Explicit supersedes edges come FIRST: when the caller names the rows this
    // write retires, we never route into override/merge — the new trace is the
    // point, and the named rows get superseded_by pointers to it. (Otherwise a
    // same-subject arrow claim would be eaten by the override branch before
    // the explicit edges were ever applied — observed in the P0-1 test.)
    const supersedesIds = (payload.supersedes ?? []).map((x) => x.trim()).filter(Boolean);
    if (supersedesIds.length > 0) {
      const id = randomUUID();
      const row = this.buildRow({
        id,
        version: 1,
        kind,
        summary,
        detail: payload.detail,
        episode: payload.episode,
        semantic: payload.semantic,
        entities,
        tags,
        occurredAt: payload.occurredAt ?? (kind === 'episode' ? now : undefined),
        source: payload.source,
        verify: payload.verify,
        verifyResult: payload.verifyResult,
        verifyAttested: payload.verifyAttested,
        verifiedAt: verifiedAt,
        retracts: payload.retracts,
        guard,
        scope,
        confidence,
        importance,
        createdAt: now,
        updatedAt: now,
        vec
      });
      this.db.transaction(() => {
        this.db.insert(row);
        for (const sid of supersedesIds) {
          const t = this.db.getById(sid);
          if (!t || t.superseded === 1) continue;
          this.db.setSuperseded(sid, id);
        }
      });
      const supersededTraces = supersedesIds
        .map((sid) => this.db.getById(sid))
        .filter((t): t is MemoryRow => !!t && t.superseded === 1)
        .map((t) => ({ id: t.id, summary: sanitizeMemoryText(t.summary) }));
      return {
        outcome: 'supersede',
        memory: rowToMemory(row, false),
        superseded_traces: supersededTraces,
        neighbours,
        scope_only_matches: scopeOnlyMatches,
        ...(withNotes() ? { warning: withNotes() as string } : {}),
        ...(suspectedConflict ? { suspected_conflict: true } : {})
      };
    }

    // 0. structured claim ("<subject> -> <value>") → attribute binding.
    //    The same subject is ONE engram: same value = rehearsal; a different
    //    value = correction (reconsolidation → versioned override).
    //
    //    Scope guard (field report BUG-1): a subject match alone MUST NOT
    //    authorise an overwrite. `claimParts` derives a "subject" from ordinary
    //    prose too ("the meeting room booking is handled two days ahead" →
    //    subject "the meeting room booking"), so two unrelated sentences that
    //    share a noun phrase produce the same key. Without a scope check this
    //    branch silently retired unrelated memories at ANY cosine — including
    //    pairs the 0.86 contradiction bar would have rejected (reported at
    //    0.783/0.843) — and the only trace was the returned `superseded` field.
    //    Now an overwrite additionally requires shared entities, or an explicit
    //    `supersedes` list (handled in the fast path above, which states intent
    //    outright). Otherwise the write is a NEW trace and the overlap is
    //    reported as a near-duplicate instead of destroying anything.
    //
    //    Known ceiling: rows that declare no entities cannot match on scope, so
    //    a value flip between two entity-less rows stays a new trace (with a
    //    `not-overridden:` warning, field report STAR — the silence was the
    //    bug, not the gate). The gate itself is deliberate (BUG-1 (b)): "no
    //    entities declared" must never count as shared scope.
    if (newClaim && !isRetraction) {
      for (const { r } of sameKind) {
        // Retraction rows are markers, never override incumbents.
        if (isRetractionRow(r)) continue;
        const oldClaim = claimParts(r.summary);
        if (!oldClaim || oldClaim.subject !== newClaim.subject) continue;
        const clash = premiseClash(r.scope);
        if (clash.length) {
          notePremiseSkip(r, clash);
          continue;
        }
        const rowEntities = JSON.parse(r.entities_json || '[]') as string[];
        const scopeOk = entities.length > 0 && rowEntities.length > 0 && this.entitiesOverlap(entities, rowEntities);
        const rowSim = candidates.find((c) => c.r.id === r.id)?.sim ?? 0;
        if (!scopeOk) {
          // Same key, no shared scope: surface it, never overwrite it.
          scopeOnlyMatches.push({
            id: r.id,
            summary: sanitizeMemoryText(r.summary).slice(0, 80),
            similarity: Number(rowSim.toFixed(3)),
            reason: 'same-subject-key, no shared entity'
          });
          continue;
        }
        let trigger: string | null = 'path-0 identical structured subject with shared entities';
        if (oldClaim.value === newClaim.value) {
          // Same value, but a DIFFERENT verbatim detail is new information,
          // not a rehearsal (field report BUG-B: identical summaries with
          // different details collapsed to `none` and the second detail was
          // silently dropped). Fall through so the write becomes its own
          // trace instead of discarding the caller's detail.
          if ((payload.detail ?? '').trim() !== (r.detail ?? '').trim()) continue;
          // Spaced rehearsal: the boost scales with the time since the last
          // access (massed repetition earns little; spaced re-telling more).
          const imp = Math.min(1, r.importance + rehearsalBoost(r.last_access_at, Date.parse(now)));
          // A rehearsal may carry fresh evidence the incumbent lacked ("that
          // value I logged — I just re-ran the check, it passes"). Keep the row
          // but land the evidence, or a later verify reads it as unverified.
          // Upgrade only: a bare re-tell never erases a result already on file.
          const carryVerify =
            payload.verifyResult !== undefined
              ? {
                  verify_result: payload.verifyResult,
                  verified_at: payload.verifiedAt ?? (payload.verifyResult === 'pass' ? now : r.verified_at),
                  verify_json: payload.verify !== undefined ? JSON.stringify(payload.verify) : r.verify_json,
                  verify_attested:
                    payload.verifyAttested !== undefined ? (payload.verifyAttested ? 1 : 0) : (r.verify_attested ?? 0)
                }
              : {};
          this.db.update({ ...r, ...premiseFill(r), ...carryVerify, importance: imp, updated_at: now });
          return {
            outcome: 'none',
            memory: rowToMemory(this.db.getById(r.id)!, false),
            neighbours,
            scope_only_matches: scopeOnlyMatches,
            ...(suspectedConflict ? { suspected_conflict: true } : {})
          };
        }
        // Distinct real-world events on the same subject (e.g. a key rotated
        // on two different days) stay separate — only semantic/procedure
        // claims and same-event episodes get overridden.
        const windowOk = r.kind === 'semantic' || r.kind === 'procedure' || this.sameEventWindowMs(payload, r);
        if (!windowOk) continue;
        // Evidence shield (suggestion 2 + 保鲜期 + audit #5): a freshly
        // VERIFIED incumbent is retired only by a challenger that also passes
        // evidence — and only ATTESTED evidence earns the full shield. A
        // self-reported pass (agent asserted, never re-runnable) degrades to
        // a visible warning: it must not guard data against a correction.
        // Stale evidence (past TTL or unstamped) no longer shields.
        const standing = evidenceStanding(r, nowMs, this.options.evidenceTtlSec);
        if (standing !== 'none' && payload.verifyResult !== 'pass') {
          if (standing === 'attested') {
            shielded =
              `shielded: existing VERIFIED row ${r.id.slice(0, 8)} (v${r.version}) — "` +
              `${sanitizeMemoryText(r.summary).slice(0, 60)}" was NOT retired by this unverified write; both rows are kept. ` +
              `To replace it, re-run its evidence and pass verifyResult:'pass' (or supersedes:[id] to force).`;
            break;
          }
          // self-reported: keep the write, warn that the badge is hearsay.
          pendingNotes.push(
            `shield-note: incumbent ${r.id.slice(0, 8)} (v${r.version}) carries SELF-REPORTED evidence (never re-run by the engine) — ` +
            `its retirement shield is degraded; the override proceeds, and the old revision stays in history. ` +
            `Pass verifyAttested:true only when the check was actually executed in a reproducible environment.`
          );
        }
        const prior = { id: r.id, version: r.version, summary: r.summary };
        const res = await this.update(r.id, {
          summary,
          detail: payload.detail,
          episode: payload.episode,
          semantic: payload.semantic,
          entities: payload.entities,
          tags: payload.tags,
          occurredAt: payload.occurredAt,
          source: payload.source,
          verify: payload.verify,
          verifyResult: payload.verifyResult,
          verifiedAt: verifiedAt,
          retracts: payload.retracts,
          guard,
          scope,
          confidence
        });
        return {
          outcome: 'override',
          memory: res.memory,
          superseded: prior,
          neighbours,
          scope_only_matches: scopeOnlyMatches,
          warning: withNotes(
            `override: this write retired ${prior.id.slice(0, 8)} (v${prior.version}) — "` +
            `${sanitizeMemoryText(prior.summary).slice(0, 70)}". Trigger: ${trigger}. ` +
            `Recover it via memory_maintain history ${prior.id}, or pass supersedes next time to make the intent explicit.`
          ) as string,
          ...(suspectedConflict ? { suspected_conflict: true } : {})
        };
      }
    }

    // 1. verbatim re-tell of the same claim → rehearsal, strengthen only
    //    (compare with the wrapper stripped so "FACT: X" counts as a re-tell of X)
    //    The detail is part of the claim: an identical summary carrying a
    //    different verbatim detail is NOT a re-tell (field report BUG-B) —
    //    collapsing it to `none` silently discards the new detail.
    const isRetell =
      closest !== undefined &&
      normalizeText(stripAbstractPrefix(closest.r.summary)) === normalizeText(stripAbstractPrefix(summary)) &&
      (payload.detail ?? '').trim() === (closest.r.detail ?? '').trim();
    const closestClash = premiseClash(closest?.r.scope);
    if (closest && isRetell && closestClash.length > 0) {
      notePremiseSkip(closest.r, closestClash);
    }
    if (closest && isRetell && closestClash.length === 0) {
      const imp = Math.min(1, closest.r.importance + rehearsalBoost(closest.r.last_access_at, Date.parse(now)));
      // A re-tell may carry fresh evidence the incumbent lacked ("this fact I
      // logged earlier — I just ran the check and it passes"). Rehearsal keeps
      // the row, but the evidence must land, or a later verify reads the row as
      // unverified. Only upgrade: never let a bare re-tell erase a passing
      // result already on the row.
      const carryVerify =
        payload.verifyResult !== undefined
          ? {
              verify_result: payload.verifyResult,
              verified_at: payload.verifiedAt ?? (payload.verifyResult === 'pass' ? now : closest.r.verified_at),
              verify_json: payload.verify !== undefined ? JSON.stringify(payload.verify) : closest.r.verify_json,
              verify_attested:
                payload.verifyAttested !== undefined ? (payload.verifyAttested ? 1 : 0) : (closest.r.verify_attested ?? 0)
            }
          : {};
      this.db.update({ ...closest.r, ...premiseFill(closest.r), ...carryVerify, importance: imp, updated_at: now });
      return {
        outcome: 'none',
        memory: rowToMemory(this.db.getById(closest.r.id)!, false),
        neighbours,
        scope_only_matches: scopeOnlyMatches,
        ...(withNotes() ? { warning: withNotes() as string } : {}),
        ...(suspectedConflict ? { suspected_conflict: true } : {})
      };
    }

    // 2. cross-kind merge: an episodic re-tell of an existing semantic rule.
    //    Compare with the consolidation wrapper stripped: consolidation writes
    //    the episode as "FACT: <same text>", so a raw comparison would miss the
    //    twin and let a duplicate accumulate (observed: 17 such pairs).
    //
    //    Identity gate (field probe G5b): body + verbatim detail + entity set
    //    must ALL match — and deliberately NO cosine gate. An exact identity
    //    match is stronger evidence than any cosine; the old sim >= 0.92 gate
    //    made this branch embedder-fragile (metadata such as a differing
    //    detail/FACT: wrapper drags contentText cosine below the bar, so
    //    identical twins merged or not depending on the embedder). A differing
    //    detail or entity set means the episode carries its own information
    //    and must survive as its own trace (same lesson as BUG-B).
    //
    //    Retractions never merge (markers stay addressable on their own).
    if (kind === 'episode' && !isRetraction) {
      const newBody = normalizeText(stripAbstractPrefix(summary));
      const newDetail = (payload.detail ?? '').trim();
      const newEnts = new Set(entities.map((e) => e.toLowerCase()));
      const nearSemantic = candidates.find((x) => {
        if (x.r.kind !== 'semantic') return false;
        if (premiseClash(x.r.scope).length > 0) return false;
        if (normalizeText(stripAbstractPrefix(x.r.summary)) !== newBody) return false;
        if (((x.r.detail ?? '') as string).trim() !== newDetail) return false;
        const rowEnts = JSON.parse(x.r.entities_json || '[]') as string[];
        return rowEnts.length === entities.length && rowEnts.every((e) => newEnts.has(e.toLowerCase()));
      });
      if (nearSemantic) {
        const imp = Math.min(1, nearSemantic.r.importance + 0.01 + rehearsalBoost(nearSemantic.r.last_access_at, Date.parse(now)));
        this.db.update({ ...nearSemantic.r, ...premiseFill(nearSemantic.r), importance: imp, updated_at: now });
        return {
          outcome: 'merge',
          memory: rowToMemory(this.db.getById(nearSemantic.r.id)!, false),
          neighbours,
          scope_only_matches: scopeOnlyMatches,
          ...(withNotes() ? { warning: withNotes() as string } : {}),
          ...(suspectedConflict ? { suspected_conflict: true } : {})
        };
      }
    }

    // 3. near-contradiction on the same event/scope → versioned override.
    //    (Human analog: reconsolidation — the old trace is archived, not erased.)
    //
    //    Scope must be an actual INTERSECTION (field report BUG-1 (b)): the
    //    previous form was `entities.length === 0 || closest.r.entities_json
    //    === '[]' || overlap`, i.e. "no entities declared" counted as "shares
    //    scope", so two entity-less rows could overwrite each other purely on
    //    cosine. Cosine alone cannot establish shared scope — a high-frequency
    //    domain term inflates similarity between unrelated rows.
    const closestEntities = closest ? (JSON.parse(closest.r.entities_json || '[]') as string[]) : [];
    const sharesScope =
      closest !== undefined && entities.length > 0 && closestEntities.length > 0 && this.entitiesOverlap(entities, closestEntities);
    // Disagreement evidence (field report, BUG-1 recurrence): cosine +
    // shared-entity alone still fires on unrelated rows that share domain
    // jargon ("byte 0 = X" vs "bytes 2-5 = AD" measured 0.88 under bge).
    // Require the same structured-claim subject (a value flip on one
    // attribute) or opposite polarity. Otherwise the write becomes a new
    // trace with visible neighbours, and the caller supersedes explicitly.
    const closestClaim = closest ? claimParts(closest.r.summary) : null;
    const sameSubject = !!(newClaim && closestClaim && closestClaim.subject === newClaim.subject);
    const oppositePolarity = closest ? this.polarityOf(closest.r.summary) !== newNegated : false;
    // Path-3 side of the evidence shield (same rule as path-0, audit #5):
    // only ATTESTED fresh evidence blocks; a self-reported pass warns.
    const closestStanding = closest
      ? evidenceStanding(closest.r, nowMs, this.options.evidenceTtlSec)
      : ('none' as const);
    if (
      closest &&
      !isRetell &&
      !isRetraction &&
      !isRetractionRow(closest.r) &&
      !shielded &&
      closestClash.length === 0 &&
      closest.sim >= this.options.contradictionThreshold &&
      sharesScope &&
      (sameSubject || oppositePolarity) &&
      this.sameEventWindowMs(payload, closest.r) &&
      closestStanding !== 'none' &&
      payload.verifyResult !== 'pass'
    ) {
      if (closestStanding === 'attested') {
        shielded =
          `shielded: existing VERIFIED row ${closest.r.id.slice(0, 8)} (v${closest.r.version}) — "` +
          `${sanitizeMemoryText(closest.r.summary).slice(0, 60)}" was NOT retired by this unverified write; both rows are kept. ` +
          `To replace it, re-run its evidence and pass verifyResult:'pass' (or supersedes:[id] to force).`;
      } else {
        pendingNotes.push(
          `shield-note: incumbent ${closest.r.id.slice(0, 8)} (v${closest.r.version}) carries SELF-REPORTED evidence (never re-run by the engine) — ` +
          `its retirement shield is degraded; the override proceeds, and the old revision stays in history. ` +
          `Pass verifyAttested:true only when the check was actually executed in a reproducible environment.`
        );
      }
    }
    // Brink of firing: every structural condition holds. Before retiring,
    // re-measure similarity CLAIM-to-CLAIM (field report R31): the firing
    // sim above is contentText cosine — summary PLUS verbatim detail PLUS
    // entities — and a long shared detail dominates it ("the more detailed
    // the write, the easier a false override": measured 0.8658 content vs
    // 0.6995 summary-only on the same pair). The claims themselves must also
    // clear the bar, or the write is kept as its own trace with a note.
    const brink =
      closest &&
      !isRetell &&
      !isRetraction &&
      !isRetractionRow(closest.r) &&
      !shielded &&
      closestClash.length === 0 &&
      closest.sim >= this.options.contradictionThreshold &&
      sharesScope &&
      (sameSubject || oppositePolarity) &&
      this.sameEventWindowMs(payload, closest.r);
    let claimSim: number | null = null;
    let withheldContradiction: string | undefined;
    if (brink && closest) {
      const qv = await this.embedOne(summary);
      const rv = await this.embedOne(closest.r.summary);
      claimSim = qv.length > 0 && qv.length === rv.length ? cosine(qv, rv) : 0;
      if (claimSim < this.options.claimThreshold) {
        withheldContradiction =
          `withheld-contradiction: content-sim ${closest.sim.toFixed(2)} clears ${this.options.contradictionThreshold.toFixed(2)} but claim-sim ` +
          `${claimSim.toFixed(2)} does not clear ${this.options.claimThreshold.toFixed(2)} — shared detail is dominating the match, so this was kept as a new trace. ` +
          `Pass supersedes:[${closest.r.id.slice(0, 8)}…] to force, or restate the claim.`;
      }
    }
    if (brink && closest && claimSim !== null && claimSim >= this.options.claimThreshold) {
      const prior = { id: closest.r.id, version: closest.r.version, summary: closest.r.summary };
      const res = await this.update(closest.r.id, {
        summary,
        detail: payload.detail,
        episode: payload.episode,
        semantic: payload.semantic,
        entities: payload.entities,
        tags: payload.tags,
        occurredAt: payload.occurredAt,
        source: payload.source,
        verify: payload.verify,
        verifyResult: payload.verifyResult,
        verifiedAt: verifiedAt,
        retracts: payload.retracts,
        guard,
        scope,
        confidence
      });
      return {
        outcome: 'override',
        memory: res.memory,
        superseded: prior,
        neighbours,
        scope_only_matches: scopeOnlyMatches,
        // Overwriting is destructive to the caller's intent when unrequested, so
        // it is never silent: name what was retired (field report BUG-1 (c)),
        // and print BOTH similarity calibres (R31 suggestion 8) so a reader
        // can see whether shared detail carried the match over the bar.
        warning: withNotes(
          `override: this write retired ${prior.id.slice(0, 8)} (v${prior.version}) — "` +
          `${sanitizeMemoryText(prior.summary).slice(0, 70)}". Trigger: path-3 content-sim ${closest.sim.toFixed(2)} + claim-sim ${(claimSim as number).toFixed(2)} with shared entities and ${sameSubject ? 'identical structured subject' : 'opposite polarity'}. ` +
          `Recover it via memory_maintain history ${prior.id}, or pass supersedes next time to make the intent explicit.`
        ) as string,
        ...(suspectedConflict ? { suspected_conflict: true } : {})
      };
    }

    // 4. new trace (explicit supersedes edges were applied in the fast path above;
    //    an evidence-shielded write also lands here, next to its VERIFIED incumbent)
    const id = randomUUID();
    const row = this.buildRow({
      id,
      version: 1,
      kind,
      summary,
      detail: payload.detail,
      episode: payload.episode,
      semantic: payload.semantic,
      entities,
      tags,
      occurredAt: payload.occurredAt ?? (kind === 'episode' ? now : undefined),
      source: payload.source,
      verify: payload.verify,
      verifyResult: payload.verifyResult,
      verifyAttested: payload.verifyAttested,
      verifiedAt: verifiedAt,
      retracts: payload.retracts,
      guard,
      scope,
      confidence,
      importance,
      createdAt: now,
      updatedAt: now,
      vec
    });
    this.db.insert(row);
    // A withheld update is never silent either (field report STAR): when the
    // entity gate stopped an overwrite, say so and how to authorise it.
    const blockedWarning =
      scopeOnlyMatches.length > 0
        ? `not-overridden: ${scopeOnlyMatches.length} same-subject row(s) share no entity with this write, so nothing was retired ` +
          `(${scopeOnlyMatches.map((m) => `${m.id.slice(0, 8)} "${m.summary.slice(0, 50)}"`).join('; ')}). ` +
          `To update one, declare its entities on your next write or pass supersedes:[id].`
        : undefined;
    // Premise clash: two statements that hold under different conditions are
    // two traces. Say why the near-identical incumbent was not reused, or the
    // caller reads a separate row as a failed update.
    const premiseWarning =
      premiseSkipped.length > 0
        ? `different-scope: kept as its own trace — ${premiseSkipped.length} row(s) state another premise under ` +
          `the key(s) ${Array.from(new Set(premiseSkipped.flatMap((p) => p.keys))).join(', ')} ` +
          `(${premiseSkipped.map((p) => `${p.id.slice(0, 8)} "${p.summary}"`).join('; ')}). ` +
          `The same sentence under a different condition is not a re-tell; pass the same scope to rehearse, or supersedes:[id] to retire it.`
        : undefined;
    const notesWarning = withNotes(shielded, blockedWarning, withheldContradiction, premiseWarning);
    return {
      outcome: 'new',
      memory: rowToMemory(row, false),
      neighbours,
      scope_only_matches: scopeOnlyMatches,
      ...(notesWarning ? { warning: notesWarning } : {}),
      ...(suspectedConflict ? { suspected_conflict: true } : {})
    };
  }

  /** Update a memory in place (reconsolidation): archives the old revision. */
  async update(id: string, payload: Partial<MemoryPayload>): Promise<{ memory: StoredMemory; history: number }> {
    const row = this.db.getById(id);
    if (!row) throw new Error(`update: no memory with id ${id}`);
    const existing = rowToMemory(row, false);
    const summary = payload.summary?.trim() ?? existing.summary;
    const contentText = [
      summary,
      payload.detail ?? existing.detail ?? '',
      payload.episode?.place ?? existing.episode?.place ?? '',
      payload.episode?.time ?? existing.episode?.time ?? '',
      payload.semantic?.rule ?? existing.semantic?.rule ?? '',
      payload.scope ?? existing.scope ?? '',
      ...(payload.entities ?? []).map((e) => (typeof e === 'string' ? e : e.name)),
      ...existing.entities
    ].join('\n');
    const vec = await this.embedOne(contentText);

    const now = nowIso();
    return this.db.transaction(() => {
      this.db.archiveCurrent(id, now);
      const nextVersion = existing.version + 1;
      const mergedEntities = Array.from(
        new Set([
          ...(payload.entities ?? []).map((e) => (typeof e === 'string' ? e : e.name).trim().toLowerCase()).filter(Boolean),
          ...existing.entities
        ])
      );
      const mergedTags = Array.from(new Set([...(payload.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean), ...existing.tags]));
      const next: MemoryRow = {
        ...row,
        version: nextVersion,
        kind: payload.kind ?? existing.kind,
        summary,
        detail: payload.detail !== undefined ? payload.detail : row.detail,
        episode_time: payload.episode?.time ?? row.episode_time,
        episode_place: payload.episode?.place ?? row.episode_place,
        participants_json:
          payload.episode?.participants !== undefined ? JSON.stringify(payload.episode.participants) : row.participants_json,
        rule: payload.semantic?.rule ?? row.rule,
        entities_json: JSON.stringify(mergedEntities),
        tags_json: JSON.stringify(mergedTags),
        occurred_at: payload.occurredAt ?? row.occurred_at,
        source: payload.source ?? row.source,
        verify_json: payload.verify !== undefined ? JSON.stringify(payload.verify) : row.verify_json,
        verify_result: payload.verifyResult !== undefined ? payload.verifyResult : row.verify_result,
        verified_at: payload.verifiedAt !== undefined ? payload.verifiedAt : row.verified_at,
        verify_attested: payload.verifyAttested !== undefined ? (payload.verifyAttested ? 1 : 0) : (row.verify_attested ?? 0),
        retracts: payload.retracts !== undefined ? payload.retracts : row.retracts,
        guard_json: payload.guard !== undefined ? JSON.stringify(payload.guard) : row.guard_json,
        scope: payload.scope !== undefined ? (payload.scope?.trim() || null) : row.scope,
        confidence: payload.confidence ?? row.confidence,
        importance: payload.importance !== undefined ? clamp01(payload.importance) : row.importance,
        updated_at: now,
        vec: vecToBlob(vec)
      };
      this.db.update(next);
      this.db.pruneHistory(id, this.options.maxVersionsPerId);
      return { memory: rowToMemory(next, false), history: nextVersion };
    });
  }

  private buildRow(a: {
    id: string;
    version: number;
    kind: MemoryPayload['kind'];
    summary: string;
    detail?: string;
    episode?: MemoryPayload['episode'];
    semantic?: MemoryPayload['semantic'];
    entities: string[];
    tags: string[];
    occurredAt?: string;
    source?: string;
    verify?: MemoryPayload['verify'];
    verifyResult?: MemoryPayload['verifyResult'];
    verifyAttested?: boolean;
    verifiedAt?: string;
    retracts?: string;
    guard?: MemoryPayload['guard'];
    scope?: string;
    confidence: 'high' | 'medium' | 'low' | 'speculative';
    importance: number;
    createdAt: string;
    updatedAt: string;
    vec: number[];
  }): MemoryRow {
    return {
      id: a.id,
      version: a.version,
      kind: a.kind,
      summary: a.summary,
      detail: a.detail ?? null,
      episode_time: a.episode?.time ?? null,
      episode_place: a.episode?.place ?? null,
      participants_json: a.episode?.participants ? JSON.stringify(a.episode.participants) : null,
      rule: a.semantic?.rule ?? null,
      entities_json: JSON.stringify(a.entities),
      tags_json: JSON.stringify(a.tags),
      occurred_at: a.occurredAt ?? null,
      source: a.source ?? null,
      verify_json: a.verify ? JSON.stringify(a.verify) : null,
      verify_result: a.verifyResult ?? null,
      verified_at: a.verifiedAt ?? null,
      verify_attested: a.verifyAttested ? 1 : 0,
      retracts: a.retracts ?? null,
      guard_json: a.guard ? JSON.stringify(a.guard) : null,
      scope: a.scope ?? null,
      demoted: 0,
      demoted_to: null,
      demoted_at: null,
      confidence: a.confidence,
      importance: a.importance,
      access_count: 0,
      last_access_at: null,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
      superseded: 0,
      superseded_by: null,
      vec: vecToBlob(a.vec)
    };
  }

  /* ============================ recall path ============================ */

  /**
   * Cue-driven retrieval (pattern completion). One scan over the active
   * engrams; candidates are ranked by similarity weighted by importance.
   * Every hit keeps its provenance; conflict warnings surface newer revisions
   * of the same scope so the caller does not blindly trust a stale trace.
   */
  async recall(cue: RetrievalCue, limit = 8): Promise<RecallBundle> {
    const q = cue.query.trim();
    // Empty cue (e.g. no user message surfaced yet): pattern completion has
    // nothing to complete — surface the most recently updated traces instead,
    // so auto-digest contexts never render empty during warm-up renders.
    if (!q) {
      const recent = this.db
        .allActive()
        .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
        .slice(0, Math.min(limit, 5));
      return {
        hits: recent.map((r) => ({ ...rowToMemory(r, false), score: 0.5, similarity: 0.5, relativeScore: 1, consolidated: false })),
        warnings: ['empty cue: showing recently updated memories'],
        scanned: 0,
        eligible: recent.length,
        bestSimilarity: null,
        threshold: this.options.similarityThreshold,
        reason: 'empty-cue',
        nearMisses: [],
        nearDuplicates: []
      };
    }

    const cueVec = await this.embedOne(q);
    const minImportance = cue.minImportance ?? this.options.minImportance;
    const minSim = this.options.similarityThreshold;
    const sinceMs = cue.since ? Date.parse(cue.since) : 0;
    const occurredSinceMs = cue.occurredSince ? Date.parse(cue.occurredSince) : 0;
    const exclude = new Set(cue.excludeIds ?? []);
    const entityFilter = (cue.entities ?? []).map((e) => e.toLowerCase());
    const warnings: string[] = [];
    // Hard premise filter (audit #7/#8): rows whose stated scope disagrees
    // with the asked one leave the candidate pool entirely — "conditional on
    // another setup" must not surface as an answer to this question. Rows
    // with no scope pass (absence of a premise is not a contradiction).
    const cueScope = typeof cue.scope === 'string' && cue.scope.trim() ? cue.scope.trim() : undefined;
    let scopeExcluded = 0;

    const rows = this.db.allActive();
    const hits: RetrievedMemory[] = [];
    // Live retraction index (suggestion 4): target id → {by, criterion}, so
    // hits on retracted rows carry the do-not-repeat flag at recall time.
    const retractions = new Map<string, { by: string; criterion: string }>();
    for (const r of rows) {
      if (!isRetractionRow(r) || r.superseded === 1) continue;
      const target = (r.retracts ?? '').trim();
      if (target && !retractions.has(target)) {
        retractions.set(target, { by: r.id, criterion: sanitizeMemoryText(r.detail || r.summary).slice(0, 160) });
      }
    }
    // Candidates that are relevant but fall under the threshold. Kept so an
    // empty result can be explained ("nothing stored" vs "close but too weak")
    // and so weak-but-useful traces can still be surfaced as near misses.
    const below: { mem: StoredMemory; sim: number }[] = [];
    let scanned = 0; // rows whose vector was comparable (dimension match)
    let eligible = 0; // rows passing the cheap structural filters
    let bestSim = -1;

    for (const r of rows) {
      const b = vecFromBlob(r.vec);
      if (!b || b.length !== cueVec.length) continue;
      scanned++;
      const mem = rowToMemory(r, false);
      // Folded detail stays out unless explicitly expanded (S5).
      if (mem.demoted && !cue.includeDemoted) continue;
      if (exclude.has(mem.id)) continue;
      if (cue.kind && mem.kind !== cue.kind) continue;
      if (mem.importance < minImportance) continue;
      if (sinceMs && mem.lastAccessAt && Date.parse(mem.lastAccessAt) < sinceMs) continue;
      if (occurredSinceMs && mem.occurredAt && Date.parse(mem.occurredAt) < occurredSinceMs) continue;
      if (entityFilter.length && !entityFilter.every((e) => mem.entities.includes(e))) continue;
      if (cueScope && mem.scope && scopeDifferences(mem.scope, cueScope).length > 0) {
        scopeExcluded++;
        continue;
      }
      eligible++;

      const sim = cosine(b, cueVec);
      if (sim > bestSim) bestSim = sim;
      // Literal-token rescue: an exact identifier match (0x212aa5, D-387, a
      // commit sha) is decisive evidence that cosine underrates, especially for
      // short CJK queries where embeddings are mushy. Such a row is admitted
      // even below the similarity floor, but is marked so the caller can tell.
      const literal = literalOverlap(q, mem.summary);
      if (sim < minSim && !literal) {
        below.push({ mem, sim });
        continue;
      }
      const retr = retractions.get(mem.id);
      hits.push({
        ...mem,
        score: sim,
        similarity: sim,
        relativeScore: 0,
        literalMatch: literal || undefined,
        consolidated: mem.kind === 'semantic',
        ...(retr ? { retracted: retr } : {})
      });
    }

    // Rank: similarity × (0.6 + 0.4·importance), plus a literal-identifier
    // bonus, plus small priority boosts so "do not repeat this mistake"
    // (retraction targets) and prospective guards surface above background
    // chatter on the same cue. `similarity` stays the raw cosine
    // (threshold- and verify-comparable); bonuses only affect ordering.
    // Ordering uses the unbounded value, then `score` is clamped into [0,1] so
    // a boosted hit never reports a nonsensical "1.03".
    // topK caps the candidate set before re-ranking (its documented job:
    // bound the rank on large stores). Only re-sorts when the cap bites.
    const candidates =
      hits.length > this.options.topK
        ? [...hits].sort((a, b) => b.similarity - a.similarity).slice(0, this.options.topK)
        : hits;
    const ranked = candidates
      .map((h) => ({
        ...h,
        // Rendered summary is sanitized; the stored row itself is untouched.
        summary: sanitizeMemoryText(h.summary),
        score:
          h.score * (0.6 + 0.4 * h.importance) +
          (h.literalMatch ? 0.15 * Math.min(h.literalMatch, 2) : 0) +
          (h.retracted ? 0.2 : 0) +
          (h.tags.includes('guard') ? 0.15 : 0)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((h) => ({ ...h, score: Math.min(1, h.score) }));

    // Relative score: this hit's similarity ÷ the best similarity for THIS
    // query. Cosine is compressed and query-dependent (a 0.45 can be the best
    // match in the store), so the raw number alone reads as "bad". The relative
    // score makes "best available" visible without changing ranking.
    const topSim = ranked.length ? Math.max(...ranked.map((h) => h.similarity)) : 0;
    for (const h of ranked) {
      h.relativeScore = topSim > 0 ? Number((h.similarity / topSim).toFixed(3)) : 0;
    }

    // Near misses: sub-threshold rows, best first, so a caller that got no hits
    // can see WHAT was close and how close (never silently empty again).
    const nearMisses = below
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 3)
      .map((x) => ({ id: x.mem.id, summary: sanitizeMemoryText(x.mem.summary), similarity: Number(x.sim.toFixed(3)) }));

    const reason: RecallBundle['reason'] =
      ranked.length > 0
        ? 'ok'
        : eligible === 0
          ? 'no-candidates' // nothing to search (empty / filtered out)
          : below.length > 0
            ? 'below-threshold' // relevant rows exist but none cleared the floor
            : 'no-candidates';

    // Conflict warnings: ONLY for rows that actually DISAGREE with the top
    // hit on an established scope-key.
    //
    // A conflict needs an intersection of two conditions:
    //   (1) scope-key match — shared entity AND the same structured-claim
    //       subject, or an identical entity set; and
    //   (2) disagreement — opposite polarity, or the same subject bound to a
    //       different value (the arrow form needs no negation: "gateway ->
    //       nginx" vs "gateway -> envoy" disagree without either sentence
    //       being negated).
    //
    // A newer timestamp alone is NOT a conflict — it is a sibling. Everything
    // that is not a conflict goes to nearDuplicates: still visible, but not a
    // warning.
    //
    // Regression history (field report, 3rd round): the previous predicate
    // OR-ed in `m.similarity >= similarityThreshold`, which every hit
    // satisfies by construction (hits are admitted at that floor), so it
    // collapsed to "newer than the top hit" and flagged ~25 traces — the
    // entire result set. Warnings that fire on everything carry no signal and
    // train the caller to ignore them, which is worse than the silent
    // under-reporting it replaced. When in doubt: stay quiet.
    const top = ranked[0];
    const conflicts: RetrievedMemory[] = [];
    const nearDuplicates: { id: string; summary: string; similarity: number; reason: string }[] = [];
    if (top) {
      const topEntities = new Set(top.entities.map((e) => e.toLowerCase()));
      const topClaim = claimParts(top.summary);
      const topPolarity = this.polarityOf(top.summary);
      const topRow = this.db.getById(top.id);
      const topVec = topRow ? vecFromBlob(topRow.vec) : null;
      for (const mRec of hits) {
        if (mRec.id === top.id || mRec.summary === top.summary) continue;
        const mClaim = claimParts(mRec.summary);
        const sharedEntity = mRec.entities.some((e) => topEntities.has(e.toLowerCase()));
        const sameSubject = !!(topClaim && mClaim && mClaim.subject === topClaim.subject);
        const sameEntitySet =
          topEntities.size > 0 &&
          mRec.entities.length === top.entities.length &&
          mRec.entities.every((e) => topEntities.has(e.toLowerCase()));
        const sameScopeKey = (sharedEntity && sameSubject) || sameEntitySet;
        const oppositePolarity = this.polarityOf(mRec.summary) !== topPolarity;
        const valueDisagrees =
          !!topClaim && !!mClaim && mClaim.subject === topClaim.subject && mClaim.value !== topClaim.value;
        if (sameScopeKey && (oppositePolarity || valueDisagrees)) {
          conflicts.push(mRec);
        } else {
          // "Near-duplicate" must mean: this row SAYS THE SAME THING as the top
          // hit. So compare the two ROWS to each other — not each row to the
          // cue. `mRec.similarity` is cosine-to-cue, which measures "both are
          // relevant to the query" (true of every hit, and of near-synonyms
          // with opposite meanings alike). Two rows can sit at 0.85 from the
          // cue while being 0.99 from each other, or vice versa.
          const mRow = this.db.getById(mRec.id);
          const mVec = mRow ? vecFromBlob(mRow.vec) : null;
          const rowSim =
            topVec && mVec && topVec.length === mVec.length ? cosine(topVec, mVec) : 0;
          if (rowSim >= this.options.nearDuplicateThreshold) {
            nearDuplicates.push({
              id: mRec.id,
              summary: sanitizeMemoryText(mRec.summary).slice(0, 80),
              similarity: Number(rowSim.toFixed(3)),
              reason: 'near-duplicate'
            });
          }
        }
      }
      if (conflicts.length) {
        warnings.push(
          `conflict: ${conflicts.length} retrieved trace(s) disagree with the top hit — ${conflicts
            .map((o) => `"${sanitizeMemoryText(o.summary).slice(0, 60)}" (${o.id.slice(0, 8)}, ${o.updatedAt})`)
            .join('; ')}`
        );
      }
    }

    // Low-confidence flag (metacognition): hits the writer itself marked
    // low/speculative AND never backed with passing evidence read as
    // "I think" rather than "I know". Evidence excuses the flag — a checked
    // fact outranks its author's modesty. Warn-only, only when present.
    const unbacked = ranked.filter(
      (h) => (h.confidence === 'low' || h.confidence === 'speculative') && h.verifyResult !== 'pass'
    );
    if (unbacked.length) {
      const levels = Array.from(new Set(unbacked.map((o) => o.confidence))).join('/');
      const ids = unbacked.map((o) => o.id.slice(0, 8)).join(', ');
      warnings.push(
        'low-confidence: ' + unbacked.length + ' retrieved trace(s) were written as ' + levels +
        ' without passing evidence — treat as leads, not facts (' + ids + ')'
      );
    }

    // Infection flag: a hit whose stored text looked instruction-shaped and
    // was sanitized. Visible (not silent) so a maintainer can review the row.
    const infected = ranked.filter((h) => h.summary.includes('[sanitized-'));
    if (infected.length) {
      warnings.push(`injection: ${infected.length} retrieved memory(ies) contained instruction-shaped text and were sanitized — review with memory_maintain list/history (ids: ${infected.map((h) => h.id).join(', ')})`);
    }
    if (cueScope && scopeExcluded > 0) {
      warnings.push(`scope: ${scopeExcluded} row(s) excluded — their stated premise disagrees with "${cueScope.slice(0, 80)}"; recall without scope to see them`);
    }

    // Mark retrieved traces as accessed (usage feedback for consolidation) and
    // apply the spaced-retrieval boost: being genuinely RECALLED after a gap
    // strengthens the trace (testing effect) — passive restatement is the
    // remember() path above, retrieval is here. Cap access_count growth per
    // query at the ranked hits only, so a single recall cannot mass-boost.
    const at = nowIso();
    const nowMs = Date.parse(at);
    for (const h of ranked) {
      const row = this.db.getById(h.id);
      if (!row) continue;
      // Single UPDATE carries access bookkeeping AND the importance bump:
      // two writes would let the second clobber the first (stale snapshot).
      const boost = rehearsalBoost(row.last_access_at, nowMs) * 0.5;
      this.db.update({
        ...row,
        access_count: row.access_count + 1,
        last_access_at: at,
        importance: row.importance < 1 ? Math.min(1, row.importance + boost) : row.importance
      });
    }

    return {
      hits: ranked,
      warnings: ranked.length === 0 && reason === 'below-threshold'
        ? [...warnings, `no hit cleared the similarity floor ${minSim}; closest was ${bestSim.toFixed(3)} — see nearMisses`]
        : warnings,
      scanned,
      eligible,
      ...(cueScope ? { scopeExcluded } : {}),
      bestSimilarity: bestSim < 0 ? null : Number(bestSim.toFixed(3)),
      threshold: minSim,
      reason,
      nearMisses,
      nearDuplicates
    };
  }

  /* ============================ consolidation ============================ */

  /** Permanently delete a memory by id (row + full revision history).
   *  Throws when the id does not exist. */
  delete(id: string): void {
    const row = this.db.getById(id);
    if (!row) throw new Error(`delete: no memory with id ${id}`);
    this.db.deleteWithHistory(id);
  }

  /**
   * Systems consolidation (call offline, e.g. after a session or on a timer).
   * Episodic traces that are well established (accessed often and/or important)
   * get abstracted into durable semantic rules. Episodes themselves are kept
   * (multiple-trace stance); the semantic rule then wins retrieval for
   * general-knowledge queries while the episode still answers "when/where".
   */
  async consolidate(opts: { minAccess?: number; minImportance?: number; minAgeMs?: number; now?: string } = {}): Promise<ConsolidationCandidate[]> {
    const minAccess = opts.minAccess ?? 3;
    const minImportance = opts.minImportance ?? 0.6;
    const minAgeMs = opts.minAgeMs ?? 0;
    const nowMs = Date.parse(opts.now ?? nowIso());
    const made: ConsolidationCandidate[] = [];
    // For semantic rows, skip the episode only if it has no durable content.
    for (const row of this.db.allActive().filter((r) => r.kind === 'episode')) {
      const mem = rowToMemory(row, false);
      if (mem.accessCount < minAccess && mem.importance < minImportance) continue;
      if (minAgeMs && mem.createdAt && nowMs - Date.parse(mem.createdAt) < minAgeMs) continue;

      // Real abstraction when an LLM hook is attached (audit #4): the default
      // abstractToRule() only re-wraps the sentence with a FACT: prefix, which
      // is copy-and-rename, not generalization. A summarizer receives the
      // qualifying episode and returns distilled rule(s); a throw or an empty
      // answer falls back to the template so consolidation never fails.
      let rules: string[];
      if (this.summarizer) {
        try {
          const out = await this.summarizer([
            { summary: mem.summary, detail: mem.detail, entities: mem.entities }
          ]);
          rules = (out ?? []).map((s) => String(s).trim()).filter(Boolean);
        } catch {
          rules = [];
        }
        if (rules.length === 0) {
          const fallback = abstractToRule(mem);
          if (!fallback) continue;
          rules = [fallback];
        }
      } else {
        const rule = abstractToRule(mem);
        if (!rule) continue;
        rules = [rule];
      }
      const rowVec = vecFromBlob(row.vec);
      let already = false;
      for (const rule of rules) {
        for (const s of this.db.allActive()) {
          if (s.kind !== 'semantic') continue;
          if (s.summary === rule) {
            already = true;
            break;
          }
          if (rowVec) {
            const sv = vecFromBlob(s.vec);
            if (sv && sv.length === rowVec.length && cosine(sv, rowVec) > this.options.nearDuplicateThreshold) {
              already = true;
              break;
            }
          }
        }
        if (already) break;
      }
      if (already) continue;

      for (const rule of rules) {
        const id = randomUUID();
        const now = nowIso();
        const vec = await this.embedOne(rule);
        const semRow = this.buildRow({
          id,
          version: 1,
          kind: 'semantic',
          summary: rule,
          detail: `consolidated from episode ${mem.id}${this.summarizer ? ' (llm-summarized)' : ''}`,
          semantic: { rule },
          entities: mem.entities,
          tags: [...mem.tags, 'consolidated'],
          source: mem.source,
          confidence: mem.confidence,
          importance: mem.importance,
          createdAt: now,
          updatedAt: now,
          vec
        });
        this.db.insert(semRow);
        made.push({
          id,
          kind: 'semantic',
          summary: rule,
          detail: mem.detail,
          entities: mem.entities,
          importance: mem.importance,
          accessCount: mem.accessCount,
          ageMs: nowMs - Date.parse(mem.createdAt)
        });
      }
    }
    return made;
  }

  /* ==================== schema compression (S5) ==================== */

  /**
   * Propose foldable groups (read-only): live, non-demoted, non-retired
   * episodes sharing a scope key (entity-set signature + structured-claim
   * subject when present). Markers and already-condensed rows
   * (retraction/guard/invariant tags) never join groups.
   *
   * Returns candidate groups with suggested representatives ranked by
   * (importance, accessCount, recency) — the caller authors the invariant
   * text and applies via compress(). Nothing is mutated here.
   */
  proposeCompressions(opts: { minGroup?: number; maxRepresentatives?: number } = {}): {
    key: string;
    memberIds: string[];
    suggestedRepresentatives: string[];
    note: string;
  }[] {
    const minGroup = opts.minGroup ?? 3;
    const maxReps = Math.max(1, opts.maxRepresentatives ?? 3);
    const byKey = new Map<string, MemoryRow[]>();
    for (const row of this.db.allActive()) {
      if (row.demoted === 1 || row.superseded === 1 || row.kind !== 'episode') continue;
      if (isCondensedRow(row)) continue;
      const ents = (JSON.parse(row.entities_json || '[]') as string[])
        .map((e) => e.toLowerCase())
        .sort()
        .join('+');
      const claim = claimParts(row.summary);
      const key = `ent:${ents || '(none)'}|subj:${claim ? claim.subject : '(free)'}`;
      const list = byKey.get(key);
      if (list) list.push(row);
      else byKey.set(key, [row]);
    }
    const groups: { key: string; memberIds: string[]; suggestedRepresentatives: string[]; note: string }[] = [];
    for (const [key, list] of byKey) {
      if (list.length < minGroup) continue;
      const ranked = [...list].sort(
        (a, b) => b.importance - a.importance || b.access_count - a.access_count || (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
      );
      groups.push({
        key,
        memberIds: list.map((r) => r.id),
        suggestedRepresentatives: ranked.slice(0, Math.min(maxReps, list.length - 1)).map((r) => r.id),
        note: `${list.length} traces share scope ${key}; fold into 1 invariant + up to ${maxReps} representatives`
      });
    }
    return groups.sort((a, b) => b.memberIds.length - a.memberIds.length);
  }

  /**
   * Fold members into a caller-authored invariant (S5 apply step).
   * The invariant is inserted as a semantic row tagged `invariant` whose
   * detail names every folded member; non-representative members are
   * demoted (hidden from default recall, still live + expandable).
   * Throws on unknown/retired/demoted members, representatives outside the
   * member set, or condensed (retraction/guard/invariant) members.
   */
  async compress(plan: CompressPlan): Promise<CompressResult> {
    const summary = (plan.invariant?.summary ?? '').trim();
    if (!summary) throw new Error('compress: invariant.summary is required');
    const members = Array.from(new Set((plan.members ?? []).map((x) => String(x).trim()).filter(Boolean)));
    if (members.length === 0) throw new Error('compress: members must list at least one id');
    const reps = new Set((plan.representatives ?? []).map((x) => String(x).trim()).filter(Boolean));
    for (const id of reps) {
      if (!members.includes(id)) throw new Error(`compress: representative ${id} is not in members`);
    }
    const rows = new Map<string, MemoryRow>();
    for (const id of members) {
      const row = this.db.getById(id);
      if (!row || row.superseded === 1) throw new Error(`compress: no live member ${id}`);
      if (row.demoted === 1) throw new Error(`compress: member ${id} already folded`);
      if (isCondensedRow(row)) throw new Error(`compress: member ${id} is a marker/pattern row, not foldable detail`);
      rows.set(id, row);
    }
    const memberEnts = new Set<string>();
    for (const row of rows.values()) {
      for (const e of JSON.parse(row.entities_json || '[]') as string[]) memberEnts.add(e.toLowerCase());
    }
    const invEntities = (plan.invariant.entities ?? []).map((e) => (typeof e === 'string' ? e : e.name).trim()).filter(Boolean);
    const entities = Array.from(new Set([...invEntities.map((e) => e.toLowerCase()), ...memberEnts]));
    const kept = members.filter((id) => reps.has(id));
    const folded = members.filter((id) => !reps.has(id));
    const now = nowIso();
    const invId = randomUUID();
    const memberList = members.map((id) => id.slice(0, 8)).join(', ');
    const invRow = this.buildRow({
      id: invId,
      version: 1,
      kind: 'semantic',
      summary,
      detail: [plan.invariant.detail?.trim() || '', `covers ${members.length} traces: ${memberList}`].filter(Boolean).join('\n'),
      entities,
      tags: Array.from(new Set(['invariant', ...((plan.invariant.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))])),
      source: plan.invariant.source ?? 'compress',
      confidence: 'medium',
      importance: 0.6,
      createdAt: now,
      updatedAt: now,
      vec: await this.embedOne(
        [summary, plan.invariant.detail ?? '', ...entities].join('\n')
      )
    });
    return this.db.transaction(() => {
      this.db.insert(invRow);
      for (const id of folded) this.db.setDemoted(id, invId, now);
      return { invariantId: invId, summary, kept, demoted: folded };
    });
  }

  /** Restore folded rows to default recall (undoes a compress). */
  undemote(ids: string[]): { restored: string[] } {
    const restored: string[] = [];
    this.db.transaction(() => {
      for (const raw of ids ?? []) {
        const id = String(raw).trim();
        if (!id) continue;
        const row = this.db.getById(id);
        if (!row || row.demoted !== 1) continue;
        this.db.setDemoted(id, null);
        restored.push(id);
      }
    });
    return { restored };
  }

  /* ============================ forgetting ============================ */

  /**
   * Adaptive forgetting. Traces below the strength floor are decayed on every
   * call (Ebbinghaus curve); once they have also been idle past
   * `forgetAfterSec` they are soft-deleted (superseded), which keeps the
   * retrieval space clean without destroying the archived revision history.
   */
  forget(opts: { strengthFloor?: number; now?: string; dryRun?: boolean; force?: boolean } = {}): { forgotten: string[]; decayed: string[]; spared: string[] } {
    const strengthFloor = opts.strengthFloor ?? 0.25;
    const nowMs = Date.parse(opts.now ?? nowIso());
    const forgotten: string[] = [];
    const decayed: string[] = [];
    /** Rows protected by the zero-recall guards (audit #7), for observability. */
    const spared: string[] = [];

    for (const row of this.db.allActive()) {
      // Folded detail is already out of recall; deleting it would destroy the
      // expandable detail its invariant points at. Leave it alone.
      if (row.demoted === 1) continue;
      const mem = rowToMemory(row, false);
      const strength = mem.importance * (0.5 + 0.5 * Math.min(1, mem.accessCount / 5));
      if (strength >= strengthFloor) continue;

      // Zero-recall protection (audit #7): break the negative-feedback loop
      // "recall miss → accessCount stays 0 → decay → forgotten". Two guards:
      //   1. grace period — a row younger than forgetGraceSec is simply young,
      //      not useless; it may never have been cued yet.
      //   2. evidence exemption — a row with passing evidence is re-checkable
      //      fact, not noise; forgetting it discards the audit trail.
      // force overrides both (an explicit flush means what it says).
      if (!opts.force) {
        const ageMs = nowMs - Date.parse(mem.createdAt);
        if (ageMs < this.options.forgetGraceSec * 1000) {
          spared.push(mem.id);
          continue;
        }
        if (evidenceStanding(row, nowMs, this.options.evidenceTtlSec) !== 'none') {
          spared.push(mem.id);
          continue;
        }
      }

      const idleMs = mem.lastAccessAt ? nowMs - Date.parse(mem.lastAccessAt) : nowMs - Date.parse(mem.createdAt);
      const idleEnough = idleMs >= this.options.forgetAfterSec * 1000;
      if (idleEnough || opts.force) {
        if (opts.dryRun) {
          forgotten.push(mem.id);
          continue;
        }
        this.db.setSuperseded(mem.id);
        forgotten.push(mem.id);
        continue;
      }
      // Not idle long enough yet: decay importance a notch (unless dry run).
      if (!opts.dryRun) {
        this.db.update({ ...row, importance: mem.importance * 0.9, updated_at: nowIso() });
        decayed.push(mem.id);
      }
    }
    return { forgotten, decayed, spared };
  }

  /** Hard-delete a memory and its archived revision history. Use sparingly. */
  destroy(id: string): void {
    this.db.hardDelete(id);
  }

  /**
   * Report near-duplicate traces (read-only; never deletes).
   *
   * Duplicates accumulate from restatements that slip past the write-path
   * merge: most commonly an episode and the semantic rule abstracted from it,
   * where the rule carries a "FACT: " wrapper. Comparison strips that wrapper
   * and ignores case/punctuation, so a cross-kind restatement is recognised.
   * The write path now folds these automatically; this reports what is already
   * stored so a caller can review before merging (`mergeDuplicates`) or
   * deleting anything. Grouping is by TEXT, so a group can also hold two
   * traces that state incompatible premises: `mixedPremises` marks the group
   * when *any pair* in it disagrees, because those two rows are different facts
   * rather than duplicates (the other rows in the same group may still be).
   */
  duplicates(): {
    groups: {
      key: string;
      mixedPremises: boolean;
      memories: { id: string; kind: MemoryKind; version: number; summary: string; scope: string | null }[];
    }[];
    scanned: number;
  } {
    const byKey = new Map<string, StoredMemory[]>();
    for (const row of this.db.allActive()) {
      if (row.demoted === 1) continue; // folded detail is accounted for, not a stray duplicate
      const mem = rowToMemory(row, false);
      const key = normalizeText(stripAbstractPrefix(mem.summary));
      if (!key) continue;
      const list = byKey.get(key);
      if (list) list.push(mem);
      else byKey.set(key, [mem]);
    }
    const groups = [...byKey.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([key, list]) => {
        const sorted = list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        let mixedPremises = false;
        outer: for (let i = 0; i < sorted.length; i++) {
          for (let j = i + 1; j < sorted.length; j++) {
            if (scopeDifferences(sorted[i]?.scope ?? null, sorted[j]?.scope ?? null).length > 0) {
              mixedPremises = true;
              break outer;
            }
          }
        }
        return {
          key: key.slice(0, 120),
          mixedPremises,
          memories: sorted.map((m) => ({
            id: m.id,
            kind: m.kind,
            version: m.version,
            summary: m.summary,
            scope: m.scope ?? null
          }))
        };
      });
    return { groups, scanned: this.db.countActive() };
  }

  /**
   * Merge one duplicate group reported by `duplicates()` into a single live
   * trace.
   *
   * The extras are demoted INTO the survivor — the same mechanism `compress`
   * uses — so nothing is erased: they stay in the file, stay visible in `list()`
   * (flagged `demoted`), drop out of default recall unless `includeDemoted` is
   * set, and `undemote()` puts any of them back. `dryRun` previews the decision
   * without touching the store.
   */
  async mergeDuplicates(plan: { ids: string[]; into?: string; dryRun?: boolean } = { ids: [] }): Promise<{
    survivor: { id: string; kind: MemoryKind; version: number; summary: string } | null;
    retired: { id: string; kind: MemoryKind; summary: string }[];
    carried: string[];
    blocked: { id: string; reason: string }[];
    dryRun: boolean;
    note: string;
  }> {
    const ids = Array.from(new Set((plan.ids ?? []).map((x) => String(x).trim()).filter(Boolean)));
    if (ids.length < 2) throw new Error('merge: needs the ids of at least two restatements');
    const rows: MemoryRow[] = [];
    for (const id of ids) {
      const row = this.db.getById(id);
      if (!row || row.superseded === 1) throw new Error(`merge: no live memory ${id}`);
      if (isCondensedRow(row)) {
        throw new Error(`merge: ${id} is a marker row (retraction / guard / invariant) — retiring it would drop what it injects`);
      }
      rows.push(row);
    }
    // Same text is what makes them duplicates. Without this check a caller who
    // hands over two unrelated ids would erase one of them behind a "cleanup".
    const keys = new Set(rows.map((r) => normalizeText(stripAbstractPrefix(r.summary))));
    if (keys.size > 1) {
      throw new Error(
        `merge: these ${rows.length} ids are not restatements of one claim (${[...keys].map((k) => `"${k.slice(0, 40)}"`).join(' vs ')}) — pass a single group from duplicates()`
      );
    }
    // Pick the row that is worth keeping: re-checkable evidence outranks a bare
    // restatement (merging must never retire the only row an agent can re-run),
    // then usage, then salience; creation time only breaks ties.
    const byValue = [...rows].sort(
      (a, b) =>
        Number(b.verify_result === 'pass') - Number(a.verify_result === 'pass') ||
        b.access_count - a.access_count ||
        b.importance - a.importance ||
        b.version - a.version ||
        a.created_at.localeCompare(b.created_at)
    );
    const survivor = plan.into ? rows.find((r) => r.id === plan.into) ?? null : byValue[0] ?? null;
    if (!survivor) throw new Error(`merge: ${plan.into} is not one of the ids`);
    const toView = (r: MemoryRow) => ({ id: r.id, kind: r.kind, summary: r.summary });

    // Premise gate: `duplicates()` groups by TEXT, and the same sentence under
    // another condition is deliberately its own trace (that is what `scope` is
    // for), so those rows are not restatements of each other and stay apart.
    const clashOf = (r: MemoryRow) => scopeDifferences(survivor.scope, r.scope);
    const others = byValue.filter((r) => r.id !== survivor.id);
    const retired = others.filter((r) => clashOf(r).length === 0);
    const blocked = others
      .filter((r) => clashOf(r).length > 0)
      .map((r) => ({
        id: r.id,
        reason: `states different premises (${clashOf(r).join(', ')}) — the same sentence under another condition stays its own trace`
      }));
    if (retired.length === 0) {
      return {
        survivor: null,
        retired: [],
        carried: [],
        blocked,
        dryRun: !!plan.dryRun,
        note: 'merge: nothing retired — every other row in the group states premises that disagree with the one it would be merged into'
      };
    }

    // What the retired rows know that the survivor does not. Merging text is
    // easy; losing the only mention of an entity is how a cleanup turns into a
    // retrieval regression.
    const ownEnts = new Set(JSON.parse(survivor.entities_json || '[]') as string[]);
    const ownTags = new Set(JSON.parse(survivor.tags_json || '[]') as string[]);
    const extraEnts: string[] = [];
    const extraTags: string[] = [];
    let richest = (survivor.detail ?? '').trim();
    let richestFrom = '';
    let topImportance = survivor.importance;
    let importanceFrom = '';
    for (const r of retired) {
      for (const e of JSON.parse(r.entities_json || '[]') as string[]) {
        if (!ownEnts.has(e) && !extraEnts.includes(e)) extraEnts.push(e);
      }
      for (const t of JSON.parse(r.tags_json || '[]') as string[]) {
        if (!ownTags.has(t) && !extraTags.includes(t)) extraTags.push(t);
      }
      const d = (r.detail ?? '').trim();
      if (d.length > richest.length) { richest = d; richestFrom = r.id; }
      if (r.importance > topImportance) { topImportance = r.importance; importanceFrom = r.id; }
    }
    const carried: string[] = [];
    if (extraEnts.length) carried.push(`entities +${extraEnts.length} (${extraEnts.join(', ')})`);
    if (extraTags.length) carried.push(`tags +${extraTags.length} (${extraTags.join(', ')})`);
    if (richestFrom) carried.push(`detail from ${richestFrom.slice(0, 8)} (longer verbatim record)`);
    if (importanceFrom) carried.push(`importance ${survivor.importance} → ${topImportance}`);

    if (plan.dryRun) {
      return {
        survivor: { id: survivor.id, kind: survivor.kind, version: survivor.version, summary: survivor.summary },
        retired: retired.map(toView),
        carried,
        blocked,
        dryRun: true,
        note: `preview only — applying would keep ${survivor.id.slice(0, 8)} and retire ${retired.length} restatement(s) (reversible with undemote)`
      };
    }

    // Carry over BEFORE retiring: if the process dies in between the group is
    // still reported as duplicate (harmless, re-run), whereas the reverse order
    // would drop the survivor's inherited entities with nothing left to restore.
    if (extraEnts.length || extraTags.length || richestFrom || importanceFrom) {
      await this.update(survivor.id, {
        ...(extraEnts.length ? { entities: extraEnts.map((name) => ({ name })) } : {}),
        ...(extraTags.length ? { tags: extraTags } : {}),
        ...(richestFrom ? { detail: richest } : {}),
        ...(importanceFrom ? { importance: topImportance } : {})
      });
    }
    const now = nowIso();
    return this.db.transaction(() => {
      for (const r of retired) this.db.setDemoted(r.id, survivor.id, now);
      // Report the row as it now stands: carrying over bumps its version.
      const after = this.db.getById(survivor.id) ?? survivor;
      return {
        survivor: { id: after.id, kind: after.kind, version: after.version, summary: after.summary },
        retired: retired.map(toView),
        carried,
        blocked,
        dryRun: false,
        note: `kept ${survivor.id.slice(0, 8)} and retired ${retired.length} restatement(s) — still live, hidden from default recall, reversible with undemote`
      };
    });
  }

  /**
   * Audit view for overwritten memories (field report BUG-1 follow-up).
   *
   * `duplicates()` only finds rows that still COEXIST with near-identical text,
   * so it cannot see the damaging case at all: an override ARCHIVES the old row
   * and keeps a live row about a different subject, leaving no live pair to
   * compare. This walks the version history instead and reports overrides whose
   * archived text has poor lexical overlap with the live text — i.e. "the theme
   * did not carry over", the exact signature of an unrelated memory being
   * retired.
   *
   * Read-only. Lexical overlap is a heuristic screen for human review, not a
   * verdict: it deliberately favours recall over precision.
   */
  overrideAudit(opts: { minOverlap?: number; limit?: number } = {}): {
    suspicious: {
      id: string;
      liveSummary: string;
      archived: { version: number; summary: string; archivedAt: string | null };
      overlap: number;
      entitiesLive: string[];
      entitiesArchived: string[];
      sharedEntities: string[];
    }[];
    scannedOverridden: number;
    note: string;
  } {
    const minOverlap = opts.minOverlap ?? 0.34;
    const limit = opts.limit ?? 50;
    const suspicious: {
      id: string;
      liveSummary: string;
      archived: { version: number; summary: string; archivedAt: string | null };
      overlap: number;
      entitiesLive: string[];
      entitiesArchived: string[];
      sharedEntities: string[];
    }[] = [];
    let scannedOverridden = 0;

    for (const row of this.db.allActive()) {
      if (row.version <= 1) continue; // never overridden
      scannedOverridden++;
      const history = this.db.historyOf(row.id);
      const prior = history.find((h) => h.version === row.version - 1) ?? history[0];
      if (!prior) continue;
      // Compare the BOUND VALUES, not the whole sentences. A structured claim
      // keeps its subject across a correction ("deploy target -> X" stays
      // "deploy target -> Y"), so whole-sentence overlap is dominated by the
      // shared prefix and never drops. The value is what actually changed.
      const rowClaim = claimParts(row.summary);
      const priorClaim = claimParts(prior.summary);
      const liveText = rowClaim ? rowClaim.value : row.summary;
      const archText = priorClaim ? priorClaim.value : prior.summary;
      const liveTokens = new Set(normalizeText(liveText).split(/\s+/).filter(Boolean));
      const archTokens = new Set(normalizeText(archText).split(/\s+/).filter(Boolean));
      if (liveTokens.size === 0 || archTokens.size === 0) continue;
      let shared = 0;
      for (const t of liveTokens) if (archTokens.has(t)) shared++;
      const overlap = Number((shared / Math.max(1, Math.min(liveTokens.size, archTokens.size))).toFixed(3));
      if (overlap >= minOverlap) continue;
      const liveEntities = JSON.parse(row.entities_json || '[]') as string[];
      const archEntities = JSON.parse(prior.entities_json || '[]') as string[];
      const lowered = new Set(archEntities.map((e) => e.toLowerCase()));
      suspicious.push({
        id: row.id,
        liveSummary: sanitizeMemoryText(row.summary).slice(0, 100),
        archived: {
          version: prior.version,
          summary: sanitizeMemoryText(prior.summary).slice(0, 100),
          archivedAt: prior.archived_at ?? null
        },
        overlap,
        entitiesLive: liveEntities,
        entitiesArchived: archEntities,
        sharedEntities: liveEntities.filter((e) => lowered.has(e.toLowerCase()))
      });
    }

    suspicious.sort((a, b) => a.overlap - b.overlap);
    return {
      suspicious: suspicious.slice(0, limit),
      scannedOverridden,
      note:
        'Read-only screen. Rows version > 1 whose archived revision shares little wording with the live text — ' +
        'the signature of an unrelated memory being retired by an override. Low overlap is a heuristic prompt for ' +
        'review, not proof. Recover the archived text with memory_maintain history <id>.'
    };
  }


  /* ============================ source monitoring ============================ */

  /** Polarity of a text: does it assert the negative form of its subject? */
  private polarityOf(text: string): boolean {
    return NEGATION_RE.test(text);
  }

  /** Render a RelatedTrace (sanitized — injection guard applies at every exit). */
  private toRelated(r: MemoryRow, sim: number): RelatedTrace {
    return {
      id: r.id,
      summary: sanitizeMemoryText(r.summary),
      detail: r.detail ? sanitizeMemoryText(r.detail) : undefined,
      source: r.source ? sanitizeMemoryText(r.source) : undefined,
      verifyResult: r.verify_result === 'pass' || r.verify_result === 'fail' ? r.verify_result : undefined,
      confidence: r.confidence,
      version: r.version,
      updatedAt: r.updated_at,
      entities: JSON.parse(r.entities_json || "[]") as string[],
      scope: r.scope ?? undefined,
      similarity: sim
    };
  }

  /** True when two entity sets share at least one name (case-insensitive). */
  private entitiesOverlap(a: string[], b: string[]): boolean {
    if (a.length === 0 || b.length === 0) return false;
    const sa = new Set(a.map((x) => x.toLowerCase()));
    for (const x of b) if (sa.has(x.toLowerCase())) return true;
    return false;
  }

  /**
   * Prefrontal stand-in for the agent '"should I assert this?"' check.
   * Verdict plus the evidence the old version silently dropped:
   *   - contradicting[]: same-scope rows asserting the opposite polarity
   *   - newer_related[]: newer rows on the same scope (stale-support check)
   *   - superseded_matches[]: rows retired via an explicit supersedes edge
   *   - stale_support: the top support is NOT the newest word on its scope
   *   - out_of_scope: the support holds under premises the claim does not
   *     share (see MemoryPayload.scope) — pass `opts.scope` to have the
   *     engine compare them and prefer the trace stated under your premises.
   */
  async sourceMonitor(claim: string, opts: { scope?: string } = {}): Promise<{
    substantiated: boolean;
    contradicted: boolean;
    /** True when the closest trace is stated under premises that disagree with `opts.scope`. */
    out_of_scope: boolean;
    support?: { id: string; summary: string; detail?: string; verifyResult?: 'pass' | 'fail'; verifiedAt?: string; source?: string; confidence: string; version: number; score: number; scope?: string } | null;
    contradiction?: { id: string; summary: string; detail?: string; verifyResult?: 'pass' | 'fail'; verifiedAt?: string; source?: string; confidence: string; version: number; score: number; scope?: string } | null;
    closest?: { id: string; summary: string; detail?: string; verifyResult?: 'pass' | 'fail'; verifiedAt?: string; source?: string; confidence: string; version: number; score: number; scope?: string } | null;
    /** Same-scope rows asserting the opposite polarity of the claim. */
    contradicting: RelatedTrace[];
    /** Newer rows sharing the claim's scope (the support may be stale). */
    newer_related: RelatedTrace[];
    /** Retired rows whose superseded_by points at a matched row. */
    superseded_matches: RelatedTrace[];
    /** True when the top support has a newer same-scope sibling. */
    stale_support: boolean;
    /**
     * Three-state upgrade of the argmax contract (audit #3): true when the
     * substantiating argmax row is NOT the newest word on its scope, or when
     * a related row asserts the opposite. The boolean verdict stays (an
     * affirming exact match is still support), but a contested yes must be
     * re-checked against contradicting[] / newer_related[] before asserting.
     */
    contested: boolean;
    note: string;
  }> {
    const cueVec = await this.embedOne(claim);
    const claimNegated = this.polarityOf(claim);
    const queryScope = typeof opts.scope === 'string' && opts.scope.trim() ? opts.scope.trim() : undefined;
    // Score every comparable row ONCE: the argmax pass and the related-row scan
    // below need the same cosine against the same cue vector. Keeping the pairs
    // around avoids decoding and re-computing the whole store a second time.
    const scored: { r: MemoryRow; sim: number }[] = [];
    for (const r of this.db.allActive()) {
      const b = vecFromBlob(r.vec);
      if (!b || b.length !== cueVec.length) continue;
      scored.push({ r, sim: cosine(b, cueVec) });
    }

    let best: { id: string; summary: string; detail?: string; verifyResult?: 'pass' | 'fail'; verifiedAt?: string; source?: string; confidence: string; version: number; score: number; scope?: string } | undefined;
    let bestSim = -1;
    for (const { r, sim } of scored) {
      if (sim <= bestSim) continue;
      const mem = rowToMemory(r, false);
      best = { id: mem.id, summary: sanitizeMemoryText(mem.summary), detail: mem.detail ? sanitizeMemoryText(mem.detail) : undefined, verifyResult: mem.verifyResult, verifiedAt: mem.verifiedAt, source: mem.source ? sanitizeMemoryText(mem.source) : undefined, confidence: mem.confidence, version: mem.version, score: sim, scope: mem.scope };
      bestSim = sim;
    }

    // Premise-aware support choice: when the caller states the conditions of
    // the claim, a trace stated under THOSE conditions outranks a closer match
    // stated under others (measured failure: an old-scope conclusion at higher
    // similarity answered a new-scope claim, `substantiated: true`). A row that
    // names no premise ranks between the two — it cannot be wrong for this
    // scope, but it is not the caller's scope either, so it stays below a row
    // that states it. Without a caller scope the ordering is untouched.
    if (queryScope) {
      const rank = (r: MemoryRow): number => (!r.scope ? 1 : scopeDifferences(r.scope, queryScope).length === 0 ? 2 : 0);
      const chosen = scored
        .filter(({ r, sim }) => sim >= this.options.similarityThreshold)
        .sort((a, b) => rank(b.r) - rank(a.r) || b.sim - a.sim)[0];
      if (chosen) {
        const mem = rowToMemory(chosen.r, false);
        best = { id: mem.id, summary: sanitizeMemoryText(mem.summary), detail: mem.detail ? sanitizeMemoryText(mem.detail) : undefined, verifyResult: mem.verifyResult, verifiedAt: mem.verifiedAt, source: mem.source ? sanitizeMemoryText(mem.source) : undefined, confidence: mem.confidence, version: mem.version, score: chosen.sim, scope: mem.scope };
        bestSim = chosen.sim;
      }
    }

    if (!best || bestSim < this.options.similarityThreshold) {
      return {
        substantiated: false,
        contradicted: false,
        out_of_scope: false,
        closest: best ?? null,
        contradicting: [],
        newer_related: [],
        superseded_matches: [],
        stale_support: false,
        contested: false,
        note: `UNSUBSTANTIATED: no stored trace matches this claim (best similarity ${bestSim.toFixed(2)} < ${this.options.similarityThreshold}). Do NOT assert it from memory; answer "I don't know / not in my memory".`
      };
    }

    // Premise mismatch comes before the negation heuristic: judging the claim
    // TRUE or FALSE against a trace stated under other conditions is exactly
    // the silent contamination this field exists to stop.
    if (queryScope && best.scope) {
      const differing = scopeDifferences(best.scope, queryScope);
      if (differing.length > 0) {
        return {
          substantiated: false,
          contradicted: false,
          out_of_scope: true,
          support: best,
          contradicting: [],
          newer_related: [],
          superseded_matches: [],
          stale_support: false,
          contested: false,
          note:
            `OUT_OF_SCOPE: the closest trace ${best.id} (v${best.version}) is stated under "${sanitizeMemoryText(best.scope)}" ` +
            `and the claim was checked under "${sanitizeMemoryText(queryScope)}" — the key(s) ${differing.join(', ')} hold different values, ` +
            `so memory neither supports nor refutes the claim here. Re-verify under the trace's own premises, ` +
            `or remember the new-scope conclusion with its own scope so both stand side by side.`
        };
      }
    }

    // Negation heuristic on the global argmax (unchanged behaviour).
    // NOTE: negation is tested on the SANITIZED text, so a payload cannot
    // escape contradiction detection by hiding inside a hijack phrase.
    const storedNegated = this.polarityOf(best.summary);
    const infectedNote = best.summary.includes('[sanitized-') ? ' [injection: stored text contained instruction-shaped content — sanitized]' : '';
    if (claimNegated !== storedNegated && bestSim >= this.options.similarityThreshold) {
      const bestRow = this.db.getById(best.id);
      return {
        substantiated: false,
        contradicted: true,
        out_of_scope: false,
        contradiction: best,
        contradicting: bestRow ? [this.toRelated(bestRow, bestSim)] : [],
        newer_related: [],
        superseded_matches: [],
        stale_support: false,
        contested: true,
        note: `CONTRADICTED: memory asserts the opposite scope (${best.summary.slice(0, 80)} [v${best.version}]). Do not state the claim without flagging this conflict.${infectedNote}`
      };
    }

    // Value contradiction on the SUPPORT itself: the closest trace binds the
    // same subject to a DIFFERENT value than the claim asks to confirm. argmax
    // alone reads this as support (same subject, high cosine, same polarity) —
    // it is the opposite, and this is the one row the related-scan below skips
    // (it excludes best.id). One value containing the other is a refinement,
    // not a clash (`postgres` vs `postgres 15`), so those still substantiate.
    const claimClaim = claimParts(claim);
    const bestClaim = claimParts(best.summary);
    if (
      claimClaim &&
      bestClaim &&
      claimClaim.subject === bestClaim.subject &&
      valueClash(claimClaim.value, bestClaim.value)
    ) {
      const bestRow = this.db.getById(best.id);
      // The claim restates the OLD value of a row that has since moved on:
      // the live row contradicts it, but the archived revision that said
      // exactly this must stay reachable (S2) — a contradiction verdict with
      // an empty history would tell the caller "never held", which is a lie.
      const normClaimHere = normalizeText(stripAbstractPrefix(claim));
      const archMatches: RelatedTrace[] = [];
      if (bestRow) {
        for (const h of this.db.historyOf(best.id)) {
          if (normalizeText(stripAbstractPrefix(h.summary as string)) !== normClaimHere) continue;
          archMatches.push({
            id: best.id,
            summary: sanitizeMemoryText(h.summary as string),
            source: undefined,
            confidence: (best.confidence ?? 'medium') as 'high' | 'medium' | 'low' | 'speculative',
            version: Number(h.version),
            updatedAt: (h.archived_at as string) ?? '',
            entities: [],
            similarity: 1
          });
        }
        // Rows explicitly retired by (or into) the live row: the correction
        // chain must survive the contradiction verdict too, or asking the old
        // wording would report "never held" while the store still holds it.
        for (const r of this.db.supersededBy(best.id)) {
          archMatches.push(this.toRelated(r, 0));
        }
      }
      const archNote = archMatches.length > 0
        ? ` NOTE: this claim matches archived v${archMatches.map((s) => s.version).join(',v')} of ${best.id.slice(0, 8)} (retired revisions included) — the live row says otherwise. See superseded_matches.`
        : '';
      return {
        substantiated: false,
        contradicted: true,
        out_of_scope: false,
        contradiction: best,
        contradicting: bestRow ? [this.toRelated(bestRow, bestSim)] : [],
        newer_related: [],
        superseded_matches: archMatches,
        stale_support: false,
        contested: true,
        note: `CONTRADICTED: memory binds "${bestClaim.subject}" to "${sanitizeMemoryText(bestClaim.value)}" (v${best.version}), not "${sanitizeMemoryText(claimClaim.value)}". The closest trace states a different value — do not assert the claim.${infectedNote}${archNote}`
      };
    }

    // ---- P0-1: the scan the old version never did ----
    // Related active rows: entity-overlapping OR clearing the similarity floor.
    // Reuses the scores computed above — no second decode/cosine pass.
    const supportRow = this.db.getById(best.id);
    const supportEntities = supportRow ? (JSON.parse(supportRow.entities_json || "[]") as string[]) : [];
    const related = supportRow
      ? scored
          .filter(({ r }) => r.id !== best.id)
          .filter(({ r, sim }) => sim >= this.options.similarityThreshold || this.entitiesOverlap(supportEntities, JSON.parse(r.entities_json || '[]') as string[]))
          .sort((a, b) => b.sim - a.sim)
          .slice(0, 8)
      : [];

    // (a) contradictions among related rows — entity-anchored.
    // A contradiction needs a SHARED ENTITY with the support row PLUS a real
    // textual disagreement (opposite polarity or the same subject bound to a
    // different value). Similarity alone is not opposition, and neither is a
    // prose-derived subject match: claimParts extracts subjects from ordinary
    // prose too, so same-subject-without-shared-entity collides between
    // unrelated sentences (field report BUG-1 (a), seen again in round 8:
    // verifying an archived value flagged entity-disjoint rows at 0.6 sim).
    const supportClaim = supportRow ? claimParts(supportRow.summary) : null;
    const contradicting = related
      .filter(({ r }) => {
        const rowEntities = JSON.parse(r.entities_json || '[]') as string[];
        if (!this.entitiesOverlap(supportEntities, rowEntities)) return false;
        const rowClaim = claimParts(r.summary);
        const oppositePolarity = this.polarityOf(r.summary) !== claimNegated;
        const valueDisagrees =
          !!(supportClaim && rowClaim && rowClaim.subject === supportClaim.subject && valueClash(rowClaim.value, supportClaim.value)) ||
          !!(claimClaim && rowClaim && rowClaim.subject === claimClaim.subject && valueClash(rowClaim.value, claimClaim.value));
        return oppositePolarity || valueDisagrees;
      })
      .map(({ r, sim }) => this.toRelated(r, sim));

    // (b) newer same-scope rows — the support may be stale. Being newer and
    // merely clearing the cosine floor is NOT a correction (round 9 field
    // report: 24/38 contested flags were newer-but-unrelated topical siblings,
    // e.g. notif-queue flagged by an unrelated export-worker-queue row). A
    // newer neighbour only makes the support stale when it is about the SAME
    // subject: it must share an entity with the support row (the structural
    // subject anchor), and — when BOTH sides yield a structured claim — bind
    // that subject to a DIFFERENT value. Prose corrections ("X switched to Y")
    // carry no extractable value, so same-entity + newer + different-text is
    // the strongest signal available and is treated as stale.
    const newerRelated = related
      .filter(({ r }) => (supportRow ? r.updated_at > supportRow.updated_at : false))
      .filter(({ r }) => {
        const rowEntities = JSON.parse(r.entities_json || '[]') as string[];
        if (!this.entitiesOverlap(supportEntities, rowEntities)) return false;
        const rowClaim = claimParts(r.summary);
        // Both sides structured on the same subject: require a real value clash
        // so a reworded restatement of the same value is not called stale.
        if (rowClaim && supportClaim && rowClaim.subject === supportClaim.subject) {
          return valueClash(rowClaim.value, supportClaim.value);
        }
        if (rowClaim && claimClaim && rowClaim.subject === claimClaim.subject) {
          return valueClash(rowClaim.value, claimClaim.value);
        }
        // Prose (no structured claim to compare): same-entity newer trace stands.
        return true;
      })
      .map(({ r, sim }) => this.toRelated(r, sim));

    // (c) retired rows whose supersedes edge points at the support
    const supersededMatches = supportRow ? this.db.supersededBy(best.id).map((r) => this.toRelated(r, 0)) : [];

    // (d) archived-revision matches (suggestion 2 + 模糊检索): the claim may
    // restate an OLD version of a row whose live text moved on ("what was it
    // last round?"). Version history is the one place recall never looks, so
    // say so explicitly instead of blessing the old number against the new
    // row. Two tiers: exact restatement (similarity 1), and same-subject
    // value flips found structurally with similarity re-measured against the
    // claim (bounded extra embeds — history has no stored vectors).
    const normClaim = normalizeText(stripAbstractPrefix(claim));
    const archiveRows: { id: string; row: MemoryRow }[] = [];
    if (supportRow) archiveRows.push({ id: supportRow.id, row: supportRow });
    for (const { r } of related) archiveRows.push({ id: r.id, row: r });
    let fuzzyLeft = 8;
    for (const { id, row } of archiveRows) {
      const live = this.db.getById(id);
      const liveNorm = live ? normalizeText(stripAbstractPrefix(live.summary)) : null;
      const liveClaim = live ? claimParts(live.summary) : null;
      // Fuzzy-tier relevance anchor (round-9 field report: a notif-queue verify
      // pulled deploy-target/export-worker archives at ~0.59 sim). The fuzzy
      // branch below re-embeds an archived revision and admits it on cosine
      // alone, so an unrelated subject that merely flipped its own value can
      // clear the floor against this claim. Require the row to share an entity
      // with the support (the structural subject anchor) unless it IS the
      // support row — the exact-restatement tier stays unguarded because a
      // literal text match is decisive on its own.
      const rowEntities = JSON.parse(row.entities_json || '[]') as string[];
      const fuzzyRelevant = id === best.id || this.entitiesOverlap(supportEntities, rowEntities);
      for (const h of this.db.historyOf(id)) {
        const archNorm = normalizeText(stripAbstractPrefix(h.summary as string));
        const archClaim = claimParts(h.summary as string);
        if (archNorm === normClaim) {
          if (liveNorm === normClaim) continue; // live already says it
          supersededMatches.push({
            id,
            summary: sanitizeMemoryText(h.summary as string),
            source: undefined,
            confidence: (live?.confidence ?? 'medium') as 'high' | 'medium' | 'low' | 'speculative',
            version: Number(h.version),
            updatedAt: (h.archived_at as string) ?? '',
            entities: [],
            similarity: 1,
            verifyResult: (h.verify_result as string | null) === 'pass' || (h.verify_result as string | null) === 'fail'
              ? (h.verify_result as 'pass' | 'fail')
              : undefined
          });
          continue;
        }
        // Fuzzy tier: the archived revision binds the same subject to a
        // different value than the live row (or the claim) holds — a reworded
        // "last round" question. Relevance comes from the row already being
        // in the related set AND sharing an entity with the support; the score
        // is re-measured, never invented.
        if (fuzzyLeft <= 0 || !fuzzyRelevant) continue;
        const flipVsLive = !!(liveClaim && archClaim && archClaim.subject === liveClaim.subject && archClaim.value !== liveClaim.value);
        const flipVsClaim = !!(claimClaim && archClaim && archClaim.subject === claimClaim.subject && archClaim.value !== claimClaim.value);
        if (!(flipVsLive || flipVsClaim) || archNorm === liveNorm) continue;
        fuzzyLeft--;
        const avec = await this.embedOne(h.summary as string);
        const asim = avec.length === cueVec.length ? cosine(avec, cueVec) : 0;
        if (asim < this.options.similarityThreshold) continue;
        supersededMatches.push({
          id,
          summary: sanitizeMemoryText(h.summary as string),
          source: undefined,
          confidence: (live?.confidence ?? 'medium') as 'high' | 'medium' | 'low' | 'speculative',
          version: Number(h.version),
          updatedAt: (h.archived_at as string) ?? '',
          entities: [],
          similarity: Number(asim.toFixed(3)),
          verifyResult: (h.verify_result as string | null) === 'pass' || (h.verify_result as string | null) === 'fail'
            ? (h.verify_result as 'pass' | 'fail')
            : undefined
        });
      }
    }

    const staleSupport = newerRelated.length > 0 || supersededMatches.length > 0;
    const staleNote = staleSupport
      ? ' WARNING: a NEWER trace exists on this scope — the support above may be outdated. Review newer_related before asserting.'
      : '';
    const contradictNote = contradicting.length > 0
      ? ` WARNING: ${contradicting.length} related trace(s) assert the OPPOSITE of this claim — review contradicting[] before asserting.`
      : '';
    const archiveHits = supersededMatches.filter((s) => s.similarity === 1);
    const archiveNote = archiveHits.length > 0 && archiveHits[0]
      ? ` NOTE: this claim matches archived v${archiveHits.map((s) => s.version).join(',v')} of ${archiveHits[0].id.slice(0, 8)} — the live row says otherwise. See superseded_matches.`
      : '';
    const fuzzyHits = supersededMatches.filter((s) => s.similarity !== 1);
    const fuzzyNote = fuzzyHits.length > 0 && fuzzyHits[0]
      ? ` NOTE: ${fuzzyHits.length} archived revision(s) bind the same subject to a different value — see superseded_matches for what it used to say.`
      : '';
    // Stale-evidence flag (保鲜期): the support's proof outlived its TTL —
    // treat the standing as ASSERTED and say when it was last run.
    const staleEvidenceNote =
      supportRow &&
      supportRow.verify_result === 'pass' &&
      !evidenceFresh(supportRow.verify_result, supportRow.verified_at, Date.now(), this.options.evidenceTtlSec)
        ? ` NOTE: support evidence is stale (last run ${supportRow.verified_at ?? 'unstamped'}) — re-run before trusting.`
        : '';

    // Unchecked premise: the support is conditional and the caller never said
    // which condition it is asking about. Substantiating it silently would be
    // the same contamination in the other direction, so name the premise and
    // say it was not compared.
    const premiseNote = supportRow?.scope
      ? queryScope
        ? ''
        : ` NOTE: CONDITIONAL SCOPE — the support holds only under "${sanitizeMemoryText(supportRow.scope)}" and the claim stated no scope, so that premise was not checked. Pass verify's scope argument to compare it.`
      : queryScope
        ? ` NOTE: the support states no scope — its premise could not be checked against "${sanitizeMemoryText(queryScope)}".`
        : '';

    // Audit #3: the argmax contract stays (an affirming match substantiates),
    // but the verdict is no longer a bare boolean — when the support is not
    // the newest word on its scope, or a related row disagrees, the caller
    // must treat the yes as contested and read the neighbourhood evidence.
    const contested = staleSupport || contradicting.length > 0;
    const contestedNote = contested
      ? ' CONTESTED: this yes is disputed (stale support or a disagreeing sibling) — weigh contradicting[] / newer_related[] before asserting.'
      : '';

    return {
      substantiated: true,
      contradicted: false,
      out_of_scope: false,
      support: best,
      contradicting,
      newer_related: newerRelated,
      superseded_matches: supersededMatches,
      stale_support: staleSupport,
      contested,
      note: `SUBSTANTIATED: matches ${best.id} (v${best.version}, sim ${bestSim.toFixed(2)}).${infectedNote}${staleNote}${contradictNote}${archiveNote}${fuzzyNote}${staleEvidenceNote}${premiseNote}${contestedNote}`
    };
  }
  /* ============================ context gating ============================ */

  /**
   * Working-memory gate: builds the compact memory context for the current
   * goal — goal-relevant traces first, optionally a few recent ones as a
   * recency buffer, each with provenance and confidence tags so the LLM can
   * weigh them (and knows when something is a *guess* of retrieval).
   */
  async composeContext(
    goal: string,
    opts: { limit?: number; includeRecent?: boolean; recentLimit?: number; lowConfidenceTop1?: boolean } = {}
  ): Promise<{ context: string; items: RetrievedMemory[]; warnings: string[] }> {
    const limit = opts.limit ?? 6;
    const rec = await this.recall({ query: goal }, limit);
    const items = [...rec.hits];
    const warnings = [...rec.warnings];
    const tagNow = Date.now();
    this.digestCoverage.turns += 1;
    if (items.length === 0) this.digestCoverage.misses += 1;

    /** One rendered line per memory; the only place the digest format lives. */
    const renderLine = (m: RetrievedMemory, i: number): string => {
      const prov = m.source ? ` [source: ${sanitizeMemoryText(m.source)}]` : '';
      const conf = m.confidence === 'high' ? '' : ` [conf:${m.confidence}]`;
      const kind = `[${m.kind}${m.consolidated ? '/semantic' : ''}]`;
      const occ = m.occurredAt ? ` (at ${m.occurredAt})` : '';
      // A guess carries no standing: it never cleared the floor, so it may not
      // borrow VERIFIED/ASSERTED from the row it happens to be. Audit #5: the
      // engine never executes verify commands, so a reported pass is labelled
      // by its trust tier — attested runs get the bare badge, self-reported
      // passes are marked as such (the write-path shield degrades the same way).
      const standing = m.lowConfidence
        ? ` [low-confidence sim ${m.similarity.toFixed(2)} < floor ${rec.threshold.toFixed(2)}: the closest trace, not a memory — verify before asserting]`
        : evidenceFresh(m.verifyResult, m.verifiedAt, tagNow, this.options.evidenceTtlSec)
          ? m.verifyAttested
            ? ' [VERIFIED]'
            : ' [VERIFIED self-reported]'
          : m.kind === 'semantic'
            ? ' [ASSERTED]'
            : '';
      const guardTag = m.tags.includes('guard') ? ' [GUARD]' : '';
      const scopeTag = m.scope ? ` [scope: ${sanitizeMemoryText(m.scope)}]` : '';
      const recentTag = m.recent ? ' [recent]' : '';
      const retrTag = m.retracted ? ` [retracted: ${sanitizeMemoryText(m.retracted.criterion)}]` : '';
      return `${i + 1}. ${kind}${prov}${conf}${occ}${standing}${guardTag}${scopeTag}${recentTag}${retrTag} v${m.version} ${sanitizeMemoryText(m.summary)}`;
    };

    // Nothing cleared the floor: still show the single closest trace, marked.
    // "Nothing is stored" and "the best match scored 0.31 against your cue" are
    // different answers, and the second one used to be dropped in silence.
    // A similarity of exactly 0 is no overlap at all, so it stays a real miss.
    const near =
      items.length === 0 && rec.reason === 'below-threshold' && opts.lowConfidenceTop1 !== false
        ? rec.nearMisses[0]
        : undefined;
    const guessRow = near && near.similarity > 0 ? this.db.getById(near.id) : undefined;
    const guess: RetrievedMemory | null = guessRow && near
      ? {
          ...rowToMemory(guessRow, false),
          score: near.similarity,
          similarity: near.similarity,
          relativeScore: 0,
          consolidated: false,
          lowConfidence: true
        }
      : null;
    if (guess) {
      this.digestCoverage.guesses += 1;
      warnings.push('low-confidence: the closest sub-threshold trace is shown in the digest as a guess, not a memory — verify before asserting');
    }

    // Fail-visible (suggestion 3): zero hits must render as a status line,
    // not as filler that looks alive. Backfilling [recent] rows here made
    // the channel read healthy while serving the last writes on every cue.
    if (opts.includeRecent && items.length === 0) {
      const n = this.db.countActive();
      warnings.push('includeRecent: no hits to supplement — recency buffer withheld so failure stays visible');
      warnings.push(`no hit cleared the threshold for this task (${n} stored)`);
      return {
        context: dataFrame(
          [
            `(no memory above threshold for this task; ${n} stored${guess ? ' — the closest trace is shown below, as a guess' : ''})`,
            ...(guess ? [renderLine(guess, 0)] : [])
          ].join('\n')
        ),
        items: guess ? [guess] : [],
        warnings
      };
    }

    if (opts.includeRecent) {
      const recent = this.db
        .allActive()
        .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
        .slice(0, opts.recentLimit ?? 3);
      const seen = new Set(items.map((i) => i.id));
      for (const r of recent) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const mem = rowToMemory(r, false);
        // Flagged at push time (S7 fix): the old index-arithmetic tag
        // (items.slice(limit) vs slice(0,limit)) addressed disjoint ranges,
        // so [recent] could never render.
        items.push({ ...mem, score: 0.5, similarity: 0.5, relativeScore: 0, consolidated: false, recent: true });
      }
      warnings.push('includeRecent: appended recent traces not directly goal-relevant');
    }

    // Evidence + marker tags are rendered by renderLine above (standing, guard,
    // scope, recency, retraction). A goal-relevant set wins, so the guess only
    // appears when nothing else did.
    if (items.length === 0 && guess) items.push(guess);
    const shown = items.slice(0, limit);
    // Injection guard: memory text is data the agent (or a page it read) once
    // wrote — never instructions. Sanitized per line, framed as a whole block.
    return { context: dataFrame(shown.map(renderLine).join('\n')), items: shown, warnings };
  }

  /* ============================ introspection ============================ */

  stats(): { active: number; episodes: number; semantics: number; procedures: number; historyRows: number; demoted: number } {
    const rows = this.db.allActive();
    const count = (k: string) => rows.filter((r) => r.kind === k).length;
    return {
      active: rows.length,
      episodes: count('episode'),
      semantics: count('semantic'),
      procedures: count('procedure'),
      historyRows: rows.reduce((s, r) => s + r.version - 1, 0),
      demoted: rows.filter((r) => r.demoted === 1).length
    };
  }

  /**
   * P0-3: deep observability. stats() answers "how many rows"; diagnostics()
   * answers "is the memory system actually working". Detects the silent
   * killer: embedder mismatch — a real-model store queried by the hashing
   * fallback yields garbage cosines (measured 0.01–0.11), zero hits, forever,
   * with nothing in stats() looking wrong.
   */
  diagnostics(): {
    store_path: string;
    embedder: {
      /** 'model' when a real provider is attached and healthy, else 'hashing'. */
      kind: 'model' | 'hashing';
      dim: number;
      /** Dimension histogram of stored vectors — a mix means cross-embedder rows. */
      storedDims: { dim: number; rows: number }[];
      /** True when stored vectors disagree with the current embedder's dim. */
      dimMismatch: boolean;
    };
    thresholds: { similarity: number; nearDuplicate: number; contradiction: number; claim: number; minImportance: number };
    activity: {
      /** Rows never read since creation (access_count = 0). */
      neverAccessed: number;
      /** Total reads across all active rows. */
      totalAccess: number;
      /** Mean access_count over active rows (0 when empty). */
      meanAccess: number;
      /** Retired rows carrying an explicit supersedes edge out (superseded_by set). */
      supersededEdges: number;
    };
    /** True when rows exist but none was ever recalled — the dead-store smell. */
    suspicious: {
      neverAccessedRatio: number;
      possibleEmbedderMismatch: boolean;
      /** This store is empty while a sibling in the same directory holds memories. */
      emptyWhileSiblingsFull: boolean;
    };
    /**
     * Working-memory gate usage for this process: turns asked, turns that
     * cleared nothing, turns that ended up showing a labelled guess instead.
     * `misses / turns` is the recall hit-rate; `guesses` says how much of the
     * non-miss output was a hunch. Never persisted — scope is 'process'.
     */
    coverage: { turns: number; misses: number; guesses: number; scope: 'process' };
    /**
     * The other store files next to this one — the memories this process
     * cannot see. An empty recall is otherwise indistinguishable from "this
     * project never wrote anything", which is how a per-directory/per-agent
     * store split reads to both host and user.
     */
    sibling_stores: { dir: string; stores: StoreSurveyEntry[]; unreadable: string[] };
    /** The scoping contract, verbatim from the engine, so no adapter paraphrases it. */
    scope_rule: string;
  } {
    const rows = this.db.allActive();
    const dimHist = new Map<number, number>();
    for (const r of rows) {
      const b = vecFromBlob(r.vec);
      if (!b) continue;
      dimHist.set(b.length, (dimHist.get(b.length) ?? 0) + 1);
    }
    const storedDims = Array.from(dimHist.entries())
      .map(([dim, n]) => ({ dim, rows: n }))
      .sort((a, b) => b.rows - a.rows);
    const currentDim = this.embedder?.dim ?? 512;
    const dimMismatch = rows.length > 0 && storedDims.length > 0 && !storedDims.some((d) => d.dim === currentDim);
    const neverAccessed = rows.filter((r) => r.access_count === 0).length;
    const totalAccess = rows.reduce((s, r) => s + r.access_count, 0);
    // Retired rows only: a row carrying an outbound supersedes edge is always
    // superseded = 1, so counting over allActive() could only ever yield 0.
    const supersededEdges = this.db.countSupersededEdges();
    const neverAccessedRatio = rows.length === 0 ? 0 : neverAccessed / rows.length;
    // ':memory:' has no directory to survey — and dirname() of it is '.', which
    // would hand status a listing of whatever the process happened to start in.
    const siblings =
      this.dbPath === ':memory:'
        ? { dir: ':memory:', stores: [], unreadable: [] }
        : surveyStores(dirname(this.dbPath), { current: this.dbPath });
    // The signature of a store split: this file reads empty while a neighbour
    // in the same directory is full. Everything else in status then looks
    // healthy, which is exactly why it needs its own name.
    const emptyWhileSiblingsFull =
      rows.length === 0 && siblings.stores.some((s) => !s.current && s.rows > 0);
    return {
      store_path: this.dbPath,
      embedder: {
        kind: this.embedder ? 'model' : 'hashing',
        dim: currentDim,
        storedDims,
        dimMismatch
      },
      thresholds: {
        similarity: this.options.similarityThreshold,
        nearDuplicate: this.options.nearDuplicateThreshold,
        contradiction: this.options.contradictionThreshold,
        claim: this.options.claimThreshold,
        minImportance: this.options.minImportance
      },
      activity: { neverAccessed, totalAccess, meanAccess: rows.length === 0 ? 0 : totalAccess / rows.length, supersededEdges },
      suspicious: {
        neverAccessedRatio,
        possibleEmbedderMismatch: dimMismatch,
        emptyWhileSiblingsFull
      },
      coverage: { ...this.digestCoverage, scope: 'process' as const },
      sibling_stores: siblings,
      scope_rule: SCOPE_RULE
    };
  }

  /** Newest-first inventory of active memories (introspection / GUI browsing). */
  list(limit = 50): StoredMemory[] {
    return this.db
      .allActive()
      .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map((r) => rowToMemory(r, false));
  }

  get(id: string): StoredMemory | undefined {
    const row = this.db.getById(id);
    if (!row || row.superseded === 1) return undefined;
    return rowToMemory(row, false);
  }

  history(id: string): { version: number; summary: string; detail?: string; scope?: string; entities?: string[]; verifyResult?: 'pass' | 'fail'; archivedAt: string }[] {
    return this.db.historyOf(id).map((h) => ({
      version: Number(h.version),
      summary: h.summary as string,
      detail: (h.detail as string | null) ?? undefined,
      scope: (h.scope as string | null) ?? undefined,
      entities: h.entities_json ? (JSON.parse(h.entities_json as string) as string[]) : undefined,
      verifyResult: (h.verify_result as string | null) === 'pass' || (h.verify_result as string | null) === 'fail'
        ? (h.verify_result as 'pass' | 'fail')
        : undefined,
      archivedAt: h.archived_at as string
    }));
  }

  close(): void {
    this.db.close();
  }
}

/* ------------------------------------------------------------------ */

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Spaced-repetition rehearsal boost (Bjork's desirable-difficulty finding:
 * retrievals spread over time strengthen a trace far more than massed
 * repetition). The gain grows logarithmically with the gap since the last
 * access — restating a fact a week later is worth ~8× an immediate re-tell —
 * and stays bounded so old memories cannot ratchet to 1.0 in a few hits.
 *
 * gapMs <= 0 (never accessed / same instant): minimal +0.01.
 */
function rehearsalBoost(lastAccessAt: string | null | undefined, nowMs: number): number {
  if (!lastAccessAt) return 0.01;
  const gapMs = nowMs - Date.parse(lastAccessAt);
  if (!Number.isFinite(gapMs) || gapMs <= 0) return 0.01;
  const gapDays = gapMs / (24 * 60 * 60 * 1000);
  return Math.min(0.12, 0.01 + 0.03 * Math.log2(1 + gapDays));
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function importanceFromConfidence(c: 'high' | 'medium' | 'low' | 'speculative'): number {
  switch (c) {
    case 'high':
      return 0.7;
    case 'medium':
      return 0.5;
    case 'low':
      return 0.35;
    case 'speculative':
      return 0.2;
  }
}

/**
 * Rule extraction for consolidation. Episodes that already read like rules
 * are kept verbatim; otherwise we wrap the core claim as a semantic fact.
 * (A production build would run this through the LLM itself.)
 */
function abstractToRule(mem: StoredMemory): string | null {
  if (mem.kind !== 'episode') return null;
  const s = mem.summary;
  if (/(always|never|usually|prefers|is |are |uses|requires|depends on|works with|fact:)/i.test(s)) return s;
  return `FACT: ${s}`;
}

/**
 * Split a structured claim of the form "<subject> -> <value>" (or the
 * free-form variant "<subject> is/are/uses ... <value>" as written by
 * `remember` with a semantic payload). Returns null when the summary is not
 * structured, so free-form episodes fall back to cosine logic.
 */
function claimParts(summary: string): { subject: string; value: string } | null {
  const arrow = summary.match(/^\s*(.+?)\s*->\s*(.+?)\s*$/);
  if (arrow) return { subject: arrow[1]!.trim().toLowerCase(), value: arrow[2]!.trim().toLowerCase() };
  const copula = summary.match(/^\s*(.+?)\s+(?:is|are|uses|runs on|backed by|hosted by|stored in|written in)\s+(?:the\s+|an?\s+)?(.+?)\s*$/i);
  if (copula) return { subject: copula[1]!.trim().toLowerCase(), value: copula[2]!.trim().toLowerCase() };
  return null;
}

/** Strip the consolidation wrapper so "FACT: X" compares equal to "X". */
function stripAbstractPrefix(s: string): string {
  return s.replace(/^\s*(?:fact|rule)\s*:\s*/i, '');
}

/** Connectives that carry no premise information inside a scope value. */
const SCOPE_STOP = new Set(['a', 'an', 'the', 'of', 'to', 'is', 'are', 'in', 'at', 'on', 'for', 'by', 'with', 'and', 'or', 'as', 'per']);

/**
 * Scope terms: latin/digit runs kept whole, CJK split per character so a
 * reworded Chinese premise still overlaps (the hashing embedder keeps a CJK
 * run whole, which would make any paraphrase look like a new premise),
 * stopwords dropped.
 */
function scopeTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9._+-]*|[一-鿿]/g) ?? []).filter((t) => !SCOPE_STOP.has(t));
}

/** `key=value; key=value` (or `key:value`, comma/newline separated) → key → terms. */
function scopePairs(s: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const seg of s.split(/[;,\n]/)) {
    const t = seg.trim();
    if (!t) continue;
    const eq = t.match(/^([^=:]+)[=:](.*)$/);
    const key = normalizeText(eq ? eq[1] ?? '' : t);
    if (!key) continue;
    const terms = scopeTokens(eq ? eq[2] ?? '' : t);
    out.set(key, out.has(key) ? [...out.get(key)!, ...terms] : terms);
  }
  return out;
}

/**
 * Two values of the same premise key. Compatible when one restates the other
 * (subset — "instruction start" vs "instruction start of the lea-rsp site")
 * or they overlap by half; a reworded premise must not read as a new one.
 */
function scopeValuesCompatible(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true; // nothing stated to disagree with
  const sa = new Set(a);
  const sb = new Set(b);
  const smaller = sa.size <= sb.size ? sa : sb;
  const larger = smaller === sa ? sb : sa;
  if ([...smaller].every((t) => larger.has(t))) return true;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union > 0 && inter / union >= 0.5;
}

/**
 * Keys both premises name while holding different values — the disagreement
 * evidence. Empty when either side states no premise: an unstated condition
 * is not a contradiction (it is reported as an unchecked premise instead).
 */
function scopeDifferences(a?: string | null, b?: string | null): string[] {
  if (!a || !b) return [];
  const pa = scopePairs(a);
  const pb = scopePairs(b);
  const differing: string[] = [];
  for (const [key, terms] of pa) {
    const other = pb.get(key);
    if (!other) continue;
    if (!scopeValuesCompatible(terms, other)) differing.push(key);
  }
  return differing;
}

/**
 * Literal-token overlap between cue and summary. Identifiers (hex addresses,
 * ticket/decision ids, commit shas, versions) survive verbatim in memory
 * summaries, and an exact match is far stronger evidence than cosine — which
 * underrates them, especially for short CJK queries. Returns the count of
 * distinct identifier tokens shared by both.
 */
function literalOverlap(cue: string, summary: string): number {
  const tokens = (s: string) =>
    new Set(
      (s.match(/\b(?:0x[0-9a-f]{3,}|[A-Z]{1,3}-\d{1,5}\b|[0-9a-f]{7,40}\b|v?\d+\.\d+(?:\.\d+)?)\b/gi) ?? []).map((t) =>
        t.toLowerCase()
      )
    );
  const a = tokens(cue);
  if (a.size === 0) return 0;
  const b = tokens(summary);
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared;
}
