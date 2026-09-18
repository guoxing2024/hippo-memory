/**
 * Runtime-agnostic SQLite binding.
 *
 * The engine runs on two JavaScript runtimes that ship two different built-in
 * SQLite drivers:
 *
 *   Node.js >= 22.5   "`node:sqlite`"  (DatabaseSync)
 *   Bun               "`bun:sqlite`"   (Database)
 *
 * Their APIs are close but not identical, and — more importantly — a STATIC
 * import of either one is a load-time error on the other runtime:
 *
 *   import ... from "`node:sqlite`"  -> "No such built-in module" on Bun < 1.4
 *   import ... from "`bun:sqlite`"   -> "Cannot find module" on Node
 *
 * so the driver is resolved at load time and loaded lazily through a require
 * indirection. Importing this package therefore never throws; only an actual
 * database use can fail, with a message that says what to upgrade.
 */

/** Minimal statement surface the store relies on (both drivers provide it). */
export interface SqliteStatementLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate?(...params: unknown[]): Iterable<unknown>;
}

/** Minimal database surface the store relies on. */
export interface SqliteDatabaseLike {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatementLike;
  close(): unknown;
}

/** Constructor contract accepted by the store. */
export type SqliteDatabaseCtor = new (path: string) => SqliteDatabaseLike;

/** Internal shape: a plain factory (what defaultCtor is). */
type SqliteDatabaseFactory = (path: string) => SqliteDatabaseLike;

export type SqliteDriver = 'node:sqlite' | 'bun:sqlite';

/**
 * Which built-in driver this process resolved to:
 *  - "node:sqlite" on Node.js (including Bun >= 1.4, which implements it),
 *  - "bun:sqlite" on older Bun, where the Node builtin does not exist yet.
 */
export const sqliteDriver: SqliteDriver = detectDriver();

function detectDriver(): SqliteDriver {
  const g = globalThis as { Bun?: unknown };
  if (g.Bun !== undefined) {
    // Bun >= 1.4 implements node:sqlite; older versions do not.
    const viaNode = tryLoad(() => requireBuiltin('node:sqlite')) as NodeSqliteModule | null;
    if (viaNode && typeof viaNode.DatabaseSync === 'function') return 'node:sqlite';
    return 'bun:sqlite';
  }
  return 'node:sqlite';
}

/** Human-readable hint used when no driver can be loaded. */
export const SQLITE_SETUP_HINT =
  'hippo-memory needs a built-in SQLite driver: Node.js >= 22.5 (node:sqlite) or ' +
  'Bun (bun:sqlite). Upgrade the runtime, or pass your own adapter to ' +
  'setSqliteDriver().';

/* ------------------------------------------------------------------ */
/* driver loading                                                     */
/* ------------------------------------------------------------------ */

interface NodeSqliteModule { DatabaseSync: SqliteDatabaseCtor }
interface BunSqliteModule { Database: new (path: string, opts?: BunDatabaseOptions) => BunDatabase }
interface BunDatabaseOptions { create?: boolean; readwrite?: boolean }
interface BunDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatementLike;
  close(): unknown;
}

/**
 * Load a BUILT-IN module synchronously on either runtime.
 *
 * Deliberately avoids `import(...)`: under Bun a plugin loaded by a host
 * process (e.g. opencode) runs on a resolver where unsupported builtins such
 * as node:sqlite fail to resolve at all, while `createRequire` /
 * `process.getBuiltinModule` reach the real runtime registry.
 */
function requireBuiltin(id: string): unknown {
  const g = globalThis as {
    Bun?: { require?: (id: string) => unknown };
    process?: { getBuiltinModule?: (id: string) => unknown };
  };
  const bunRequire = g.Bun?.require;
  if (typeof bunRequire === 'function') return bunRequire(id);
  const getBuiltinModule = g.process?.getBuiltinModule;
  if (typeof getBuiltinModule === 'function') {
    const mod = getBuiltinModule.call(g.process, id);
    if (mod) return mod;
    throw new Error(`Cannot load builtin ${id}`);
  }
  throw new Error(SQLITE_SETUP_HINT);
}

function tryLoad<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Lazily loaded "`node:sqlite`" module. */
let nodeSqliteModule: NodeSqliteModule | null = null;
/** Lazily loaded "`bun:sqlite`" module. */
let bunSqliteModule: BunSqliteModule | null = null;

function requireNodeSqlite(): NodeSqliteModule {
  if (nodeSqliteModule === null) {
    try {
      nodeSqliteModule = requireBuiltin('node:sqlite') as NodeSqliteModule;
    } catch (err) {
      throw new Error(`${SQLITE_SETUP_HINT} (cause: ${errorMessage(err)})`);
    }
  }
  if (typeof nodeSqliteModule.DatabaseSync !== 'function') throw new Error(SQLITE_SETUP_HINT);
  return nodeSqliteModule;
}

function requireBunSqlite(): BunSqliteModule {
  if (bunSqliteModule === null) {
    try {
      bunSqliteModule = requireBuiltin('bun:sqlite') as BunSqliteModule;
    } catch (err) {
      throw new Error(`${SQLITE_SETUP_HINT} (cause: ${errorMessage(err)})`);
    }
  }
  if (typeof bunSqliteModule.Database !== 'function') throw new Error(SQLITE_SETUP_HINT);
  return bunSqliteModule;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Default driver for the detected runtime.
 *
 * The Bun adapter exposes exactly the Node `DatabaseSync` surface the store
 * uses. "`bun:sqlite`".Database.prepare() returns a cached Statement with
 * run/get/all, so no extra statement bookkeeping is needed.
 */
function defaultCtor(path: string): SqliteDatabaseLike {
  if (sqliteDriver === 'bun:sqlite') {
    const { Database } = requireBunSqlite();
    const db = new Database(path);
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => db.prepare(sql),
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = requireNodeSqlite();
  return new DatabaseSync(path);
}

let activeFactory: SqliteDatabaseFactory = defaultCtor;

/**
 * The driver factory the process resolved at load time. Exported so callers
 * (and tests) can snapshot and restore it around a setSqliteDriver() override.
 */
export const DatabaseCtorRef: SqliteDatabaseFactory = defaultCtor;

/**
 * Open a database with the active driver. The store all goes through this so
 * a custom driver (setSqliteDriver) is honoured everywhere.
 */
export function openDatabase(path: string): SqliteDatabaseLike {
  return activeFactory(path);
}

/**
 * Replace the driver (escape hatch for runtimes with neither builtin, tests,
 * or a better-sqlite3 adapter).
 */
export function setSqliteDriver(ctor: SqliteDatabaseCtor | SqliteDatabaseFactory): void {
  activeFactory = ctor as SqliteDatabaseFactory;
}
