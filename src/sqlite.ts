/**
 * SQLite persistence layer for hippo-memory.
 *
 * Uses Node's built-in `node:sqlite` (DatabaseSync) — zero external services.
 * One row per engram "identity" (id), with `version` tracking revision history;
 * every content change snapshots the previous revision into `memory_history`
 * (analogous to the reconsolidation window: updates never silently erase the
 * past, they archive it).
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryKind, SourceConfidence } from './schema.js';

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
  vec: Uint8Array | null;
}

export function vecToBlob(v: number[]): Uint8Array {
  const f = new Float32Array(v);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

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
  PRIMARY KEY (id, version)
);
`;

export interface HistoryRow {
  version: number;
  summary: string;
  archived_at: string;
  [k: string]: unknown;
}

export class SqliteStore {
  private db: DatabaseSync;
  /** Set while this store has no file on disk yet (lazy mode, empty): reads
   *  are served from an in-memory schema; the first write materializes it. */
  private lazyPath: string | null = null;

  /**
   * @param path    store file path
   * @param opts.create  false = do not touch the disk until something is
   *                     actually written (reads on a missing file are served
   *                     from an in-memory schema). Defaults to true.
   */
  constructor(private readonly path: string, opts: { create?: boolean } = {}) {
    if (opts.create === false && !existsSync(path)) {
      this.db = new DatabaseSync(':memory:');
      this.db.exec(SCHEMA);
      this.lazyPath = path;
      return;
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
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
    this.db = new DatabaseSync(target);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
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
          created_at, updated_at, superseded, vec
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        row.id, row.version, row.kind, row.summary, row.detail,
        row.episode_time, row.episode_place, row.participants_json, row.rule,
        row.entities_json, row.tags_json, row.occurred_at, row.source,
        row.confidence, row.importance, row.access_count, row.last_access_at,
        row.created_at, row.updated_at, row.superseded, row.vec
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
          superseded = ?, vec = ?
         WHERE id = ?`
      )
      .run(
        row.version, row.kind, row.summary, row.detail, row.episode_time,
        row.episode_place, row.participants_json, row.rule, row.entities_json,
        row.tags_json, row.occurred_at, row.source, row.confidence,
        row.importance, row.access_count, row.last_access_at, row.updated_at,
        row.superseded, row.vec, row.id
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
          created_at, updated_at, archived_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        row.id, row.version, row.kind, row.summary, row.detail,
        row.episode_time, row.episode_place, row.participants_json, row.rule,
        row.entities_json, row.tags_json, row.occurred_at, row.source,
        row.confidence, row.importance, row.access_count, row.last_access_at,
        row.created_at, row.updated_at, archivedAt
      );
  }

  setSuperseded(id: string): void {
    this.materialize();
    this.db.prepare('UPDATE memories SET superseded = 1 WHERE id = ?').run(id);
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

  allActive(): MemoryRow[] {
    return this.db.prepare('SELECT * FROM memories WHERE superseded = 0').all() as unknown as MemoryRow[];
  }

  historyOf(id: string): HistoryRow[] {
    return this.db
      .prepare('SELECT version, summary, archived_at, detail FROM memory_history WHERE id = ? ORDER BY version DESC')
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
