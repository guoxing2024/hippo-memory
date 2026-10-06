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

/**
 * G2, the merge side of the coexistence ruling (round 28).
 *
 * The write path now keeps a general statement and its conditioned re-tell apart, which
 * makes cleanup the second door to the same loss: `scopeDifferences(null, 'env=staging')`
 * answers "no difference" because there is no shared key to differ on, so the pair read
 * as mergeable and `mergeDuplicates` retired whichever half its survivor rule picked.
 * Retiring the general row drops exactly the coverage the ruling was made to keep;
 * retiring the conditioned one discards a premise someone stated. Neither is a
 * restatement of the other, so the group is refused and both rows stay live.
 */
test('merge: a premise-free row and a conditioned one are not restatements of each other', async () => {
  const { m, dir } = freshStore();
  try {
    const general = await m.remember({ kind: 'semantic', summary: 'zz19 quorum -> three replicas' });
    const keyed = await m.remember({ kind: 'semantic', summary: 'zz19 quorum -> three replicas', scope: 'env=staging' });
    assert.equal(keyed.outcome, 'new', 'the write path already keeps them apart');

    const group = m.duplicates().groups.find((g) => g.memories.some((x) => x.id === general.memory.id));
    assert.ok(group, 'duplicates still pairs them by text');
    assert.equal(group.mixedPremises, true, 'and flags the pair as mixed, so a sweep cannot read it as tidy');

    const res = await m.mergeDuplicates({ ids: [general.memory.id, keyed.memory.id] });
    assert.equal(res.retired.length, 0, `cleanup must not pick which premise the general rule carries: ${res.note}`);
    assert.equal(res.blocked.length, 1);
    assert.equal(res.blocked[0].id, keyed.memory.id, 'the earliest row keeps its seat, the conditioned one is the refusal');
    assert.match(res.blocked[0].reason, /states a premise where the survivor states none/);
    assert.equal(m.stats().demoted, 0, 'both traces survive the sweep');
    assert.equal(m.stats().active, 2);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The same pair with the CONDITIONED row forced as the survivor: the general half is the
 * one at risk in that direction, and which row the tie-break happens to favour must not
 * decide the answer.
 */
test('merge: forcing the conditioned survivor still refuses to retire the general row', async () => {
  const { m, dir } = freshStore();
  try {
    const general = await m.remember({ kind: 'semantic', summary: 'zz19c quorum -> three replicas' });
    const keyed = await m.remember({ kind: 'semantic', summary: 'zz19c quorum -> three replicas', scope: 'env=staging' });
    const res = await m.mergeDuplicates({ ids: [general.memory.id, keyed.memory.id], into: keyed.memory.id });
    assert.equal(res.survivor, null, 'nothing retires, so no survivor is named — the same contract as the keyed-vs-keyed refusal');
    assert.equal(res.retired.length, 0, 'but the premise-free row is not folded into it');
    assert.match(res.blocked[0].reason, /states no premise, while the survivor states one/);
    assert.equal(m.stats().active, 2);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Guard on the other side: the refusal is about premises, not about duplicates. A pair
 * that states no condition on EITHER side is the ordinary cleanup case and still folds,
 * or refusing the mixed pair would leave every duplicate group unmergeable.
 */
test('merge guard: a pair that states no premise on either side still folds', async () => {
  const { m, dir } = freshStore();
  try {
    const { ids, group } = await duplicatePair(m, 'zz19b dialog gate verified: 0xA1A0 landed 496 bytes');
    assert.equal(group.mixedPremises, false, 'neither side states a condition');
    const res = await m.mergeDuplicates({ ids });
    assert.equal(res.retired.length, 1, 'so the ordinary cleanup still works');
    assert.equal(res.blocked.length, 0);
    assert.equal(m.stats().demoted, 1);
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


// ---------------------------------------------------------------------------
// F3 (black-box report #1): duplicates() only ever grouped by TEXT identity.
//
// Three restatements of one fact that embed within `nearDuplicateThreshold` of
// each other — the engine's own definition of "same statement" (recall reports
// them, `consolidate` refuses to re-fold them) — were invisible to the cleanup
// entry point, and `mergeDuplicates` then refused the ids with "these N ids are
// not restatements of one claim". Measured on the report's shape: three
// paraphrases -> `duplicates(): scanned=3 groupCount=0`.
// Contract: the vector space is a second grouping channel, and the ids it
// reports are mergeable. The anti-footgun guard survives — it just stops
// claiming that text identity is the only way to restate a fact.
// ---------------------------------------------------------------------------

/** A 3-dim space with a deliberate pair above the bar, a pair below it, and an unrelated row. */
function nearDuplicateEmbedder() {
  return {
    dim: 3,
    embed: async (texts) =>
      texts.map((t) => {
        if (t.includes('ALPHA')) return [1, 0, 0];
        if (t.includes('BETA')) return [0.9, 0.435889894, 0]; // cosine 0.90 — under the 0.92 bar
        return [0, 1, 0]; // GAMMA — orthogonal to ALPHA
      })
  };
}

async function vectorStore(tag = 'mergedup') {
  const { m, dir } = freshStore(tag);
  m.setEmbedder(nearDuplicateEmbedder());
  return { m, dir };
}

test('duplicates: a paraphrase above the vector bar is reported, and says how it was found', async () => {
  const { m, dir } = await vectorStore();
  try {
    const a = await m.remember({ kind: 'semantic', summary: 'ALPHA gateway routing is sticky', entities: [{ name: 'gateway' }] });
    const b = await m.remember({ kind: 'episode', summary: 'ALPHA gateway routing sticks on reconnect', entities: [{ name: 'gateway' }] });
    const c = await m.remember({ kind: 'semantic', summary: 'GAMMA worker queue drains hourly', entities: [{ name: 'queue' }] });
    assert.equal(m.stats().active, 3, 'three separate traces to group');

    const dup = m.duplicates();
    assert.equal(dup.groups.length, 1, `only the near-duplicate pair may be reported: ${JSON.stringify(dup.groups.map((g) => g.memories.map((x) => x.summary)))}`);
    const group = dup.groups[0];
    assert.equal(group.by, 'vector', 'the group must say it came from the vector channel');
    assert.deepEqual(group.memories.map((x) => x.id).sort(), [a.memory.id, b.memory.id].sort());
    assert.ok(!group.memories.some((x) => x.id === c.memory.id), 'the orthogonal row stays out');
    assert.ok(group.similarity >= m.options.nearDuplicateThreshold, `similarity must be measured, not invented: ${group.similarity}`);
    assert.match(group.key, /^vector:/, `a vector group has no shared text key: ${group.key}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicates: a pair under the vector bar is not reported', async () => {
  const { m, dir } = await vectorStore();
  try {
    await m.remember({ kind: 'semantic', summary: 'ALPHA gateway routing is sticky', entities: [{ name: 'gateway' }] });
    await m.remember({ kind: 'semantic', summary: 'BETA gateway routing is sticky under failover', entities: [{ name: 'gateway' }] });
    assert.equal(m.duplicates().groups.length, 0, '0.90 is sharing a topic, not restating a fact');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: a vector group is mergeable — the text guard must not refuse a restatement', async () => {
  const { m, dir } = await vectorStore();
  try {
    const a = await m.remember({ kind: 'semantic', summary: 'ALPHA gateway routing is sticky', entities: [{ name: 'gateway' }] });
    const b = await m.remember({ kind: 'episode', summary: 'ALPHA gateway routing sticks on reconnect', entities: [{ name: 'gateway' }] });
    const group = m.duplicates().groups[0];
    const res = await m.mergeDuplicates({ ids: group.memories.map((x) => x.id), dryRun: true });
    assert.equal(res.retired.length, 1, `one of the two is folded: ${JSON.stringify(res.retired)}`);
    assert.equal(res.blocked.length, 0, `nothing may be blocked inside a reported group: ${JSON.stringify(res.blocked)}`);
    assert.ok(res.survivor && [a.memory.id, b.memory.id].includes(res.survivor.id));
    assert.equal(m.stats().demoted, 0, 'dryRun touches nothing');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: ids that neither share text nor embed as restatements are still refused', async () => {
  const { m, dir } = await vectorStore();
  try {
    const a = await m.remember({ kind: 'semantic', summary: 'ALPHA gateway routing is sticky', entities: [{ name: 'gateway' }] });
    const c = await m.remember({ kind: 'semantic', summary: 'GAMMA worker queue drains hourly', entities: [{ name: 'queue' }] });
    await assert.rejects(
      () => m.mergeDuplicates({ ids: [a.memory.id, c.memory.id], dryRun: true }),
      /not restatements/i,
      'the footgun guard survives the widening'
    );
    assert.equal(m.stats().demoted, 0);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: a near-duplicate pair stating different premises stays two traces', async () => {
  const { m, dir } = await vectorStore();
  try {
    const a = await m.remember({ kind: 'semantic', summary: 'ALPHA gateway routing is sticky', scope: 'region=us-east', entities: [{ name: 'gateway' }] });
    const b = await m.remember({ kind: 'semantic', summary: 'ALPHA gateway routing sticks on reconnect', scope: 'region=eu-west', entities: [{ name: 'gateway' }] });
    assert.equal(m.stats().active, 2, 'the premise split keeps them apart on the write path');
    const group = m.duplicates().groups[0];
    assert.equal(group.mixedPremises, true, 'and the report must say why they are not one fact');
    const res = await m.mergeDuplicates({ ids: [a.memory.id, b.memory.id], dryRun: true });
    assert.equal(res.retired.length, 0, 'merge may not fold across premises');
    assert.equal(res.blocked.length, 1, JSON.stringify(res.blocked));
    assert.match(res.blocked[0].reason, /premise/i);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicates: a verbatim pair still reports the text channel', async () => {
  const { m, dir } = freshStore('mergetext');
  try {
    const e = await m.remember({ kind: 'episode', summary: 'nginx worker connections -> 1024', entities: [{ name: 'nginx' }] });
    await m.remember({ kind: 'semantic', summary: 'FACT: nginx worker connections -> 1024', entities: [{ name: 'nginx' }] });
    const group = m.duplicates().groups.find((g) => g.memories.some((x) => x.id === e.memory.id));
    assert.ok(group, 'the text group is still reported');
    assert.equal(group.by, 'text');
    assert.equal(group.similarity, null, 'a text group asserts no measured similarity');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
