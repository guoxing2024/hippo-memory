/**
 * Merging the near-duplicates that duplicates() reports.
 *
 *  preview: dryRun retires nothing and names the survivor it would keep.
 *  apply:   extras are demoted INTO the survivor (live, hidden from default
 *           recall, reversible with undemote) — never hard-deleted.
 *  survivor: chosen so nothing valuable is lost — passing evidence wins.
 *  premises: rows that state different conditions are NOT restatements, so
 *           merge refuses them (that is the whole point of `scope`).
 *  guards:   unrelated ids and marker rows are refused outright.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore(tag = 'merge') {
  const dir = mkdtempSync(join(tmpdir(), `hippo-${tag}-`));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db') });
  return { m, dir };
}

/** The proven duplicate recipe: an episode plus the "FACT: …" rule made from it. */
async function duplicatePair(m, summary = 'dialog gate verified: 0xA1A0 landed 496 bytes') {
  const ep = await m.remember({
    kind: 'episode', summary, entities: [{ name: '0xA1A0' }], source: 'tool', importance: 0.9
  });
  await m.consolidate({ minAccess: 0, minImportance: 0, minAgeMs: 0 });
  const group = m.duplicates().groups.find((g) =>
    g.memories.some((x) => x.id === ep.memory.id)
  );
  assert.ok(group, 'the episode/rule pair is reported as a duplicate group');
  return { episodeId: ep.memory.id, group, ids: group.memories.map((x) => x.id) };
}

test('merge: dryRun previews the survivor and retires nothing', async () => {
  const { m, dir } = freshStore();
  try {
    const { ids } = await duplicatePair(m);
    const before = m.stats();
    const plan = await m.mergeDuplicates({ ids, dryRun: true });
    assert.equal(plan.dryRun, true);
    assert.equal(plan.retired.length, 1, 'one of the two restatements would go');
    assert.ok(plan.survivor?.id, 'the preview names a survivor');
    assert.deepEqual(m.stats(), before, 'a preview changes nothing');
    assert.equal(m.duplicates().groups.length, 1, 'still reported until applied');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: applying retires the extra into the survivor, and undemote restores it', async () => {
  const { m, dir } = freshStore();
  try {
    const { episodeId, ids } = await duplicatePair(
      m,
      'uart fifo depth -> 64 words on the rev-B board'
    );
    const applied = await m.mergeDuplicates({ ids });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.survivor?.id, episodeId, 'the original trace survives');
    assert.equal(applied.retired.length, 1);

    assert.equal(m.stats().demoted, 1, 'the extra is folded, not deleted');
    assert.equal(m.stats().active, 2, 'both rows are still live in the file');
    assert.equal(m.duplicates().groups.length, 0, 'a merged group stops being reported');

    const hits = (await m.recall({ query: 'uart fifo depth' }, 5)).hits;
    assert.equal(hits.length, 1, `default recall must offer one restatement, got ${hits.length}`);
    assert.equal(hits[0].id, episodeId);
    const expanded = await m.recall({ query: 'uart fifo depth', includeDemoted: true }, 5);
    assert.equal(expanded.hits.length, 2, 'the retired restatement is still expandable');

    const foldedId = applied.retired[0].id;
    assert.equal(m.get(foldedId)?.demoted, true, 'the retired row is still readable');
    assert.deepEqual(m.undemote([foldedId]).restored, [foldedId], 'undemote is the undo path');
    assert.equal(m.stats().demoted, 0);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: the row with passing evidence survives and inherits the other trace entities', async () => {
  const { m, dir } = freshStore();
  try {
    const { episodeId, ids } = await duplicatePair(m, 'jtag idcode -> 0x4BA00477 on the probe');
    const ruleId = ids.find((x) => x !== episodeId);
    // One trace holds the only mention of the board, the other the re-runnable
    // evidence: a merge must not cost either of them.
    await m.update(episodeId, { entities: [{ name: 'probe-board' }] });
    await m.update(ruleId, { verify: { cmd: 'python idcode.py', expect: '0x4BA00477' }, verifyResult: 'pass' });

    const applied = await m.mergeDuplicates({ ids });
    assert.equal(applied.survivor?.id, ruleId, 'passing evidence outranks the older row');
    assert.equal(m.get(ruleId)?.verifyResult, 'pass', 'the survivor keeps its evidence');
    assert.ok(m.get(ruleId)?.entities.includes('probe-board'), 'entities carried over onto the survivor');

    const byEntity = await m.recall({ query: 'jtag idcode', entities: ['probe-board'] }, 5);
    assert.deepEqual(byEntity.hits.map((h) => h.id), [ruleId], 'still findable through the retired row entity');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: two traces that state different premises are not restatements, so they stay apart', async () => {
  const { m, dir } = freshStore();
  try {
    // Exactly the field-report shape: one measurement re-run under another
    // comparator. duplicates() lists them together because the TEXT is equal.
    const a = await m.remember({
      kind: 'semantic', summary: 'zz13 pair stays at the independence baseline',
      scope: 'population=first 4096 rows; comparator=instruction start'
    });
    const b = await m.remember({
      kind: 'semantic', summary: 'zz13 pair stays at the independence baseline',
      scope: 'population=all records; comparator=decode completion'
    });
    assert.equal(b.outcome, 'new', 'a new premise is its own trace');
    assert.equal(m.duplicates().groups.length, 1, 'the report still pairs them by text');

    const res = await m.mergeDuplicates({ ids: [a.memory.id, b.memory.id] });
    assert.equal(res.survivor, null, 'nothing is kept over the other');
    assert.equal(res.retired.length, 0);
    assert.equal(res.blocked.length, 1);
    assert.match(res.blocked[0].reason, /premise/i);
    assert.equal(m.stats().demoted, 0, 'both traces are untouched');
    assert.equal(m.duplicates().groups.length, 1, 'and it stays a reported pair for review');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicates: the report shows each trace premises and flags a mixed-premise group', async () => {
  const { m, dir } = freshStore();
  try {
    const { ids } = await duplicatePair(m, 'modbus timeout -> 1500 ms on the gateway');
    const plain = m.duplicates().groups.find((g) => g.memories.some((x) => ids.includes(x.id)));
    assert.deepEqual([...new Set(plain.memories.map((x) => x.scope))], [null], 'a plain restatement states no premise');
    assert.equal(plain.mixedPremises, false, 'so it is mergeable');

    const a = await m.remember({ kind: 'semantic', summary: 'zz14 fill level -> 61 per cent', scope: 'window=1 s' });
    const b = await m.remember({ kind: 'semantic', summary: 'zz14 fill level -> 61 per cent', scope: 'window=10 s' });
    const mixed = m.duplicates().groups.find((g) => g.memories.some((x) => x.id === a.memory.id));
    assert.ok(mixed, 'the two premises are still reported together, by text');
    assert.equal(mixed.mixedPremises, true, `the caller must see why merge will refuse: ${JSON.stringify(mixed)}`);
    assert.deepEqual(mixed.memories.map((x) => x.scope).sort(), ['window=1 s', 'window=10 s']);
    assert.ok(b.outcome === 'new');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: ids from different claims are refused instead of folded', async () => {
  const { m, dir } = freshStore();
  try {
    const a = await m.remember({ kind: 'semantic', summary: 'zz16 billing db -> postgres', source: 'user' });
    const b = await m.remember({ kind: 'semantic', summary: 'zz16 ui theme -> dark', source: 'user' });
    await assert.rejects(
      () => m.mergeDuplicates({ ids: [a.memory.id, b.memory.id] }),
      /restatement/,
      'an unrelated pair must never be folded away'
    );
    assert.equal(m.stats().demoted, 0);
    assert.equal(m.stats().active, 2);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: a marker row is never merged away, even when the text matches', async () => {
  const { m, dir } = freshStore();
  try {
    const text = 'zz17 release checklist -> run the smoke suite first';
    const g = await m.remember({
      kind: 'procedure', summary: text, tags: ['guard'],
      guard: { trigger: 'before any release', action: 'run the smoke suite' }
    });
    const e = await m.remember({ kind: 'episode', summary: text, source: 'tool' });
    assert.equal(m.duplicates().groups.length, 1, 'the report does pair them by text');
    await assert.rejects(
      () => m.mergeDuplicates({ ids: [g.memory.id, e.memory.id] }),
      /marker/i,
      'retiring a guard would silently drop the [GUARD] injection'
    );
    assert.equal(m.stats().demoted, 0);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

