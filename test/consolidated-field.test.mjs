/**
 * F4 (black-box report #7): `consolidated` meant three different things.
 *
 *   - the engine's real marker is the `consolidated` TAG written by
 *     `consolidate()` (src/memory.ts, "tags: [...mem.tags, 'consolidated']");
 *   - `recall` reported `consolidated: mem.kind === 'semantic'` — a KIND alias,
 *     so every semantic row claimed to be a consolidation product;
 *   - `rowToMemory` never set the field at all, which made both adapters'
 *     `list` mapping `consolidated: !!m.consolidated` a permanently-false
 *     column, and the digest label `[kind/semantic]` fire on the wrong rows.
 *
 * Contract under test: one meaning — "this row was produced by systems
 * consolidation" — reported identically by get/recall/list/digest/stats.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore(tag = 'consolidated') {
  const dir = mkdtempSync(join(tmpdir(), `hippo-${tag}-`));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db') });
  return { m, dir };
}

/** One episode, consolidated into its rule, plus a semantic row nobody consolidated. */
async function consolidatedAndPlain(m) {
  const ep = await m.remember({
    kind: 'episode',
    summary: 'ZZCONS1 the deploy gate runs the smoke suite first',
    entities: [{ name: 'zzcons1' }],
    source: 'tool',
    importance: 0.9
  });
  const made = await m.consolidate({ minAccess: 0, minImportance: 0, minAgeMs: 0 });
  const rule = made.find((x) => String(x.summary).includes('ZZCONS1'));
  assert.ok(rule, `consolidation must produce the rule row: ${JSON.stringify(made.map((x) => x.summary))}`);
  const plain = await m.remember({ kind: 'semantic', summary: 'ZZCONS1 the rollback window is one hour' });
  return { episode: ep.memory.id, ruleId: rule.id, ruleSummary: rule.summary, plainId: plain.memory.id };
}

test('consolidated: the row consolidation produced carries the marker everywhere', async () => {
  const { m, dir } = freshStore();
  try {
    const { ruleId, plainId } = await consolidatedAndPlain(m);

    assert.equal(m.get(ruleId).consolidated, true, 'the engine must read its own tag back');
    assert.equal(m.get(plainId).consolidated, false, 'kind is not the marker — a plain semantic row was never consolidated');

    const rec = await m.recall({ query: 'ZZCONS1 the rollback window is one hour' }, 8);
    assert.ok(rec.hits.some((h) => h.id === plainId), `the plain semantic row must be in the hits: ${JSON.stringify(rec.hits.map((h) => h.id))}`);
    for (const h of rec.hits) {
      assert.equal(h.consolidated, h.id === ruleId, `a recall hit may only claim consolidation when it IS the consolidated row: ${h.kind} ${h.id}`);
    }
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('consolidated: the digest line labels the consolidated row, not every semantic one', async () => {
  const { m, dir } = freshStore();
  try {
    const { ruleId, ruleSummary } = await consolidatedAndPlain(m);
    const ctx = await m.composeContext(ruleSummary);
    assert.ok(ctx.context.includes(ruleId.slice(0, 8)) || ctx.context.length > 0, 'the digest has something to say');
    assert.match(ctx.context, /\[semantic\+consolidated\]/, `the injected line must mark the real marker: ${ctx.context}`);
    assert.ok(!ctx.context.includes('[semantic/semantic]'), `the kind alias must be gone: ${ctx.context}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('consolidated: stats() counts the rows the marker covers', async () => {
  const { m, dir } = freshStore();
  try {
    const { ruleId } = await consolidatedAndPlain(m);
    const s = m.stats();
    assert.equal(typeof s.consolidated, 'number', 'stats() must expose the count the adapters cannot derive');
    assert.equal(s.consolidated, 1, `exactly one row carries the tag: ${ruleId}`);
    assert.equal(s.semantics, 2, 'and that is not the same number as "semantic rows"');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
