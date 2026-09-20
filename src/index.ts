export {
  HippoMemory,
} from './memory.js';
export { pruneEmptyStores, SCOPE_RULE, surveyStores, SqliteStore } from './sqlite.js';
export type { StoreSurveyEntry } from './sqlite.js';
export { sqliteDriver, setSqliteDriver, DatabaseCtorRef } from './sqlite-runtime.js';
export type { SqliteDatabaseLike, SqliteStatementLike, SqliteDatabaseCtor, SqliteDriver } from './sqlite-runtime.js';
export { sanitizeMemoryText, looksInjected, dataFrame, rangeCheck, MAX_CONTEXT_TEXT } from './guard.js';
export type {
  CompressPlan,
  CompressResult,
  ConflictOutcome,
  ConsolidationCandidate,
  EmbeddingProvider,
  EpisodicContent,
  MemoryPayload,
  RecallBundle,
  RetrievedMemory,
  RetrievalCue,
  SemanticContent,
  SourceConfidence,
  StoredMemory,
  StoreOptions,
  Summarizer,
} from './schema.js';
export { DEFAULT_OPTIONS, nowIso } from './schema.js';
export {
  cosine,
  dot,
  embedHashing,
  l2,
  normalize,
  topKByScore,
  centroid,
  tokenize,
} from './vectors.js';
