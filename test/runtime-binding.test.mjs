import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HippoMemory, sqliteDriver, setSqliteDriver } from '../dist/index.js';
import { DatabaseCtorRef } from '../dist/sqlite-runtime.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('sqliteDriver reports the built-in driver of this runtime', () => {
  assert.ok(['node:sqlite', 'bun:sqlite'].includes(sqliteDriver), `unexpected driver ${sqliteDriver}`);
});

test('a store opens through the resolved driver and creates its parent directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-runtime-'));
  const dbPath = join(dir, 'nested', 'deep', 'm.db');   // parents do not exist yet
  const mem = new HippoMemory({ dbPath });
  const w = await mem.remember({ kind: 'semantic', summary: 'runtime binding -> works', source: 'tool' });
  assert.equal(w.outcome, 'new');
  const rec = await mem.recall({ query: 'runtime binding' }, 3);
  assert.equal(rec.hits.length, 1);
  assert.equal(rec.hits[0].summary, 'runtime binding -> works');
  mem.close();
});

test('setSqliteDriver accepts a custom adapter (escape hatch)', () => {
  let opened = 0;
  const fake = function (/* path */) {
    opened += 1;
    return {
      exec() { return undefined; },
      prepare() { return { run: () => undefined, get: () => undefined, all: () => [] }; },
      close() { return undefined; }
    };
  };
  const RestoreDriver = DatabaseCtorRef;
  setSqliteDriver(fake);
  try {
    new HippoMemory({ dbPath: ':memory:' });
    assert.equal(opened, 1, 'custom driver should be used');
  } finally {
    // restore the built-in driver for any later test in this process
    setSqliteDriver(RestoreDriver);
  }
});
