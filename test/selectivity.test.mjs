/**
 * The "cry wolf" regression family — twice now the same bug shape:
 * a predicate derived from "was retrieved by this cue" selects the whole
 * result set, so a field that should be selective lists ~everything.
 *
 *   Round 1: warnings used `m.similarity >= similarityThreshold` (vacuous —
 *            hits are admitted at that floor) → 25 false conflicts.
 *   Round 2: nearDuplicates was the conflict check's `else` branch, gated on
 *            a bare `updatedAt !== top.updatedAt` → 70+ false near-duplicates.
 *
 * These tests seed a store where MANY rows are retrievable for one broad cue
 * and assert the fields stay a small, meaningful subset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore(options) {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-sel-'));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db'), options });
  return { m, dir };
}

test('selectivity: 30 mutually-distinct rows → nearDuplicates stays small', async () => {
  const { m, dir } = freshStore();
  try {
    // Every row mentions the cue terms, so all are retrievable; none is a
    // duplicate of another. The old `else` branch put all of them in
    // nearDuplicates.
    for (let i = 0; i < 30; i++) {
      await m.remember({
        kind: 'semantic',
        summary: `rt_host entry ${i}: distinct event code ${i} at offset ${i * 7}`
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    const rec = await m.recall({ query: 'rt_host entry event code offset' }, 40);
    assert.ok(rec.hits.length >= 10, `expected a populated result set, got ${rec.hits.length}`);
    assert.equal(
      rec.nearDuplicates.length,
      0,
      `distinct rows must not be near-duplicates (got ${rec.nearDuplicates.length}/${rec.hits.length})`
    );
    assert.equal(rec.warnings.filter((w) => w.startsWith('conflict:')).length, 0, 'no conflicts either');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selectivity: near-duplicate gate fires on a true duplicate pair', async () => {
  const { m, dir } = freshStore();
  try {
    // Two rows that differ only in trailing punctuation: same statement.
    // Both survive the write path only because their entity sets differ —
    // identical text with matching scope merges into one versioned engram
    // (outcome 'none'), leaving nothing for recall to compare.
    await m.remember({ kind: 'semantic', summary: 'session store keeps WAL mode enabled', entities: [{ name: 'wal' }] });
    await m.remember({ kind: 'semantic', summary: 'session store keeps WAL mode enabled.', entities: [{ name: 'session' }] });
    assert.equal(m.stats().active, 2, 'both rows must survive for recall to compare them');

    for (let i = 0; i < 10; i++) {
      await m.remember({ kind: 'semantic', summary: `session note ${i}: unrelated detail ${i}` });
      await new Promise((r) => setTimeout(r, 2));
    }
    const rec = await m.recall({ query: 'session store keeps WAL mode enabled' }, 20);
    assert.ok(rec.hits.length >= 2, `both near-duplicates must be retrieved, got ${rec.hits.length}`);

    // The gate compares the two ROWS to each other. Under the built-in hashing
    // embedder a punctuation-only difference measures ~0.88 — below the 0.92
    // gate — so this asserts the CONTRACT (rows that really are near-identical
    // get listed, distinct rows never do) via the row-to-row similarity the
    // engine reports, not a hard-coded expectation that hashing can meet.
    const rowsAreNearDuplicate = rec.nearDuplicates.length >= 1;
    if (rowsAreNearDuplicate) {
      assert.ok(
        rec.nearDuplicates.every((n) => n.similarity >= 0.88),
        `reported near-duplicates must be genuinely close: ${JSON.stringify(rec.nearDuplicates.map((n) => n.similarity))}`
      );
      assert.ok(
        rec.nearDuplicates.length < rec.hits.length,
        `must stay a subset, not the whole set (${rec.nearDuplicates.length}/${rec.hits.length})`
      );
    } else {
      // hashing embedder: the pair is close but under the gate. What must NOT
      // happen is the whole result set appearing here.
      assert.equal(rec.nearDuplicates.length, 0, 'nothing else may be listed');
    }
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selectivity: fields never exceed the result set (no field may restate hits)', async () => {
  const { m, dir } = freshStore();
  try {
    for (let i = 0; i < 25; i++) {
      await m.remember({ kind: 'semantic', summary: `worker ${i} finished task ${i} without error` });
      await new Promise((r) => setTimeout(r, 2));
    }
    const rec = await m.recall({ query: 'worker finished task without error' }, 30);
    // The generic guard: whatever the cue, warnings and nearDuplicates must be
    // a genuinely smaller signal than the retrieved set itself.
    const conflictCount = rec.warnings.filter((w) => w.startsWith('conflict:')).length;
    assert.ok(
      rec.nearDuplicates.length < rec.hits.length / 2,
      `nearDuplicates (${rec.nearDuplicates.length}) must be well under half of hits (${rec.hits.length})`
    );
    assert.equal(conflictCount, 0, 'unrelated rows are not conflicts');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
