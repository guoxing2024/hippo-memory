/**
 * SQLite persistence layer for hippo-memory.
 *
 * Uses Node's built-in `node:sqlite` (DatabaseSync) — zero external services.
 * One row per engram "identity" (id), with `version` tracking revision history;
 * every content change snapshots the previous revision into `memory_history`
 * (analogous to the reconsolidation window: updates never silently erase the
 * past, they archive it).
 */

import { openDatabase } from './sqlite-runtime.js';
import type { SqliteDatabaseLike } from './sqlite-runtime.js';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { MemoryKind, SourceConfidence } from './schema.js';


/**
 * Open (and, when needed, create) the store file.
 *
 * Both drivers refuse to open a path whose PARENT DIRECTORY does not exist
 * ("unable to open database file"), which used to make the first run in a
 * fresh project / profile fail. Creating the directory here makes the store
 * self-sufficient on every runtime (Node, Bun, or a custom driver).
 */
function openStore(path: string): SqliteDatabaseLike {
  if (path !== ':memory:') {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* let the driver report the real error (e.g. permissions) */
    }
  }
  return openDatabase(path);
}

/** Row shape exactly as stored (snake_case columns). */
export interface MemoryRow {
  id: string;
  version: number;
  kind: MemoryKind;
  summary: string;
  detail: string | null;
  episode_time: string | null;
  episode_place: string | null;
  participants_json: string | null;
  rule: string | null;
  entities_json: string;
  tags_json: string;
  occurred_at: string | null;
  source: string | null;
  confidence: SourceConfidence;
  importance: number;
  access_count: number;
  last_access_at: string | null;
  created_at: string;
  updated_at: string;
  superseded: number;
  /** Id of the row that explicitly retired this one (nullable). */
  superseded_by: string | null;
  /** Recheckable provenance JSON {cmd,expect,artifact} (nullable). */
  verify_json: string | null;
  /** Agent-reported evidence outcome (nullable). */
  verify_result: string | null;
  /** ISO time the evidence was last executed (nullable). */
  verified_at: string | null;
  /** Id of the memory this row retracts (nullable). */
  retracts: string | null;
  /** Prospective trigger/action JSON {trigger,action} (nullable). */
  guard_json: string | null;
  /** Stated premises this summary holds under, free text (nullable). */
  scope: string | null;
  /** Folded into an invariant by compress (1 = hidden from default recall). */
  demoted: number;
  /** Invariant row this trace was folded into (nullable). */
  demoted_to: string | null;
  /** ISO time of the demotion (nullable, audit only). */
  demoted_at: string | null;
  vec: Uint8Array | null;
}

export function vecToBlob(v: number[]): Uint8Array {
  const f = new Float32Array(v);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

/** Default writer wait when the shared store file is locked (ms). */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export function vecFromBlob(b: Uint8Array | null): number[] | null {
  if (!b || b.byteLength === 0) return null;
  const f = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  return Array.from(f);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL CHECK (kind IN ('episode','semantic','procedure')),
  summary TEXT NOT NULL,
  detail TEXT,
  episode_time TEXT,
  episode_place TEXT,
  participants_json TEXT,
  rule TEXT,
  entities_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT,
  source TEXT,
  confidence TEXT NOT NULL DEFAULT 'high',
  importance REAL NOT NULL DEFAULT 0.5,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,
  verify_json TEXT,
  verify_result TEXT,
  verified_at TEXT,
  retracts TEXT,
  guard_json TEXT,
  scope TEXT,
  demoted INTEGER NOT NULL DEFAULT 0,
  demoted_to TEXT,
  demoted_at TEXT,
  vec BLOB
);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded);

CREATE TABLE IF NOT EXISTS memory_history (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  episode_time TEXT,
  episode_place TEXT,
  participants_json TEXT,
  rule TEXT,
  entities_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT,
  source TEXT,
  confidence TEXT,
  importance REAL,
  access_count INTEGER,
  last_access_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  archived_at TEXT NOT NULL,
  verify_json TEXT,
  verify_result TEXT,
  verified_at TEXT,
  retracts TEXT,
  guard_json TEXT,
  scope TEXT,
  PRIMARY KEY (id, version)
);
`;

export interface HistoryRow {
  version: number;
  summary: string;
  archived_at: string | null;
  entities_json?: string;
  [k: string]: unknown;
}

export class SqliteStore {
  private db: SqliteDatabaseLike;
  /** Busy-writer timeout kept so a lazy→disk promotion re-applies it. */
  private readonly busyTimeoutMs: number;
  /** Set while this store has no file on disk yet (lazy mode, empty): reads
   *  are served from an in-memory schema; the first write materializes it. */
  private lazyPath: string | null = null;

  /**
   * @param path    store file path
   * @param opts.create  false = do not touch the disk until something is
   *                     actually written (reads on a missing file are served
   *                     from an in-memory schema). Defaults to true.
   */
  /** Light column migration: stores created before superseded_by existed. */
  private ensureColumns(): void {
    const cols = this.db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
    const have = new Set(cols.map((c) => c.name));
    for (const col of ['superseded_by', 'verify_json', 'verify_result', 'verified_at', 'retracts', 'guard_json', 'demoted_to', 'demoted_at', 'scope']) {
      if (!have.has(col)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${col} TEXT;`);
    }
    if (!have.has('demoted')) this.db.exec('ALTER TABLE memories ADD COLUMN demoted INTEGER NOT NULL DEFAULT 0;');
    const hcols = this.db.prepare('PRAGMA table_info(memory_history)').all() as { name: string }[];
    const hhave = new Set(hcols.map((c) => c.name));
    for (const col of ['verify_json', 'verify_result', 'verified_at', 'retracts', 'guard_json', 'scope']) {
      if (!hhave.has(col)) this.db.exec(`ALTER TABLE memory_history ADD COLUMN ${col} TEXT;`);
    }
  }

  constructor(private readonly path: string, opts: { create?: boolean; busyTimeoutMs?: number } = {}) {
    const busyTimeoutMs = opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    this.busyTimeoutMs = busyTimeoutMs;
    if (opts.create === false && !existsSync(path)) {
      this.db = openStore(':memory:');
      this.db.exec(SCHEMA);
      this.lazyPath = path;
      return;
    }
    this.db = openStore(path);
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
      // Shared-store deployments have multiple processes writing the same file
      // (recall's access bookkeeping vs. another agent's remember). WAL alone
      // does not serialize writers: without a busy timeout a colliding write
      // throws SQLITE_BUSY immediately. A bounded wait lets the loser retry
      // transparently; transactions keep each write short.
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))};`);
      this.db.exec(SCHEMA);
      this.ensureColumns();
    } catch (err) {
      // A file that turns out not to be a store must not stay open: on Windows
      // the leaked handle locks it for the rest of the process, so a read-only
      // probe (survey, prune) can make the file undeletable.
      try {
        this.db.close();
      } catch {
        /* already released */
      }
      throw err;
    }
  }

  /** True while this store is held in memory because no file exists yet. */
  isLazy(): boolean {
    return this.lazyPath !== null;
  }

  /** Promote a lazy store to a real file (no-op once materialized). */
  private materialize(): void {
    if (this.lazyPath === null) return;
    const target = this.lazyPath;
    this.lazyPath = null;
    this.db.close();
    this.db = openStore(target);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(this.busyTimeoutMs))};`);
    this.db.exec(SCHEMA);
    this.ensureColumns();
  }

  /* ------------------------- migration markers ------------------------- */

  /** Read the store's migration marker (SQLite PRAGMA user_version). */
  marker(): number {
    const r = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    return Number(r?.user_version ?? 0);
  }

  /** Set the store's migration marker. */
  setMarker(v: number): void {
    this.materialize();
    this.db.exec(`PRAGMA user_version = ${Math.trunc(v)};`);
  }

  /* ------------------------- generic helpers ------------------------- */

  close(): void {
    this.db.close();
  }

  countActive(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM memories WHERE superseded = 0').get() as { c: number };
    return Number(r.c);
  }

  /** Rows retired by an explicit supersedes edge (superseded = 1 AND an outbound
   *  pointer). Superseded rows are excluded from allActive() by definition, so
   *  this cannot be derived from that view. */
  countSupersededEdges(): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM memories WHERE superseded = 1 AND superseded_by IS NOT NULL')
      .get() as { c: number };
    return Number(r.c);
  }

  /** Live rows hidden from default recall (folded by compress / merge). */
  countDemoted(): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM memories WHERE superseded = 0 AND demoted = 1')
      .get() as { c: number };
    return Number(r.c);
  }

  /** True when the store holds no rows at all (active or superseded) and no
   *  archived history — i.e. the file carries no information worth keeping. */
  isEmpty(): boolean {
    const m = this.db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number };
    const h = this.db.prepare('SELECT COUNT(*) AS c FROM memory_history').get() as { c: number };
    return Number(m.c) === 0 && Number(h.c) === 0;
  }

  /* --------------------------- insert/update ------------------------- */

  insert(row: MemoryRow): void {
    this.materialize();
    this.db
      .prepare(
        `INSERT INTO memories (
          id, version, kind, summary, detail, episode_time, episode_place,
          participants_json, rule, entities_json, tags_json, occurred_at,
          source, confidence, importance, access_count, last_access_at,
          created_at, updated_at, superseded, superseded_by, verify_json,
          verify_result, verified_at, retracts, guard_json, scope, demoted,
          demoted_to, demoted_at, vec
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        row.id, row.version, row.kind, row.summary, row.detail,
        row.episode_time, row.episode_place, row.participants_json, row.rule,
        row.entities_json, row.tags_json, row.occurred_at, row.source,
        row.confidence, row.importance, row.access_count, row.last_access_at,
        row.created_at, row.updated_at, row.superseded, row.superseded_by ?? null,
        row.verify_json, row.verify_result, row.verified_at, row.retracts,
        row.guard_json, row.scope, row.demoted, row.demoted_to ?? null, row.demoted_at ?? null,
        row.vec
      );
  }

  update(row: MemoryRow): void {
    this.materialize();
    this.db
      .prepare(
        `UPDATE memories SET
          version = ?, kind = ?, summary = ?, detail = ?, episode_time = ?,
          episode_place = ?, participants_json = ?, rule = ?, entities_json = ?,
          tags_json = ?, occurred_at = ?, source = ?, confidence = ?,
          importance = ?, access_count = ?, last_access_at = ?, updated_at = ?,
          superseded = ?, superseded_by = ?, verify_json = ?, verify_result = ?,
          verified_at = ?, retracts = ?, guard_json = ?, scope = ?, demoted = ?,
          demoted_to = ?, demoted_at = ?, vec = ?
         WHERE id = ?`
      )
      .run(
        row.version, row.kind, row.summary, row.detail, row.episode_time,
        row.episode_place, row.participants_json, row.rule, row.entities_json,
        row.tags_json, row.occurred_at, row.source, row.confidence,
        row.importance, row.access_count, row.last_access_at, row.updated_at,
        row.superseded, row.superseded_by ?? null, row.verify_json,
        row.verify_result, row.verified_at, row.retracts, row.guard_json,
        row.scope, row.demoted, row.demoted_to ?? null, row.demoted_at ?? null,
        row.vec, row.id
      );
  }

  /** Archive the current revision of a row into memory_history. */
  archiveCurrent(id: string, archivedAt: string): void {
    this.materialize();
    const row = this.getById(id);
    if (!row) return;
    this.db
      .prepare(
        `INSERT INTO memory_history (
          id, version, kind, summary, detail, episode_time, episode_place,
          participants_json, rule, entities_json, tags_json, occurred_at,
          source, confidence, importance, access_count, last_access_at,
          created_at, updated_at, archived_at, verify_json, verify_result,
          verified_at, retracts, guard_json, scope
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        row.id, row.version, row.kind, row.summary, row.detail,
        row.episode_time, row.episode_place, row.participants_json, row.rule,
        row.entities_json, row.tags_json, row.occurred_at, row.source,
        row.confidence, row.importance, row.access_count, row.last_access_at,
        row.created_at, row.updated_at, archivedAt, row.verify_json,
        row.verify_result, row.verified_at, row.retracts, row.guard_json, row.scope
      );
  }

  setSuperseded(id: string, supersededBy?: string): void {
    this.materialize();
    this.db
      .prepare('UPDATE memories SET superseded = 1, superseded_by = ? WHERE id = ?')
      .run(supersededBy ?? null, id);
  }

  /** Fold a row into an invariant (compress): hidden from default recall,
   *  still live — version history untouched. Pass null to restore. */
  setDemoted(id: string, to: string | null, atIso?: string): void {
    this.materialize();
    this.db
      .prepare('UPDATE memories SET demoted = ?, demoted_to = ?, demoted_at = ? WHERE id = ?')
      .run(to ? 1 : 0, to, to ? (atIso ?? new Date().toISOString()) : null, id);
  }

  hardDelete(id: string): void {
    this.materialize();
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  /** Permanently remove a memory and its full revision history. */
  deleteWithHistory(id: string): void {
    this.materialize();
    this.db.prepare('DELETE FROM memory_history WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  pruneHistory(id: string, keep: number): void {
    this.materialize();
    this.db
      .prepare(
        `DELETE FROM memory_history WHERE id = ?
         AND version NOT IN (
           SELECT version FROM memory_history WHERE id = ? ORDER BY version DESC LIMIT ?
         )`
      )
      .run(id, id, keep);
  }

  touchAccess(id: string, accessCount: number, atIso: string): void {
    this.materialize();
    this.db
      .prepare('UPDATE memories SET access_count = ?, last_access_at = ? WHERE id = ?')
      .run(accessCount, atIso, id);
  }

  /* ------------------------------ reads ------------------------------ */

  getById(id: string): MemoryRow | undefined {
    const r = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as MemoryRow | undefined;
    return r;
  }

  /** Rows retired by an explicit supersedes edge (verification path). */
  supersededBy(id: string): MemoryRow[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE superseded = 1 AND superseded_by = ?')
      .all(id) as unknown as MemoryRow[];
  }

  allActive(): MemoryRow[] {
    return this.db.prepare('SELECT * FROM memories WHERE superseded = 0').all() as unknown as MemoryRow[];
  }

  historyOf(id: string): HistoryRow[] {
    return this.db
      .prepare(
        'SELECT version, summary, archived_at, detail, entities_json, verify_result, scope FROM memory_history WHERE id = ? ORDER BY version DESC'
      )
      .all(id) as unknown as HistoryRow[];
  }

  /* --------------------------- transactions -------------------------- */

  transaction<T>(fn: () => T): T {
    this.materialize();
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Delete store files that hold no memories and no history.
 *
 * Read-only access used to create a file per agent (every digest render, every
 * recall), which littered the storages directory with empty `.db`/`-wal`/`-shm`
 * skeletons. This sweeps them: a file is removed only when it opens cleanly and
 * both tables are empty, so a store with any row (including archived revisions)
 * is never touched. Locked, unreadable or mid-write files are skipped.
 *
 * @param dir         directory holding `*.db` store files
 * @param opts.minAgeMs  skip files younger than this (default 60s) so a store
 *                       that is being written right now is never a candidate;
 *                       pass 0 in tests
 * @param opts.skip   store keys (file basenames without `.db`) to keep
 * @returns names of the deleted store files
 */
export function pruneEmptyStores(
  dir: string,
  opts: { minAgeMs?: number; skip?: Iterable<string> } = {}
): string[] {
  const minAgeMs = opts.minAgeMs ?? 60_000;
  const skip = new Set(opts.skip ?? []);
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return removed; // directory does not exist yet
  }
  const now = Date.now();
  const names = new Set(entries);

  for (const file of entries.filter((f) => f.endsWith('.db'))) {
    const key = file.slice(0, -3);
    if (skip.has(key)) continue;
    const full = join(dir, file);
    try {
      const st = statSync(full);
      if (now - st.mtimeMs < minAgeMs) continue;
      const probe = new SqliteStore(full);
      let empty: boolean;
      try {
        empty = probe.isEmpty();
      } finally {
        probe.close();
      }
      if (!empty) continue;
      // Drop the WAL/SHM siblings too, else a later open resurrects the rows
      // of the main file from a stale journal.
      for (const suffix of ['', '-wal', '-shm']) {
        const p = full + suffix;
        if (names.has(file + suffix)) {
          try {
            rmSync(p, { force: true });
          } catch {
            /* locked — leave it; next sweep retries */
          }
        }
      }
      removed.push(file);
    } catch {
      /* locked / corrupt / not a store — never delete on doubt */
    }
  }
  return removed;
}

/**
 * The store-scoping contract, stated once so every host can display it.
 *
 * It exists because "the memory is gone" and "you are reading a different
 * file" look identical from a tool result — and only one of them is a bug in
 * what you remember. Adapters add their own line about how *their* file name
 * is derived; this is the part that is true for all of them.
 */
export const SCOPE_RULE =
  'Memories never cross store files: one SQLite file per scope, and a read sees only what was ' +
  'written through the same path. So an empty recall has two very different causes — nothing was ' +
  'remembered, or it was remembered in another store. Check sibling_stores before believing the ' +
  'first one: a zero-row store next to a full one means the write and the read are not looking at ' +
  'the same file.';

/** What `surveyStores` reports about one .db file in a cache directory. */
export type StoreSurveyEntry = {
  /** File name only — the directory is already in `survey.dir`. */
  file: string;
  /** Live rows in the file, the same count `stats().active` reports. */
  rows: number;
  /** How many of those are folded away by compress/merge: still live, never recalled by default. */
  demoted: number;
  /** File mtime as ISO, or null when it could not be read. */
  lastWrite: string | null;
  /** True for the store the caller is asking about. */
  current: boolean;
};

/**
 * Count every store file in a directory, the way `prune` already walks it.
 *
 * Read-mostly: it opens each file to run two COUNTs and closes it. A file that
 * is not a store (or is locked) is named in `unreadable` instead of failing the
 * survey — the report is diagnostic output, and losing it to one odd file in a
 * cache directory would hide exactly the split it exists to reveal.
 */
export function surveyStores(
  dir: string,
  opts: { current?: string } = {}
): { dir: string; stores: StoreSurveyEntry[]; unreadable: string[] } {
  const stores: StoreSurveyEntry[] = [];
  const unreadable: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { dir, stores, unreadable }; // cache root does not exist yet
  }
  const currentPath = opts.current ? resolve(opts.current) : null;
  for (const file of entries.filter((f) => f.endsWith('.db'))) {
    const full = join(dir, file);
    try {
      const lastWrite = new Date(statSync(full).mtimeMs).toISOString();
      const probe = new SqliteStore(full);
      let rows: number;
      let demoted: number;
      try {
        rows = probe.countActive();
        demoted = probe.countDemoted();
      } finally {
        probe.close();
      }
      stores.push({ file, rows, demoted, lastWrite, current: currentPath ? resolve(full) === currentPath : false });
    } catch {
      unreadable.push(file);
    }
  }
  // fullest first: the question is where the memories are, not what order readdir gave them in.
  stores.sort((a, b) => b.rows - a.rows || a.file.localeCompare(b.file));
  return { dir, stores, unreadable };
}
