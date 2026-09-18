/**
 * Ponytail review regressions:
 *  - topK must actually cap the pre-rank candidate set (it was a dead option).
 *  - sourceMonitor must not re-scan the whole store (single allActive per call).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore(options) {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-pony-'));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db'), options });
  return { m, dir };
}

test('ponytail: topK caps pre-rank candidates and is actually read', async () => {
  const { m, dir } = freshStore({ topK: 2 });
  try {
    // 5 rows all above the similarity floor for the same cue.
    for (let i = 0; i < 5; i++) {
      await m.remember({ kind: 'semantic', summary: `shared topic token ${i} -> value ${i}` });
    }
    const rec = await m.recall({ query: 'shared topic token' }, 10);
    assert.ok(rec.hits.length > 0, 'recall still returns hits');
    assert.ok(
      rec.hits.length <= 2,
      `topK=2 must cap ranked hits, got ${rec.hits.length}`
    );

    // Same store shape without the cap must return more than the capped run.
    const { m: m2, dir: d2 } = freshStore({ topK: 50 });
    try {
      for (let i = 0; i < 5; i++) {
        await m2.remember({ kind: 'semantic', summary: `shared topic token ${i} -> value ${i}` });
      }
      const rec2 = await m2.recall({ query: 'shared topic token' }, 10);
      assert.ok(
        rec2.hits.length > rec.hits.length,
        `uncapped topK must yield more hits (${rec2.hits.length}) than capped (${rec.hits.length})`
      );
    } finally {
      m2.close();
      rmSync(d2, { recursive: true, force: true });
    }
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ponytail: sourceMonitor scans the store once (no duplicate allActive)', async () => {
  const { m, dir } = freshStore();
  try {
    for (let i = 0; i < 6; i++) {
      await m.remember({ kind: 'semantic', summary: `probe topic ${i} -> value ${i}` });
    }
    const original = m.db.allActive.bind(m.db);
    let calls = 0;
    m.db.allActive = () => { calls++; return original(); };
    await m.sourceMonitor('probe topic 1 -> value 1');
    m.db.allActive = original;
    assert.equal(calls, 1, `sourceMonitor must load active rows once, got ${calls}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
