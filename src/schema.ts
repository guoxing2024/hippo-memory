/**
 * Core data model for hippo-memory.
 *
 * Analogy map (see docs/ARCHITECTURE.md for the full discussion):
 *   - episode        ~ an event trace in the hippocampus (a bound scene)
 *   - semantic        ~ consolidated cortex-like knowledge (systems consolidation)
 *   - encoding vector ~ the sparse DG code used for pattern separation
 */

export type MemoryKind = 'episode' | 'semantic' | 'procedure';

/** How confident the writer (the agent/user) was when the memory was formed. */
export type SourceConfidence = 'high' | 'medium' | 'low' | 'speculative';

export interface EntityRef {
  name: string;
  kind?: string;
}

export interface EpisodicContent {
  /** Event time, free-form. Use ISO string when available. */
  time?: string;
  /** Place, scene, code path, file, session scope... */
  place?: string;
  participants?: string[];
}

export interface SemanticContent {
  /** The generalizable statement (always non-empty for semantic memories). */
  rule: string;
}

export interface MemoryPayload {
  kind: MemoryKind;
  /** Natural-language description of what happened / what is known. */
  summary: string;
  /** Optional verbatim record of the raw facts (used by RAG stitching). */
  detail?: string;
  /** Episodic bindings. Required for kind === 'episode'. */
  episode?: EpisodicContent;
  /** Semantic rule. Required for kind === 'semantic'. */
  semantic?: SemanticContent;
  entities?: EntityRef[];
  tags?: string[];
  /** ISO timestamp of the real-world event, if known. */
  occurredAt?: string;
  /** Where this memory came from (provenance, used by source monitoring). */
  source?: string;
  /** Writer confidence. Defaults to 'high'. */
  confidence?: SourceConfidence;
  /** Salience 0..1 (defaults from confidence when omitted). */
  importance?: number;
  /**
   * Recheckable provenance (source monitoring): how to RE-RUN the claim.
   * The engine never executes `cmd` — the agent runs it and reports back
   * via `verifyResult`. Stored verbatim and rendered as [VERIFIED] when the
   * reported result passes.
   */
  verify?: { cmd?: string; expect?: string; artifact?: string };
  /** Agent-reported outcome of running `verify` (never self-assessed). */
  verifyResult?: 'pass' | 'fail';
  /**
   * Stated premises: the conditions this summary holds under — population,
   * comparator, measurement setup, release window. Written as `key=value`
   * segments separated by `;` (or `,`), e.g.
   * `population=all records; comparator=instruction start`.
   *
   * This exists because one sentence can be true under one setup and false
   * under another; a flat summary cannot carry that, so `verify` used to
   * substantiate an old-scope conclusion against a new-scope claim. `verify`
   * compares scopes structurally and answers OUT_OF_SCOPE when a shared key
   * holds another value. Distinct from "scope" in the conflict gates, which
   * means entity overlap.
   */
  scope?: string;
  /** ISO time the evidence was last executed. */
  verifiedAt?: string;
  /**
   * Retraction pointer: id of the memory this write retracts. Retractions
   * are conventionally tagged `retraction`; retraction rows can never be
   * overridden (only appended after), and hits on a retracted id render
   * with a [retracted] marker.
   */
  retracts?: string;
  /**
   * Prospective memory (implementation intention): `trigger` is the future
   * situation, `action` what to do there. Conventionally tagged `guard`;
   * matched cue-side and boosted at recall.
   */
  guard?: { trigger: string; action: string };
  /**
   * Explicit correction edges: ids of existing memories this write supersedes.
   * The listed rows get superseded = 1 (retired, kept for audit) and a
   * superseded_by pointer to this new row; verify/recall surface the newer
   * conclusion instead of the retired one. This is the escape hatch for
   * corrections whose wording differs too much for cosine-based conflict
   * detection to catch (measured: ~0.60 similarity vs. the 0.86 bar).
   */
  supersedes?: string[];
  /**
   * Attested evidence (audit #5): set true only when the caller actually
   * executed `verify.cmd` (or an equivalent reproducible check) in an
   * environment the engine can reason about — CI run id, command exit code,
   * artifact hash. When true AND verifyResult==='pass', the row earns the
   * full VERIFIED standing (renders `[VERIFIED]`, shields against retirement
   * by unverified writes). When false/omitted, a reported pass is honest but
   * self-asserted: it renders `[VERIFIED self-reported]` and the retirement
   * shield degrades to a visible warning — the engine never executes
   * commands, so it must not let an unverifiable badge guard data.
   */
  verifyAttested?: boolean;
}

export interface StoredMemory {
  id: string;
  version: number;
  kind: MemoryKind;
  summary: string;
  detail?: string;
  episode?: EpisodicContent;
  semantic?: SemanticContent;
  entities: string[];
  tags: string[];
  occurredAt?: string;
  source?: string;
  confidence: SourceConfidence;
  importance: number; // 0..1
  accessCount: number;
  lastAccessAt?: string;
  createdAt: string;
  updatedAt: string;
  embedding?: number[]; // filled only when requested
  /** Whether this row represents a superseded/retired revision. */
  superseded: boolean;
  /** Id of the row that explicitly retired this one (explicit supersedes edge). */
  supersededBy?: string;
  /** Recheckable provenance: how to re-run the claim (see MemoryPayload). */
  verify?: { cmd?: string; expect?: string; artifact?: string };
  /** Agent-reported evidence outcome (never self-assessed). */
  verifyResult?: 'pass' | 'fail';
  /** Stated premises this summary holds under (see MemoryPayload.scope). */
  scope?: string;
  /** ISO time the evidence was last executed. */
  verifiedAt?: string;
  /** Id of the memory this row retracts (retraction rows). */
  retracts?: string;
  /** Prospective trigger/action pair (guard rows). */
  guard?: { trigger: string; action: string };
  /** Folded into an invariant (hidden from default recall, still live). */
  demoted: boolean;
  /** Invariant row this trace was folded into. */
  demotedTo?: string;
  /** See MemoryPayload.verifyAttested — attested vs self-reported evidence. */
  verifyAttested?: boolean;
}

export interface RetrievalCue {
  /** Free-text query / situation description used for semantic similarity. */
  query: string;
  /** Entity filter (AND). Matching is case-insensitive on exact names. */
  entities?: string[];
  /** Kind filter. */
  kind?: MemoryKind;
  /** Only memories touched at/after this ISO timestamp (recency gate). */
  since?: string;
  /** Only memories whose real-world occurredAt is at/after this ISO timestamp. */
  occurredSince?: string;
  /** Force exclusion of a given memory id (e.g. already used this turn). */
  excludeIds?: string[];
  /** Caller-specified importance floor [0..1] (defaults to the store threshold). */
  minImportance?: number;
  /** Include compress-demoted rows (default false: invariant covers them). */
  includeDemoted?: boolean;
  /**
   * Hard premise filter (audit #7/#8, convergent namespace step): rows whose
   * stored `scope` DISAGREES with this string on a shared key are excluded
   * from the result entirely (counted in `scopeExcluded`). Rows that state
   * no scope, or state compatible values, pass through — absence of a premise
   * is not a contradiction. Opt-in; the default read path stays unchanged.
   */
  scope?: string;
}

export interface RetrievedMemory extends StoredMemory {
  /** Ranking score: similarity × importance weighting (+ literal-token bonus). */
  score: number;
  /** Raw cosine similarity (threshold-comparable; same scale as memory_verify). */
  similarity: number;
  /** This hit's similarity ÷ the best similarity for this query (1.0 = best). */
  relativeScore: number;
  /** Number of shared literal identifier tokens (0x…, D-123, sha, version). */
  literalMatch?: number;
  /** True when the hit came from the consolidated semantic store. */
  consolidated: boolean;
  /** True when this hit came from the recency buffer, not goal-relevance. */
  recent?: boolean;
  /**
   * True when nothing cleared the similarity floor for this cue and this is the
   * closest trace, offered as a labelled guess rather than as a memory.
   */
  lowConfidence?: boolean;
  /** Set when a live retraction targets this hit (do-not-repeat flag). */
  retracted?: { by: string; criterion: string };
}

/** Why a recall returned what it did. */
export type RecallReason = 'ok' | 'no-candidates' | 'below-threshold' | 'empty-cue';

/** A related trace surfaced by verify for the caller to weigh. */
export interface RelatedTrace {
  id: string;
  summary: string;
  /** Verbatim detail when the stored row carries one (deep-recall payload). */
  detail?: string;
  source?: string;
  confidence: SourceConfidence;
  version: number;
  updatedAt: string;
  entities: string[];
  /** Raw cosine similarity to the claim / new memory. */
  similarity: number;
  /** Stated premises of this trace, when it declares any (see MemoryPayload.scope). */
  scope?: string;
  /** Agent-reported evidence outcome, when the row carries any. */
  verifyResult?: 'pass' | 'fail';
}

export interface RecallBundle {
  hits: RetrievedMemory[];
  /**
   * Problems with the RETRIEVED SET the caller must check before asserting:
   * a retrieved trace that disagrees with the top hit on an established
   * scope-key, or a hit whose text was injection-sanitized. Not a general
   * "these rows are related" channel — that is `nearDuplicates`.
   */
  warnings: string[];
  /** Number of rows whose vector was comparable to the cue (diagnostics). */
  scanned: number;
  /** Rows passing structural filters (kind/entities/importance/time). */
  eligible: number;
  /**
   * Rows dropped by the cue's hard scope filter (`RetrievalCue.scope`) because
   * their stated premise disagrees with the asked one. Present only when the
   * filter was given; its count keeps "filtered out" distinct from "absent".
   */
  scopeExcluded?: number;
  /** Best cosine seen among eligible rows (null when none was comparable). */
  bestSimilarity: number | null;
  /** Similarity floor in force for this query. */
  threshold: number;
  /** 'ok' | 'no-candidates' (nothing stored/filtered) | 'below-threshold' | 'empty-cue'. */
  reason: RecallReason;
  /** Closest sub-threshold rows (best first) so an empty result is explainable. */
  nearMisses: { id: string; summary: string; similarity: number }[];
  /**
   * Retrieved rows that are NOT conflicts but overlap the top hit.
   *
   * Boundary (field report, 5th round — this field was ambiguous and twice
   * mis-sized): it answers "does another RETRIEVED row say the SAME THING as
   * the top hit for this cue?", i.e. near-identical restatements inside the
   * current result set. It is NOT "near-duplicates anywhere in the store"
   * (use `duplicates()` for that) and NOT "rows related to the cue" (that is
   * what `hits` already is). The gate compares rows to each other at
   * nearDuplicateThreshold; rows that merely share a topic are excluded.
   */
  nearDuplicates: { id: string; summary: string; similarity: number; reason: string }[];
}

export interface ConsolidationCandidate {
  id: string;
  kind: MemoryKind;
  summary: string;
  detail?: string;
  entities: string[];
  importance: number;
  accessCount: number;
  ageMs: number;
}

/**
 * Caller-authored compression plan (S5): fold N same-scope traces into one
 * invariant. The engine validates (members exist, live, unfoldable;
 * representatives ⊆ members) and applies — it never authors the invariant
 * text itself (plugin exposes, downstream judges).
 */
export interface CompressPlan {
  invariant: {
    summary: string;
    detail?: string;
    entities?: EntityRef[];
    tags?: string[];
    source?: string;
  };
  /** Live, non-demoted, non-retired member ids to fold. */
  members: string[];
  /** Members that stay visible (must be a subset of members). */
  representatives?: string[];
}

/** One applied compression: what was folded where. */
export interface CompressResult {
  invariantId: string;
  summary: string;
  /** Members left visible. */
  kept: string[];
  /** Members folded (hidden from default recall, expandable). */
  demoted: string[];
}

export type ConflictOutcome = 'none' | 'new' | 'override' | 'merge' | 'supersede';

/** A neighbour of the just-written memory, echoed back for the caller. */
export interface WriteNeighbour {
  id: string;
  kind: MemoryKind;
  summary: string;
  confidence: SourceConfidence;
  version: number;
  updatedAt: string;
  /** Raw cosine similarity to the written content. */
  similarity: number;
  /** True when this neighbour plausibly asserts the OPPOSITE of the new memory. */
  suspectedConflict: boolean;
}

export interface StoreOptions {
  /** Cosine threshold above which two vectors are considered near-duplicates. */
  nearDuplicateThreshold?: number;
  /**
   * Cosine threshold above which two vectors are considered a near-contradiction
   * (same scope, different claim). Must be >= similarityThreshold.
   */
  contradictionThreshold?: number;
  /**
   * Claim-level bar for path-3 overrides (R31): the SUMMARY-to-SUMMARY cosine
   * must also clear this. Deliberately lower than contradictionThreshold —
   * summaries are short, so a one-word negation costs more cosine there than
   * in the detail-dominated contentText vector. Grounding (hashing / bge):
   * true negations measured 0.80 / ~0.95, topical-but-compatible pairs 0.00
   * / 0.6995 — 0.75 separates all four.
   */
  claimThreshold?: number;
  /** Cosine threshold for scoring candidate memories in recall. */
  similarityThreshold?: number;
  /** Default importance floor applied to recall when the cue has none. */
  minImportance?: number;
  /** Max candidates pulled by vector recall before re-ranking. */
  topK?: number;
  /** Seconds a memory must be idle before it may be forgotten. */
  forgetAfterSec?: number;
  /** Max size of the version history kept per memory id. */
  maxVersionsPerId?: number;
  /**
   * Seconds passing evidence stays fresh. A VERIFIED row older than this no
   * longer shields against retirement and renders [ASSERTED] until re-run
   * (evidence rots; re-run the check and refresh verifiedAt).
   */
  evidenceTtlSec?: number;
  /**
   * Zero-recall protection (audit #7: the forget negative-feedback loop).
   * Rows younger than this many seconds are NEVER forgotten or decayed,
   * however weak their strength — a trace that was simply never cued yet is
   * not a useless trace. Breaks the loop "weak embedder → recall miss →
   * accessCount stays 0 → importance decays → forgotten".
   */
  forgetGraceSec?: number;
  /**
   * Milliseconds of access-count history the rehearsal boost looks at.
   * (Reserved; the boost window is currently derived from lastAccessAt.)
   */
  rehearsalWindowMs?: number;
}

/** Embedding provider contract: anything that maps text to a float vector. */
export interface EmbeddingProvider {
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * LLM consolidation hook (audit #4): the default `consolidate()` promotes a
 * qualifying episode by re-wrapping its summary as `FACT: …` — no real
 * abstraction happens. Attach a summarizer (typically a call into the host
 * agent's own model) to replace that template with a true generalization:
 * given the qualifying episodes, return a list of distilled semantic rules.
 * Returning an empty array skips the candidate; throwing falls back to the
 * template path (consolidation must never fail the store).
 */
export type Summarizer = (
  episodes: { summary: string; detail?: string; entities: string[] }[]
) => Promise<string[]>;

export const DEFAULT_OPTIONS: Required<StoreOptions> = {
  nearDuplicateThreshold: 0.92,
  contradictionThreshold: 0.86,
  claimThreshold: 0.75,
  // 0.4 → 0.32: the offline hashing embedder yields lower absolute cosines
  // than a real model (esp. for CJK, now tokenized per character); 0.4 was
  // rejecting legitimate hits (measured 0.39 for a same-topic Chinese recall).
  similarityThreshold: 0.32,
  minImportance: 0,
  topK: 20,
  forgetAfterSec: 60 * 60 * 24 * 120, // 120 days
  maxVersionsPerId: 8,
  evidenceTtlSec: 60 * 60 * 24 * 30, // 30 days: passing evidence older than this is stale
  forgetGraceSec: 60 * 60 * 24 * 14, // 14 days: young rows are never forgotten, however quiet
  rehearsalWindowMs: 0
};

/** Small branded-ish helper used across modules. */
export function nowIso(): string {
  return new Date().toISOString();
}
