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
  type WriteNeighbour,
  nowIso
} from './schema.js';
import { SqliteStore, vecFromBlob, vecToBlob, type MemoryRow } from './sqlite.js';
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
    verifiedAt: row.verified_at ?? undefined,
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

const NEGATION_RE = /\b(not|never|no longer|doesn'?t|isn'?t|aren'?t|no|none|dislike|reject|deny|stopped|quit)\b|[不没未非](?![a-z0-9])|((?:与|和|跟|同)[^，。,]{0,12}(?:无关|无涉|独立|不同))|(?:推翻|否证|改口)(?:了|为)?|(?:否定|排除|更正)(?:了|为|:|：)|(错误\d*)/i;

export class HippoMemory {
  readonly db: SqliteStore;
  readonly options: Required<StoreOptions>;
  private embedder: EmbeddingProvider | null = null;
  /** Store file path (exposed via diagnostics for observability). */
  private readonly dbPath: string;

  /**
   * @param opts.createFile  false = open lazily: a store whose file does not
   *                         exist yet is held in memory until the first write
   *                         (default true, the historical eager behaviour).
   */
  constructor(opts: { dbPath: string; options?: StoreOptions; createFile?: boolean }) {
    this.db = new SqliteStore(opts.dbPath, { create: opts.createFile !== false });
    this.options = { ...DEFAULT_OPTIONS, ...opts.options };
    this.dbPath = opts.dbPath;
  }

  /** Attach (or replace) a real embedding provider. */
  setEmbedder(e: EmbeddingProvider): void {
    this.embedder = e;
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
      return [r.summary, r.detail ?? '', r.episode_place ?? '', r.rule ?? '', ...guardBits, ...entities].join('\n');
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
        retracts: row.retracts,
        guard_json: row.guard_json,
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
    // without passing evidence is stored as an unverified episode, not a
    // rule. Bare prose that merely mentions numbers ("release 2.1 shipped
    // Tuesday") keeps its declared kind — version strings and counts are
    // not assertions of value.
    let kind = payload.kind;
    let downgraded: string | undefined;
    if (kind === 'semantic' && /\d/.test(summary) && claimParts(summary) && payload.verifyResult !== 'pass') {
      kind = 'episode';
      downgraded =
        'downgraded: semantic→episode — numeric claim without passing evidence is stored as an unverified episode, not a rule';
    }
    const guard = payload.guard && payload.guard.trigger?.trim() && payload.guard.action?.trim()
      ? { trigger: payload.guard.trigger.trim(), action: payload.guard.action.trim() }
      : undefined;
    const contentText = [
      summary, payload.detail ?? '', payload.episode?.place ?? '', payload.episode?.time ?? '',
      payload.semantic?.rule ?? '', ...(guard ? [guard.trigger, guard.action] : []), ...entities
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
        verifiedAt: verifiedAt,
        retracts: payload.retracts,
        guard,
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
          this.db.update({ ...r, importance: imp, updated_at: now });
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
        // Evidence shield (suggestion 2 + 保鲜期): a freshly-VERIFIED
        // incumbent is retired only by a challenger that also passes
        // evidence. Stale evidence (past TTL or unstamped) no longer shields:
        // re-run the check to refresh verifiedAt. Otherwise both rows are
        // kept and the caller is told how to force the replacement.
        if (
          evidenceFresh(r.verify_result, r.verified_at, nowMs, this.options.evidenceTtlSec) &&
          payload.verifyResult !== 'pass'
        ) {
          shielded =
            `shielded: existing VERIFIED row ${r.id.slice(0, 8)} (v${r.version}) — "` +
            `${sanitizeMemoryText(r.summary).slice(0, 60)}" was NOT retired by this unverified write; both rows are kept. ` +
            `To replace it, re-run its evidence and pass verifyResult:'pass' (or supersedes:[id] to force).`;
          break;
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
    if (closest && isRetell) {
      const imp = Math.min(1, closest.r.importance + rehearsalBoost(closest.r.last_access_at, Date.parse(now)));
      this.db.update({ ...closest.r, importance: imp, updated_at: now });
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
        if (normalizeText(stripAbstractPrefix(x.r.summary)) !== newBody) return false;
        if (((x.r.detail ?? '') as string).trim() !== newDetail) return false;
        const rowEnts = JSON.parse(x.r.entities_json || '[]') as string[];
        return rowEnts.length === entities.length && rowEnts.every((e) => newEnts.has(e.toLowerCase()));
      });
      if (nearSemantic) {
        const imp = Math.min(1, nearSemantic.r.importance + 0.01 + rehearsalBoost(nearSemantic.r.last_access_at, Date.parse(now)));
        this.db.update({ ...nearSemantic.r, importance: imp, updated_at: now });
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
    // Path-3 side of the evidence shield (same rule as path-0): a freshly
    // VERIFIED incumbent prose row is not retired by an unverified challenger.
    if (
      closest &&
      !isRetell &&
      !isRetraction &&
      !isRetractionRow(closest.r) &&
      !shielded &&
      closest.sim >= this.options.contradictionThreshold &&
      sharesScope &&
      (sameSubject || oppositePolarity) &&
      this.sameEventWindowMs(payload, closest.r) &&
      evidenceFresh(closest.r.verify_result, closest.r.verified_at, nowMs, this.options.evidenceTtlSec) &&
      payload.verifyResult !== 'pass'
    ) {
      shielded =
        `shielded: existing VERIFIED row ${closest.r.id.slice(0, 8)} (v${closest.r.version}) — "` +
        `${sanitizeMemoryText(closest.r.summary).slice(0, 60)}" was NOT retired by this unverified write; both rows are kept. ` +
        `To replace it, re-run its evidence and pass verifyResult:'pass' (or supersedes:[id] to force).`;
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
      verifiedAt: verifiedAt,
      retracts: payload.retracts,
      guard,
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
    const notesWarning = withNotes(shielded, blockedWarning, withheldContradiction);
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
        retracts: payload.retracts !== undefined ? payload.retracts : row.retracts,
        guard_json: payload.guard !== undefined ? JSON.stringify(payload.guard) : row.guard_json,
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
    verifiedAt?: string;
    retracts?: string;
    guard?: MemoryPayload['guard'];
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
      retracts: a.retracts ?? null,
      guard_json: a.guard ? JSON.stringify(a.guard) : null,
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

      const rule = abstractToRule(mem);
      if (!rule) continue;
      const rowVec = vecFromBlob(row.vec);
      let already = false;
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
      if (already) continue;

      const id = randomUUID();
      const now = nowIso();
      const vec = await this.embedOne(rule);
      const semRow = this.buildRow({
        id,
        version: 1,
        kind: 'semantic',
        summary: rule,
        detail: `consolidated from episode ${mem.id}`,
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
  forget(opts: { strengthFloor?: number; now?: string; dryRun?: boolean; force?: boolean } = {}): { forgotten: string[]; decayed: string[] } {
    const strengthFloor = opts.strengthFloor ?? 0.25;
    const nowMs = Date.parse(opts.now ?? nowIso());
    const forgotten: string[] = [];
    const decayed: string[] = [];

    for (const row of this.db.allActive()) {
      // Folded detail is already out of recall; deleting it would destroy the
      // expandable detail its invariant points at. Leave it alone.
      if (row.demoted === 1) continue;
      const mem = rowToMemory(row, false);
      const strength = mem.importance * (0.5 + 0.5 * Math.min(1, mem.accessCount / 5));
      if (strength >= strengthFloor) continue;
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
    return { forgotten, decayed };
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
   * stored so a caller can review before deleting anything.
   */
  duplicates(): { groups: { key: string; memories: { id: string; kind: MemoryKind; version: number; summary: string }[] }[]; scanned: number } {
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
      .map(([key, list]) => ({
        key: key.slice(0, 120),
        memories: list
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((m) => ({ id: m.id, kind: m.kind, version: m.version, summary: m.summary }))
      }));
    return { groups, scanned: this.db.countActive() };
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
   */
  async sourceMonitor(claim: string): Promise<{
    substantiated: boolean;
    contradicted: boolean;
    support?: { id: string; summary: string; detail?: string; verifyResult?: 'pass' | 'fail'; verifiedAt?: string; source?: string; confidence: string; version: number; score: number } | null;
    contradiction?: { id: string; summary: string; detail?: string; verifyResult?: 'pass' | 'fail'; verifiedAt?: string; source?: string; confidence: string; version: number; score: number } | null;
    closest?: { id: string; summary: string; detail?: string; verifyResult?: 'pass' | 'fail'; verifiedAt?: string; source?: string; confidence: string; version: number; score: number } | null;
    /** Same-scope rows asserting the opposite polarity of the claim. */
    contradicting: RelatedTrace[];
    /** Newer rows sharing the claim's scope (the support may be stale). */
    newer_related: RelatedTrace[];
    /** Retired rows whose superseded_by points at a matched row. */
    superseded_matches: RelatedTrace[];
    /** True when the top support has a newer same-scope sibling. */
    stale_support: boolean;
    note: string;
  }> {
    const cueVec = await this.embedOne(claim);
    const claimNegated = this.polarityOf(claim);
    // Score every comparable row ONCE: the argmax pass and the related-row scan
    // below need the same cosine against the same cue vector. Keeping the pairs
    // around avoids decoding and re-computing the whole store a second time.
    const scored: { r: MemoryRow; sim: number }[] = [];
    for (const r of this.db.allActive()) {
      const b = vecFromBlob(r.vec);
      if (!b || b.length !== cueVec.length) continue;
      scored.push({ r, sim: cosine(b, cueVec) });
    }

    let best: { id: string; summary: string; detail?: string; verifyResult?: 'pass' | 'fail'; verifiedAt?: string; source?: string; confidence: string; version: number; score: number } | undefined;
    let bestSim = -1;
    for (const { r, sim } of scored) {
      if (sim <= bestSim) continue;
      const mem = rowToMemory(r, false);
      best = { id: mem.id, summary: sanitizeMemoryText(mem.summary), detail: mem.detail ? sanitizeMemoryText(mem.detail) : undefined, verifyResult: mem.verifyResult, verifiedAt: mem.verifiedAt, source: mem.source ? sanitizeMemoryText(mem.source) : undefined, confidence: mem.confidence, version: mem.version, score: sim };
      bestSim = sim;
    }

    if (!best || bestSim < this.options.similarityThreshold) {
      return {
        substantiated: false,
        contradicted: false,
        closest: best ?? null,
        contradicting: [],
        newer_related: [],
        superseded_matches: [],
        stale_support: false,
        note: `UNSUBSTANTIATED: no stored trace matches this claim (best similarity ${bestSim.toFixed(2)} < ${this.options.similarityThreshold}). Do NOT assert it from memory; answer "I don't know / not in my memory".`
      };
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
        contradiction: best,
        contradicting: bestRow ? [this.toRelated(bestRow, bestSim)] : [],
        newer_related: [],
        superseded_matches: [],
        stale_support: false,
        note: `CONTRADICTED: memory asserts the opposite scope (${best.summary.slice(0, 80)} [v${best.version}]). Do not state the claim without flagging this conflict.${infectedNote}`
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
    const claimClaim = claimParts(claim);
    const contradicting = related
      .filter(({ r }) => {
        const rowEntities = JSON.parse(r.entities_json || '[]') as string[];
        if (!this.entitiesOverlap(supportEntities, rowEntities)) return false;
        const rowClaim = claimParts(r.summary);
        const oppositePolarity = this.polarityOf(r.summary) !== claimNegated;
        const valueDisagrees =
          !!(supportClaim && rowClaim && rowClaim.subject === supportClaim.subject && rowClaim.value !== supportClaim.value) ||
          !!(claimClaim && rowClaim && rowClaim.subject === claimClaim.subject && rowClaim.value !== claimClaim.value);
        return oppositePolarity || valueDisagrees;
      })
      .map(({ r, sim }) => this.toRelated(r, sim));

    // (b) newer same-scope rows — the support may be stale
    const newerRelated = related
      .filter(({ r }) => (supportRow ? r.updated_at > supportRow.updated_at : false))
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
    for (const { id } of archiveRows) {
      const live = this.db.getById(id);
      const liveNorm = live ? normalizeText(stripAbstractPrefix(live.summary)) : null;
      const liveClaim = live ? claimParts(live.summary) : null;
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
        // in the related set; the score is re-measured, never invented.
        if (fuzzyLeft <= 0) continue;
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

    return {
      substantiated: true,
      contradicted: false,
      support: best,
      contradicting,
      newer_related: newerRelated,
      superseded_matches: supersededMatches,
      stale_support: staleSupport,
      note: `SUBSTANTIATED: matches ${best.id} (v${best.version}, sim ${bestSim.toFixed(2)}).${infectedNote}${staleNote}${contradictNote}${archiveNote}${fuzzyNote}${staleEvidenceNote}`
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
    opts: { limit?: number; includeRecent?: boolean; recentLimit?: number } = {}
  ): Promise<{ context: string; items: RetrievedMemory[]; warnings: string[] }> {
    const limit = opts.limit ?? 6;
    const rec = await this.recall({ query: goal }, limit);
    const items = [...rec.hits];
    const warnings = [...rec.warnings];

    // Fail-visible (suggestion 3): zero hits must render as a status line,
    // not as filler that looks alive. Backfilling [recent] rows here made
    // the channel read healthy while serving the last writes on every cue.
    if (opts.includeRecent && items.length === 0) {
      const n = this.db.countActive();
      warnings.push('includeRecent: no hits to supplement — recency buffer withheld so failure stays visible');
      warnings.push(`no hit cleared the threshold for this task (${n} stored)`);
      return {
        context: dataFrame(`(no memory above threshold for this task; ${n} stored)`),
        items,
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

    // Evidence + marker tags (suggestion 1/4/6): what the model asserts from
    // this block must show its standing — re-runnable truth, plain assertion,
    // prospective guard, or live retraction of the hit. VERIFIED requires
    // FRESH evidence (past-TTL proof renders ASSERTED until re-run).
    const tagNow = Date.now();
    const lines = items.slice(0, limit).map((m, i) => {
      const prov = m.source ? ` [source: ${sanitizeMemoryText(m.source)}]` : '';
      const conf = m.confidence === 'high' ? '' : ` [conf:${m.confidence}]`;
      const kind = `[${m.kind}${m.consolidated ? '/semantic' : ''}]`;
      const occ = m.occurredAt ? ` (at ${m.occurredAt})` : '';
      const standing =
        evidenceFresh(m.verifyResult, m.verifiedAt, tagNow, this.options.evidenceTtlSec)
          ? ' [VERIFIED]'
          : m.kind === 'semantic'
            ? ' [ASSERTED]'
            : '';
      const guardTag = m.tags.includes('guard') ? ' [GUARD]' : '';
      const recentTag = m.recent ? ' [recent]' : '';
      const retrTag = m.retracted ? ` [retracted: ${sanitizeMemoryText(m.retracted.criterion)}]` : '';
      return `${i + 1}. ${kind}${prov}${conf}${occ}${standing}${guardTag}${recentTag}${retrTag} v${m.version} ${sanitizeMemoryText(m.summary)}`;
    });
    // Injection guard: memory text is data the agent (or a page it read) once
    // wrote — never instructions. Sanitized per line, framed as a whole block.
    return { context: dataFrame(lines.join('\n')), items: items.slice(0, limit), warnings };
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
    suspicious: { neverAccessedRatio: number; possibleEmbedderMismatch: boolean };
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
        possibleEmbedderMismatch: dimMismatch
      }
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

  history(id: string): { version: number; summary: string; detail?: string; entities?: string[]; verifyResult?: 'pass' | 'fail'; archivedAt: string }[] {
    return this.db.historyOf(id).map((h) => ({
      version: Number(h.version),
      summary: h.summary as string,
      detail: (h.detail as string | null) ?? undefined,
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
