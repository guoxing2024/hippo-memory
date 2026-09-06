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
  type ConflictOutcome,
  type ConsolidationCandidate,
  type EmbeddingProvider,
  type MemoryPayload,
  type RecallBundle,
  type RetrievedMemory,
  type RetrievalCue,
  type StoredMemory,
  type StoreOptions,
  nowIso
} from './schema.js';
import { SqliteStore, vecFromBlob, vecToBlob, type MemoryRow } from './sqlite.js';
import { cosine, embedHashing } from './vectors.js';

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
    confidence: row.confidence,
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessAt: row.last_access_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    superseded: row.superseded === 1,
    embedding: withEmbedding ? (vecFromBlob(row.vec) ?? undefined) : undefined
  };
}

const NEGATION_RE = /\b(not|never|no longer|doesn'?t|isn'?t|aren'?t|no|none|dislike|reject|deny|stopped|quit)\b/i;

export class HippoMemory {
  readonly db: SqliteStore;
  readonly options: Required<StoreOptions>;
  private embedder: EmbeddingProvider | null = null;

  constructor(opts: { dbPath: string; options?: StoreOptions }) {
    this.db = new SqliteStore(opts.dbPath);
    this.options = { ...DEFAULT_OPTIONS, ...opts.options };
  }

  /** Attach (or replace) a real embedding provider. */
  setEmbedder(e: EmbeddingProvider): void {
    this.embedder = e;
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
    const names = (p.entities ?? []).map((e) => e.name.trim()).filter(Boolean);
    return Array.from(new Set(names.map((n) => n.toLowerCase())));
  }

  /* ============================ write path ============================ */

  /**
   * Hippocampal write. Resolution order:
   *   1. near-duplicate of the same kind        → strengthen (no new trace)
   *   2. near-duplicate semantic of another kind → merge into the semantic
   *   3. near-contradiction on the same event/entity scope (same kind)
   *                                            → versioned override (archive old)
   *   4. otherwise                             → new sparse trace
   */
  async remember(payload: MemoryPayload): Promise<{ outcome: ConflictOutcome; memory: StoredMemory }> {
    const summary = payload.summary.trim();
    if (!summary) throw new Error('remember: summary is required');

    const entities = this.entityNames(payload);
    const tags = Array.from(new Set((payload.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)));
    const contentText = [summary, payload.detail ?? '', payload.episode?.place ?? '', payload.episode?.time ?? '', payload.semantic?.rule ?? '', ...entities].join('\n');
    const vec = await this.embedOne(contentText);

    const confidence = payload.confidence ?? 'high';
    const importance = clamp01(payload.importance ?? importanceFromConfidence(confidence));
    const now = nowIso();

    // ---- pattern separation: scan existing traces ----
    const candidates = this.db.allActive().map((r) => {
      const b = vecFromBlob(r.vec);
      return { r, sim: b && b.length === vec.length ? cosine(b, vec) : 0 };
    });

    const sameKind = candidates.filter((x) => x.r.kind === payload.kind).sort((a, b) => b.sim - a.sim);
    const closest = sameKind[0];

    // 0. structured claim ("<subject> -> <value>") → attribute binding.
    //    The same subject is ONE engram: same value = rehearsal; a different
    //    value = correction (reconsolidation → versioned override). This is
    //    deliberately independent of cosine: pattern separation must not let
    //    a value flip escape as "a similar new memory".
    const newClaim = claimParts(summary);
    if (newClaim) {
      for (const { r } of sameKind) {
        const oldClaim = claimParts(r.summary);
        if (!oldClaim || oldClaim.subject !== newClaim.subject) continue;
        if (oldClaim.value === newClaim.value) {
          const imp = Math.min(1, r.importance + 0.03);
          this.db.update({ ...r, importance: imp, updated_at: now });
          return { outcome: 'none', memory: rowToMemory(this.db.getById(r.id)!, false) };
        }
        // Distinct real-world events on the same subject (e.g. a key rotated
        // on two different days) stay separate — only semantic/procedure
        // claims and same-event episodes get overridden.
        const windowOk = r.kind === 'semantic' || r.kind === 'procedure' || this.sameEventWindowMs(payload, r);
        if (!windowOk) continue;
        const res = await this.update(r.id, {
          summary,
          detail: payload.detail,
          episode: payload.episode,
          semantic: payload.semantic,
          entities: payload.entities,
          tags: payload.tags,
          occurredAt: payload.occurredAt,
          source: payload.source,
          confidence
        });
        return { outcome: 'override', memory: res.memory };
      }
    }

    // 1. verbatim re-tell of the same claim → rehearsal, strengthen only
    const isRetell =
      closest !== undefined && normalizeText(closest.r.summary) === normalizeText(summary);
    if (closest && isRetell) {
      const imp = Math.min(1, closest.r.importance + 0.03);
      this.db.update({ ...closest.r, importance: imp, updated_at: now });
      return { outcome: 'none', memory: rowToMemory(this.db.getById(closest.r.id)!, false) };
    }

    // 2. cross-kind merge: an episodic re-tell of an existing semantic rule
    if (payload.kind === 'episode') {
      const nearSemantic = candidates.find(
        (x) =>
          x.r.kind === 'semantic' &&
          x.sim >= this.options.nearDuplicateThreshold &&
          normalizeText(x.r.summary) === normalizeText(summary)
      );
      if (nearSemantic) {
        const imp = Math.min(1, nearSemantic.r.importance + 0.01);
        this.db.update({ ...nearSemantic.r, importance: imp, updated_at: now });
        return { outcome: 'merge', memory: rowToMemory(this.db.getById(nearSemantic.r.id)!, false) };
      }
    }

    // 3. near-contradiction on the same event/scope → versioned override.
    //    (Human analog: reconsolidation — the old trace is archived, not erased.)
    const sharesScope =
      entities.length === 0 || closest === undefined || closest.r.entities_json === '[]' ||
      entities.some((e) => JSON.parse(closest.r.entities_json).includes(e));
    if (
      closest &&
      !isRetell &&
      closest.sim >= this.options.contradictionThreshold &&
      sharesScope &&
      this.sameEventWindowMs(payload, closest.r)
    ) {
      const res = await this.update(closest.r.id, {
        summary,
        detail: payload.detail,
        episode: payload.episode,
        semantic: payload.semantic,
        entities: payload.entities,
        tags: payload.tags,
        occurredAt: payload.occurredAt,
        source: payload.source,
        confidence
      });
      return { outcome: 'override', memory: res.memory };
    }

    // 4. new trace
    const id = randomUUID();
    const row = this.buildRow({
      id,
      version: 1,
      kind: payload.kind,
      summary,
      detail: payload.detail,
      episode: payload.episode,
      semantic: payload.semantic,
      entities,
      tags,
      occurredAt: payload.occurredAt ?? (payload.kind === 'episode' ? now : undefined),
      source: payload.source,
      confidence,
      importance,
      createdAt: now,
      updatedAt: now,
      vec
    });
    this.db.insert(row);
    return { outcome: 'new', memory: rowToMemory(row, false) };
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
      confidence: a.confidence,
      importance: a.importance,
      access_count: 0,
      last_access_at: null,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
      superseded: 0,
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
  async recall(cue: RetrievalCue, limit = 5): Promise<RecallBundle> {
    const q = cue.query.trim();
    if (!q) return { hits: [], warnings: [], scanned: 0 };

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
    let scanned = 0;

    for (const r of rows) {
      const b = vecFromBlob(r.vec);
      if (!b || b.length !== cueVec.length) continue;
      const sim = cosine(b, cueVec);
      if (sim < minSim) continue;
      scanned++;

      const mem = rowToMemory(r, false);
      if (exclude.has(mem.id)) continue;
      if (cue.kind && mem.kind !== cue.kind) continue;
      if (mem.importance < minImportance) continue;
      if (sinceMs && mem.lastAccessAt && Date.parse(mem.lastAccessAt) < sinceMs) continue;
      if (occurredSinceMs && mem.occurredAt && Date.parse(mem.occurredAt) < occurredSinceMs) continue;
      if (entityFilter.length && !entityFilter.every((e) => mem.entities.includes(e))) continue;

      hits.push({ ...mem, score: sim, consolidated: mem.kind === 'semantic' });
    }

    // Rank: similarity × (0.6 + 0.4·importance)
    const ranked = hits
      .map((h) => ({ ...h, score: h.score * (0.6 + 0.4 * h.importance) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Conflict warnings: any *newer revision* of the same entity scope with a
    // different claim than the top hit? (stale-trace detector)
    const top = ranked[0];
    if (top) {
      const topEntities = new Set(top.entities);
      const overrides = hits
        .filter((m) => m.id !== top.id && m.version > top.version && m.entities.some((e) => topEntities.has(e)) && m.summary !== top.summary)
        .sort((a, b) => b.version - a.version);
      if (overrides.length) {
        warnings.push(
          `conflict: newer revision(s) exist for the same scope — ${overrides
            .map((o) => `"${o.summary.slice(0, 60)}" (v${o.version}, ${o.updatedAt})`)
            .join('; ')}`
        );
      }
    }

    // Mark retrieved traces as accessed (usage feedback for consolidation).
    const at = nowIso();
    for (const h of ranked) {
      const row = this.db.getById(h.id);
      if (row) this.db.touchAccess(h.id, row.access_count + 1, at);
    }

    return { hits: ranked, warnings, scanned };
  }

  /* ============================ consolidation ============================ */

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

  /* ============================ source monitoring ============================ */

  /**
   * Prefrontal stand-in for the agent's "should I assert this?" check.
   * Returns one of three verdicts:
   *   substantiated   → the store supports the claim (with the backing trace)
   *   contradicted    → the store holds the opposite on the same scope
   *   unsubstantiated → nothing matches — do NOT assert from memory.
   */
  async sourceMonitor(claim: string): Promise<{
    substantiated: boolean;
    contradicted: boolean;
    support?: { id: string; summary: string; source?: string; confidence: string; version: number; score: number };
    contradiction?: { id: string; summary: string; source?: string; confidence: string; version: number; score: number };
    note: string;
  }> {
    const cueVec = await this.embedOne(claim);
    const claimNegated = NEGATION_RE.test(claim);
    const rows = this.db.allActive();
    let best: { id: string; summary: string; source?: string; confidence: string; version: number; score: number } | undefined;
    let bestSim = 0;

    for (const r of rows) {
      const b = vecFromBlob(r.vec);
      if (!b || b.length !== cueVec.length) continue;
      const sim = cosine(b, cueVec);
      if (sim <= bestSim) continue;
      const mem = rowToMemory(r, false);
      best = { id: mem.id, summary: mem.summary, source: mem.source, confidence: mem.confidence, version: mem.version, score: sim };
      bestSim = sim;
    }

    if (!best || bestSim < this.options.similarityThreshold) {
      return {
        substantiated: false,
        contradicted: false,
        note: `UNSUBSTANTIATED: no stored trace matches this claim (best similarity ${bestSim.toFixed(2)} < ${this.options.similarityThreshold}). Do NOT assert it from memory; answer "I don't know / not in my memory".`
      };
    }

    // Negation heuristic: claim negates while the stored trace affirms (or
    // vice versa) on a strongly similar scope → likely contradiction.
    // The similarity bar is deliberately below the substantiation bar:
    // a negated claim about a topic the store DOES know should never be
    // rubber-stamped just because cosine lands in a grey zone.
    const storedNegated = NEGATION_RE.test(best.summary);
    if (claimNegated !== storedNegated && bestSim >= this.options.similarityThreshold) {
      return {
        substantiated: false,
        contradicted: true,
        contradiction: best,
        note: `CONTRADICTED: memory asserts the opposite scope (${best.summary.slice(0, 80)} [v${best.version}]). Do not state the claim without flagging this conflict.`
      };
    }

    return {
      substantiated: true,
      contradicted: false,
      support: best,
      note: `SUBSTANTIATED: matches ${best.id} (v${best.version}, sim ${bestSim.toFixed(2)})`
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
        items.push({ ...mem, score: 0.5, consolidated: false });
      }
      warnings.push('includeRecent: appended recent traces not directly goal-relevant');
    }

    const lines = items.slice(0, limit).map((m, i) => {
      const prov = m.source ? ` [source: ${m.source}]` : '';
      const conf = m.confidence === 'high' ? '' : ` [conf:${m.confidence}]`;
      const kind = `[${m.kind}${m.consolidated ? '/semantic' : ''}]`;
      const occ = m.occurredAt ? ` (at ${m.occurredAt})` : '';
      return `${i + 1}. ${kind}${prov}${conf}${occ} v${m.version} ${m.summary}`;
    });
    return { context: lines.join('\n'), items: items.slice(0, limit), warnings };
  }

  /* ============================ introspection ============================ */

  stats(): { active: number; episodes: number; semantics: number; procedures: number; historyRows: number } {
    const rows = this.db.allActive();
    const count = (k: string) => rows.filter((r) => r.kind === k).length;
    return {
      active: rows.length,
      episodes: count('episode'),
      semantics: count('semantic'),
      procedures: count('procedure'),
      historyRows: rows.reduce((s, r) => s + r.version - 1, 0)
    };
  }

  get(id: string): StoredMemory | undefined {
    const row = this.db.getById(id);
    if (!row || row.superseded === 1) return undefined;
    return rowToMemory(row, false);
  }

  history(id: string): { version: number; summary: string; archivedAt: string }[] {
    return this.db.historyOf(id).map((h) => ({
      version: Number(h.version),
      summary: h.summary as string,
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
