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
}

export interface RetrievedMemory extends StoredMemory {
  /** Cosine similarity of the encoding vector against the cue embedding. */
  score: number;
  /** True when the hit came from the consolidated semantic store. */
  consolidated: boolean;
}

export interface RecallBundle {
  hits: RetrievedMemory[];
  /** Warnings such as stale-rule overrides that were applied. */
  warnings: string[];
  /** Number of memory candidates considered before re-ranking (diagnostics). */
  scanned: number;
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

export type ConflictOutcome = 'none' | 'new' | 'override' | 'merge';

export interface StoreOptions {
  /** Cosine threshold above which two vectors are considered near-duplicates. */
  nearDuplicateThreshold?: number;
  /**
   * Cosine threshold above which two vectors are considered a near-contradiction
   * (same scope, different claim). Must be >= similarityThreshold.
   */
  contradictionThreshold?: number;
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
}

/** Embedding provider contract: anything that maps text to a float vector. */
export interface EmbeddingProvider {
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_OPTIONS: Required<StoreOptions> = {
  nearDuplicateThreshold: 0.92,
  contradictionThreshold: 0.86,
  // 0.4 → 0.32: the offline hashing embedder yields lower absolute cosines
  // than a real model (esp. for CJK, now tokenized per character); 0.4 was
  // rejecting legitimate hits (measured 0.39 for a same-topic Chinese recall).
  similarityThreshold: 0.32,
  minImportance: 0,
  topK: 20,
  forgetAfterSec: 60 * 60 * 24 * 120, // 120 days
  maxVersionsPerId: 8
};

/** Small branded-ish helper used across modules. */
export function nowIso(): string {
  return new Date().toISOString();
}
