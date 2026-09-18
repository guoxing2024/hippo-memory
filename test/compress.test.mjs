/**
 * S5 schema compression (N → 1 invariant + K representatives).
 *
 *  propose: groups live non-demoted episodes by scope key, skips
 *    markers/patterns (retraction/guard/invariant tags).
 *  compress: caller-authored invariant + validation; non-representative
 *    members demoted (hidden from default recall, still live).
 *  recall: demoted rows excluded unless includeDemoted.
 *  undemote: restores folded rows.
 *  forget: never deletes folded detail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore(tag = 's5') {
  const dir = mkdtempSync(join(tmpdir(), `hippo-${tag}-`));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db') });
  return { m, dir };
}

async function seedFamily(m, n = 5) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const w = await m.remember({
      kind: 'episode',
      summary: `X falsification family run ${['alpha', 'beta', 'gamma', 'delta', 'epsilon'][i]} case`,
      entities: [{ name: 'xfield' }],
      source: 'tool'
    });
    ids.push(w.memory.id);
    await new Promise((r) => setTimeout(r, 5));
  }
  return ids;
}

test('S5: propose groups same-scope episodes, skips markers', async () => {
  const { m, dir } = freshStore('s5p');
  try {
    const ids = await seedFamily(m, 4);
    await m.remember({ kind: 'semantic', summary: 'guard: check markers first', tags: ['guard'], guard: { trigger: 't', action: 'a' }, entities: [{ name: 'xfield' }] });
    const groups = m.proposeCompressions({ minGroup: 3 });
    assert.equal(groups.length, 1, `one foldable group: ${JSON.stringify(groups)}`);
    assert.deepEqual([...groups[0].memberIds].sort(), [...ids].sort());
    assert.ok(groups[0].suggestedRepresentatives.length >= 1 && groups[0].suggestedRepresentatives.length <= 3);
    assert.ok(groups[0].suggestedRepresentatives.every((id) => ids.includes(id)));
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S5: compress folds members, keeps representatives, hides from recall', async () => {
  const { m, dir } = freshStore('s5c');
  try {
    const ids = await seedFamily(m, 5);
    const reps = ids.slice(0, 2);
    const res = await m.compress({
      invariant: { summary: 'X is independent of all spatial attributes (5 falsification runs)', entities: [{ name: 'xfield' }] },
      members: ids,
      representatives: reps
    });
    assert.deepEqual([...res.kept].sort(), [...reps].sort());
    assert.equal(res.demoted.length, 3);
    assert.equal(m.stats().demoted, 3);
    // Default recall: invariant + representatives only.
    const rec = await m.recall({ query: 'X falsification spatial attributes' }, 10);
    assert.ok(rec.hits.some((h) => h.id === res.invariantId), 'invariant recalled first-class');
    assert.ok(!rec.hits.some((h) => res.demoted.includes(h.id)), 'folded detail stays out');
    // Explicit expansion retrieves the folded rows.
    const exp = await m.recall({ query: 'X falsification spatial attributes' }, 10);
    const exp2 = await m.recall({ query: 'X falsification spatial attributes', includeDemoted: true }, 10);
    assert.ok(exp2.hits.some((h) => res.demoted.includes(h.id)), 'includeDemoted expands folded detail');
    assert.ok(exp.hits.length <= exp2.hits.length, 'expansion is a superset');
    // Folded rows are still live rows with intact history surface.
    assert.equal(m.stats().active, 6, 'nothing deleted, only hidden');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S5: compress validates its plan', async () => {
  const { m, dir } = freshStore('s5v');
  try {
    const ids = await seedFamily(m, 3);
    await assert.rejects(
      m.compress({ invariant: { summary: 'x' }, members: ids, representatives: ['nope'] }),
      /not in members/,
      'representative outside members rejected'
    );
    await assert.rejects(
      m.compress({ invariant: { summary: '  ' }, members: ids }),
      /invariant.summary is required/,
      'empty invariant rejected'
    );
    await assert.rejects(
      m.compress({ invariant: { summary: 'x' }, members: [...ids, 'missing-id'] }),
      /no live member/,
      'unknown member rejected'
    );
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S5: undemote restores folded rows', async () => {
  const { m, dir } = freshStore('s5u');
  try {
    const ids = await seedFamily(m, 4);
    const res = await m.compress({
      invariant: { summary: 'X invariant (4 runs)', entities: [{ name: 'xfield' }] },
      members: ids,
      representatives: ids.slice(0, 1)
    });
    assert.equal(m.stats().demoted, 3);
    const back = m.undemote(res.demoted.slice(0, 2));
    assert.equal(back.restored.length, 2);
    assert.equal(m.stats().demoted, 1);
    const noop = m.undemote(['does-not-exist', ids[0]]);
    assert.equal(noop.restored.length, 0, 'unknown and visible ids restore nothing');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S5: forget never deletes folded detail', async () => {
  const { m, dir } = freshStore('s5f');
  try {
    const ids = await seedFamily(m, 3);
    await m.compress({
      invariant: { summary: 'X invariant (3 runs)', entities: [{ name: 'xfield' }] },
      members: ids,
      representatives: []
    });
    const res = m.forget({ strengthFloor: 0.99, force: true, dryRun: false });
    assert.ok(!res.forgotten.some((id) => ids.includes(id)), `folded detail survives forget: ${res.forgotten}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
