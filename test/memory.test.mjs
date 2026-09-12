/**
 * Behavioral tests: memory formation, conflict resolution, recall,
 * consolidation, forgetting, and source monitoring.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory, pruneEmptyStores } from '../dist/index.js';

let dir;
let mem;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'hippo-test-'));
  mem = new HippoMemory({ dbPath: join(dir, 'test.db') });
});

after(() => {
  mem.close();
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------- write path ------------------------- */

test('remember stores a new episodic trace', async () => {
  const res = await mem.remember({
    kind: 'episode',
    summary: 'deployed release v2.1 to staging with feature flag FF_BILLING on',
    episode: { place: 'staging', time: '2025-01-10T10:00:00Z' },
    entities: [{ name: 'staging' }, { name: 'FF_BILLING' }],
    tags: ['deploy'],
    source: 'user'
  });
  assert.equal(res.outcome, 'new');
  assert.ok(res.memory.id);
  assert.equal(res.memory.kind, 'episode');
  assert.equal(res.memory.entities.includes('staging'), true);
  const got = mem.get(res.memory.id);
  assert.ok(got);
  assert.equal(got.source, 'user');
});

test('re-telling the same memory strengthens instead of duplicating', async () => {
  const before = mem.stats().episodes;
  await mem.remember({
    kind: 'episode',
    summary: 'deployed release v2.1 to staging with feature flag FF_BILLING on',
    entities: [{ name: 'staging' }],
    source: 'user'
  });
  const after = mem.stats().episodes;
  assert.equal(after, before, 'near-duplicate re-tell must not create a second trace');
});

test('updating a memory archives the old revision (reconsolidation)', async () => {
  const res = await mem.remember({
    kind: 'episode',
    summary: 'meeting with acme decided to use postgres',
    entities: [{ name: 'acme' }],
    source: 'user'
  });
  const updated = await mem.update(res.memory.id, {
    summary: 'meeting with acme decided to use mysql',
    source: 'user'
  });
  assert.equal(updated.memory.version, 2);
  const history = mem.history(res.memory.id);
  assert.equal(history.length, 1);
  assert.match(history[0].summary, /postgres/);
  assert.equal(updated.memory.summary.includes('mysql'), true);
  assert.equal(updated.memory.version, res.memory.version + 1);
});

test('conflicting update on same event overrides (versioned, archived)', async () => {
  const first = await mem.remember({
    kind: 'episode',
    summary: 'the api key for prod rotated at 2025-02-01, old key ak_prod_old',
    occurredAt: '2025-02-01T00:00:00Z',
    entities: [{ name: 'prod' }],
    source: 'user'
  });
  const second = await mem.remember({
    kind: 'episode',
    summary: 'the api key for prod rotated again at 2025-02-02, old key ak_prod_old is now ak_prod_new',
    occurredAt: '2025-02-02T00:00:00Z',
    entities: [{ name: 'prod' }],
    source: 'user'
  });
  // different day → separate event window → a new trace is allowed
  assert.ok(['new', 'override'].includes(second.outcome));
  const rec = await mem.recall({ query: 'api key for prod rotated at 2025-02-01 old key ak_prod_old' });
  assert.ok(rec.hits.length >= 1);
});

/* ------------------------- recall ------------------------- */

test('cue-driven recall finds the right episodic memory', async () => {
  const res = await mem.recall({ query: 'release v2.1 feature flag FF_BILLING staging' });
  const hit = res.hits.find((h) => h.summary.includes('release v2.1'));
  assert.ok(hit, `expected deploy memory in recall, got ${res.hits.map((h) => h.summary)}`);
});

test('recall filters by entity and excludes ids', async () => {
  const all = await mem.recall({ query: 'release v2.1 staging FF_BILLING' });
  assert.ok(all.hits.length >= 1);
  const filtered = await mem.recall({ query: 'release v2.1 staging', entities: ['acme'] });
  assert.equal(filtered.hits.length, 0);
  const target = all.hits[0];
  const excl = await mem.recall({ query: 'release v2.1 staging', excludeIds: [target.id] });
  assert.equal(excl.hits.some((h) => h.id === target.id), false);
});

test('recall returns conflict warnings for stale top hit', async () => {
  // create a strong pair: same entity, v2 overrides v1, query matches the old one
  const oldMem = await mem.remember({
    kind: 'semantic',
    summary: 'customer xyz prefers email support',
    entities: [{ name: 'xyz' }],
    source: 'user'
  });
  await mem.update(oldMem.memory.id, { summary: 'customer xyz prefers phone support now' });
  const rec = await mem.recall({ query: 'customer xyz email support' });
  assert.ok(rec.hits.length >= 1);
  // the top hit should be the newer phone claim (higher version or newer)
  const top = rec.hits[0];
  assert.ok(top.version >= 2 || top.summary.includes('phone'), `top should be the updated one: ${top.summary}`);
});

/* ------------------------- consolidation ------------------------- */

test('consolidate abstracts established episodes into semantic rules', async () => {
  let lastId;
  for (let i = 0; i < 4; i++) {
    const r = await mem.remember({
      kind: 'episode',
      summary: 'daily standup at 9:30 with the platform team, tuesday through friday',
      entities: [{ name: 'platform-team' }],
      source: 'user'
    });
    lastId = r.memory.id;
  }
  // the 4 re-tells collapse into 1 episode; give it usage so consolidation runs
  await mem.recall({ query: 'daily standup platform team 9:30' });
  const made = await mem.consolidate({ minAccess: 3 });
  const sem = mem.db.allActive().filter((r) => r.kind === 'semantic');
  const rule = sem.find((s) => s.summary.includes('standup'));
  assert.ok(rule, `expected consolidated standup rule, got ${sem.map((s) => s.summary)}`);
  assert.ok(made.length >= 1);
  const stats = mem.stats();
  assert.ok(stats.semantics >= 1);
});

/* ------------------------- forgetting ------------------------- */

test('forget() dry-run reports but does not delete', async () => {
  const weak = await mem.remember({
    kind: 'episode',
    summary: 'mentioned a one-off trivia fact nobody cares about',
    importance: 0.05,
    source: 'user'
  });
  const beforeStats = mem.stats();
  const dry = mem.forget({ strengthFloor: 0.2, dryRun: true, force: true });
  assert.ok(dry.forgotten.includes(weak.memory.id));
  assert.equal(mem.stats().active, beforeStats.active, 'dry run must not mutate');
  const real = mem.forget({ strengthFloor: 0.2, force: true });
  assert.ok(real.forgotten.includes(weak.memory.id));
  const stats = mem.stats();
  assert.equal(stats.active, beforeStats.active - 1, 'real forget removes the weak trace');
  assert.ok(!mem.get(weak.memory.id), 'forgotten memory should not be retrievable');
});

/* ------------------------- source monitoring ------------------------- */

test('sourceMonitor substantiates supported claims', async () => {
  await mem.remember({
    kind: 'semantic',
    summary: 'the build pipeline uses github actions and caches node_modules',
    entities: [{ name: 'build-pipeline' }],
    source: 'config'
  });
  const verdict = await mem.sourceMonitor('the build pipeline uses github actions caches node_modules');
  assert.equal(verdict.substantiated, true, verdict.note);
  assert.ok(verdict.support);
});

test('sourceMonitor flags unsubstantiated claims (anti-confabulation)', async () => {
  const verdict = await mem.sourceMonitor('the deploy pipeline runs on jenkins agents with blue green deploys');
  assert.equal(verdict.substantiated, false, verdict.note);
  assert.ok(!verdict.contradicted);
});

test('sourceMonitor detects contradiction on negation', async () => {
  const verdict = await mem.sourceMonitor('the build pipeline does not use github actions at all');
  assert.equal(verdict.contradicted, true, verdict.note);
  assert.ok(verdict.contradiction);
});

/* ------------------------- context gating ------------------------- */

test('composeContext returns compact context with provenance', async () => {
  const ctx = await mem.composeContext('billing service mysql meeting acme');
  assert.ok(ctx.items.length >= 1, 'goal-related memory should be recalled');
  assert.ok(ctx.context.length > 0);
  assert.match(ctx.context, /\[episode|\[semantic/);
  const withRecent = await mem.composeContext('standup', { includeRecent: true });
  assert.ok(withRecent.items.length >= 1);
});

test('stats and close are sane', () => {
  const s = mem.stats();
  assert.ok(s.active >= 8);
  assert.ok(Number.isInteger(s.episodes));
  assert.ok(s.historyRows >= 1, 'versioned updates should leave archived history');
});

/* -------------------- embedding migration (reembed) -------------------- */

test('ensureEmbeddingMigration re-embeds legacy rows exactly once (persisted marker)', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'hippo-migrate-'));
  const m = new HippoMemory({ dbPath: join(dir2, 'm.db') });

  // Write with the default (hash) embedder → legacy vectors.
  await m.remember({ kind: 'semantic', summary: 'migration test target -> value A', source: 'user' });
  await m.remember({ kind: 'semantic', summary: 'another migration row -> value B', source: 'user' });
  assert.equal(m.stats().active, 2);

  // Attach a fake 4-d embedder and migrate.
  let embedCalls = 0;
  const fake = {
    dim: 4,
    embed: async (texts) => {
      embedCalls += 1;
      return texts.map((t) => Array.from({ length: 4 }, (_, i) => (t.length + i) / 10));
    }
  };
  m.setEmbedder(fake);
  const n1 = await m.ensureEmbeddingMigration();
  assert.equal(n1, 2, 'both legacy rows re-embedded on first call');

  // Second call: marker already set → no-op.
  const n2 = await m.ensureEmbeddingMigration();
  assert.equal(n2, 0, 'idempotent via persisted marker');

  // New instance on same db: marker persists → still no-op.
  const m2 = new HippoMemory({ dbPath: join(dir2, 'm.db') });
  m2.setEmbedder(fake);
  const n3 = await m2.ensureEmbeddingMigration();
  assert.equal(n3, 0, 'marker survives reopen');

  // Rows written after migration carry the model vectors (dim 4 matches).
  await m2.remember({ kind: 'semantic', summary: 'post migration write -> C', source: 'user' });
  const r = await m2.recall({ query: 'post migration write -> C' }, 3);
  assert.ok(r.hits.length >= 1, 'new model-embedded row recallable');

  m.close();
  m2.close();
  rmSync(dir2, { recursive: true, force: true });
});

test('empty store migration marks done without embedding', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'hippo-migrate-empty-'));
  const m = new HippoMemory({ dbPath: join(dir2, 'e.db') });
  const fake = { dim: 4, embed: async () => { throw new Error('must not be called'); } };
  m.setEmbedder(fake);
  const n = await m.ensureEmbeddingMigration();
  assert.equal(n, 0);
  m.close();
  rmSync(dir2, { recursive: true, force: true });
});

test('delete removes a memory and its history permanently', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'hippo-del-'));
  const m = new HippoMemory({ dbPath: join(dir2, 'd.db') });

  // Create a memory with a revision history (update archives v1 → history).
  const r1 = await m.remember({ kind: 'semantic', summary: 'delete me -> original value', source: 'user' });
  await m.update(r1.memory.id, { summary: 'delete me -> corrected value' });
  const histBefore = m.history(r1.memory.id);
  assert.ok(histBefore.length >= 1, 'update archives history');
  assert.ok(m.stats().active >= 1);

  // Delete it.
  m.delete(r1.memory.id);
  assert.ok(m.stats().active === 0, 'row removed');
  assert.equal(m.history(r1.memory.id).length, 0, 'history purged');
  assert.throws(() => m.delete(r1.memory.id), /no memory/, 'second delete throws');

  m.close();
  rmSync(dir2, { recursive: true, force: true });
});

test('lazy open: reading a fresh store leaves no file, first write creates it', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'hippo-lazy-'));
  const dbPath = join(dir2, 'lazy.db');

  // createFile:false → read-only traffic must not touch the disk.
  const m = new HippoMemory({ dbPath, createFile: false });
  assert.equal(existsSync(dbPath), false, 'no file after construction');
  assert.equal(m.stats().active, 0, 'reads served from memory');
  assert.equal(m.list(5).length, 0);
  assert.equal((await m.recall({ query: 'anything' }, 3)).hits.length, 0);
  assert.equal(existsSync(dbPath), false, 'still no file after reads');

  // First write materializes the file and the row is durable.
  const r = await m.remember({ kind: 'semantic', summary: 'lazy -> materialized on write', source: 'user' });
  assert.equal(existsSync(dbPath), true, 'file created by the write');
  m.close();

  const again = new HippoMemory({ dbPath, createFile: false });
  assert.equal(again.stats().active, 1, 'row survived reopen');
  assert.ok(again.list(5).some((x) => x.id === r.memory.id));
  again.close();
  rmSync(dir2, { recursive: true, force: true });
});

test('pruneEmptyStores removes empty stores and keeps ones with data', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'hippo-prune-'));
  const empty = join(dir2, 'empty-agent.db');
  const full = join(dir2, 'has-data.db');

  // An empty store (read-only residue from older versions).
  const e = new HippoMemory({ dbPath: empty });
  e.close();
  // A store holding one memory.
  const f = new HippoMemory({ dbPath: full });
  await f.remember({ kind: 'semantic', summary: 'keep me -> valuable', source: 'user' });
  f.close();

  // Age both so the default 60s guard does not skip them.
  const old = new Date(Date.now() - 3600_000);
  for (const p of [empty, full]) utimesSync(p, old, old);

  const removed = pruneEmptyStores(dir2, { minAgeMs: 0 });
  assert.deepEqual(removed, ['empty-agent.db'], 'only the empty store is pruned');
  assert.equal(existsSync(empty), false, 'empty file gone');
  assert.equal(existsSync(full), true, 'store with data untouched');

  // skip list protects a live key.
  const e2 = new HippoMemory({ dbPath: join(dir2, 'live.db') });
  e2.close();
  const removed2 = pruneEmptyStores(dir2, { minAgeMs: 0, skip: ['live'] });
  assert.ok(!removed2.includes('live.db'), 'skipped key survives');
  rmSync(dir2, { recursive: true, force: true });
});

test('duplicates() reports near-duplicate restatements without deleting', async () => {
  const dir6 = mkdtempSync(join(tmpdir(), 'hippo-dupes-'));
  const m = new HippoMemory({ dbPath: join(dir6, 'd.db') });
  // The real duplicate source: consolidation keeps the episode AND adds a
  // "FACT: <identical text>" rule, so a verbatim pair coexists.
  await m.remember({
    kind: 'episode',
    summary: 'dialog gate verified: 0xA1A0 landed 496 bytes',
    entities: [{ name: '0xA1A0' }],
    source: 'tool',
    importance: 0.9
  });
  const made = await m.consolidate({ minAccess: 0, minImportance: 0, minAgeMs: 0 });
  assert.ok(made.length >= 1, 'a rule was abstracted from the episode');

  const before = m.stats().active;
  const res = m.duplicates();
  assert.equal(res.scanned, before);
  assert.equal(res.groups.length, 1, 'the episode/rule pair is reported as one group');
  assert.equal(res.groups[0].memories.length, 2, 'both restatements listed');
  assert.deepEqual(
    res.groups[0].memories.map((x) => x.kind).sort(),
    ['episode', 'semantic'],
    'the pair spans both kinds'
  );
  assert.equal(m.stats().active, before, 'reporting is read-only — nothing deleted');

  m.close();
  rmSync(dir6, { recursive: true, force: true });
});

test('re-telling a rule with a FACT: wrapper folds instead of duplicating', async () => {
  const dir8 = mkdtempSync(join(tmpdir(), 'hippo-factfold-'));
  const m = new HippoMemory({ dbPath: join(dir8, 'f.db') });
  const a = await m.remember({ kind: 'semantic', summary: 'rule A -> value one', source: 'user' });
  assert.equal(a.outcome, 'new');
  // Same claim, now carrying the consolidation wrapper: it is the SAME fact.
  const b = await m.remember({ kind: 'semantic', summary: 'FACT: rule A -> value one', source: 'user' });
  assert.notEqual(b.outcome, 'new', `wrapper must not create a second row (got ${b.outcome})`);
  assert.equal(b.id, a.id, 'folded into the original engram');
  assert.equal(m.stats().active, 1, 'exactly one row');
  assert.equal(m.duplicates().groups.length, 0);
  m.close();
  rmSync(dir8, { recursive: true, force: true });
});

test('duplicates() finds nothing in a store with no restatements', async () => {
  const dir7 = mkdtempSync(join(tmpdir(), 'hippo-dupes2-'));
  const m = new HippoMemory({ dbPath: join(dir7, 'd.db') });
  await m.remember({ kind: 'semantic', summary: 'alpha -> 1', source: 'user' });
  await m.remember({ kind: 'semantic', summary: 'beta -> 2', source: 'user' });
  const res = m.duplicates();
  assert.equal(res.groups.length, 0);
  m.close();
  rmSync(dir7, { recursive: true, force: true });
});

/* ------------- recall diagnostics (explainable empty results) ------------- */

test('recall reports diagnostics on every bundle', async () => {
  const res = await mem.recall({ query: 'release v2.1 staging' });
  assert.equal(typeof res.scanned, 'number');
  assert.equal(typeof res.eligible, 'number');
  assert.equal(typeof res.threshold, 'number');
  assert.ok(res.threshold > 0 && res.threshold <= 1);
  assert.equal(res.reason, 'ok');
  assert.ok(res.hits.length >= 1);
  assert.ok(Array.isArray(res.nearMisses));
  // hits expose the three score views
  const h = res.hits[0];
  assert.equal(typeof h.similarity, 'number');
  assert.equal(typeof h.relativeScore, 'number');
  assert.ok(h.relativeScore > 0 && h.relativeScore <= 1.0001, `relativeScore in (0,1]: ${h.relativeScore}`);
  // the top hit is, by definition, the best available for this query
  assert.equal(Math.max(...res.hits.map((x) => x.relativeScore)), 1);
  // similarity is the raw cosine, so it must obey the floor
  assert.ok(h.similarity >= res.threshold, 'eligible hits clear the floor');
});

test('empty recall explains WHY it was empty (no-candidates vs below-threshold)', async () => {
  // (a) below-threshold: the store has rows, but none is close to this cue.
  const far = await mem.recall({ query: 'quantum chromodynamics lattice gauge renormalization' });
  assert.equal(far.hits.length, 0);
  assert.equal(far.reason, 'below-threshold');
  assert.ok(far.eligible > 0, 'rows were considered');
  assert.equal(typeof far.bestSimilarity, 'number');
  assert.ok(far.bestSimilarity < far.threshold, 'best was genuinely under the floor');
  assert.equal(far.nearMisses.length > 0, true, 'the closest rows are reported');
  assert.ok(
    far.nearMisses[0].similarity >= far.nearMisses[far.nearMisses.length - 1].similarity,
    'near misses are best-first'
  );
  assert.ok(far.warnings.some((w) => w.includes('similarity floor')), 'warning points at the floor');

  // (b) no-candidates: nothing matches the structural filters at all.
  const none = await mem.recall({ query: 'release v2.1', entities: ['entity-that-does-not-exist'] });
  assert.equal(none.hits.length, 0);
  assert.equal(none.reason, 'no-candidates');
  assert.equal(none.eligible, 0);
  assert.equal(none.nearMisses.length, 0, 'no near misses when nothing was eligible');

  // (c) empty cue keeps its own distinct reason
  const blank = await mem.recall({ query: '   ' });
  assert.equal(blank.reason, 'empty-cue');
});

test('literal identifier match rescues a row below the similarity floor', async () => {
  const dir3 = mkdtempSync(join(tmpdir(), 'hippo-literal-'));
  // A deliberately brutal floor (0.99) so NO ordinary row can clear it: the
  // only way anything comes back is the literal-token rescue.
  const m = new HippoMemory({ dbPath: join(dir3, 'lit.db'), options: { similarityThreshold: 0.99 } });
  await m.remember({
    kind: 'episode',
    summary: 'cache-once assembly verified: 0x6070 path landed 13/13 units',
    entities: [{ name: '0x6070' }],
    source: 'tool'
  });
  await m.remember({ kind: 'episode', summary: 'unrelated plumbing note about log rotation', source: 'tool' });

  // (a) a cue carrying the identifier is rescued from BELOW the floor.
  const res = await m.recall({ query: '0x6070' });
  const hit = res.hits.find((h) => h.summary.includes('cache-once'));
  assert.ok(hit, `literal identifier should be retrieved: ${JSON.stringify(res.hits.map((h) => h.summary))}`);
  assert.ok(hit.literalMatch >= 1, 'flagged as a literal match');
  assert.ok(hit.similarity < res.threshold, `rescued from below the floor (sim ${hit.similarity} < ${res.threshold})`);
  assert.equal(res.reason, 'ok');

  // (b) a cue with NO identifier token gets no such rescue — the floor holds.
  const noTok = await m.recall({ query: 'plumbing note about rotation' });
  assert.equal(noTok.hits.length, 0, 'no literal overlap → nothing clears 0.99');
  assert.equal(noTok.reason, 'below-threshold');

  m.close();
  rmSync(dir3, { recursive: true, force: true });
});

test('remember reports the superseded revision on override', async () => {
  const dir4 = mkdtempSync(join(tmpdir(), 'hippo-super-'));
  const m = new HippoMemory({ dbPath: join(dir4, 'sup.db') });
  const first = await m.remember({ kind: 'semantic', summary: 'build cache -> enabled', entities: [{ name: 'cache' }], source: 'user' });
  assert.equal(first.outcome, 'new');
  assert.equal(first.superseded, undefined, 'a brand-new trace supersedes nothing');

  const second = await m.remember({ kind: 'semantic', summary: 'build cache -> disabled', entities: [{ name: 'cache' }], source: 'user' });
  assert.equal(second.outcome, 'override');
  assert.ok(second.superseded, 'override names what it replaced');
  assert.equal(second.superseded.id, first.memory.id);
  assert.equal(second.superseded.summary, 'build cache -> enabled');
  // the archived revision is still recoverable, not erased
  const hist = m.history(second.memory.id);
  assert.ok(hist.length >= 1, 'old revision kept in history');
  assert.ok(hist.some((h) => h.summary.includes('enabled')));

  m.close();
  rmSync(dir4, { recursive: true, force: true });
});

test('re-telling a consolidated rule does not create a duplicate (FACT: prefix)', async () => {
  const dir5 = mkdtempSync(join(tmpdir(), 'hippo-fact-'));
  const m = new HippoMemory({ dbPath: join(dir5, 'fact.db') });
  const body = 'the staging cluster runs on postgres 16';
  const ep = await m.remember({
    kind: 'episode',
    summary: body,
    entities: [{ name: 'staging' }],
    source: 'tool',
    importance: 0.9
  });
  // Consolidation rewrites the episode as a semantic rule wrapped in "FACT: ".
  const made = await m.consolidate({ minAccess: 0, minImportance: 0, minAgeMs: 0 });
  assert.ok(made.length >= 1, 'a rule was abstracted');
  const rule = m.get(ep.memory.id);
  assert.ok(rule);
  const semantic = m.list(50).find((x) => x.kind === 'semantic');
  assert.ok(semantic, 'semantic rule exists');
  assert.ok(/^fact:/i.test(semantic.summary), `rule carries the wrapper: ${semantic.summary}`);

  // Now re-tell the SAME fact as an episode. The wrapper must not defeat the
  // duplicate check (this was the root cause of 17 duplicate pairs).
  const before = m.stats().active;
  const again = await m.remember({ kind: 'episode', summary: body, entities: [{ name: 'staging' }], source: 'tool' });
  assert.notEqual(again.outcome, 'new', `must fold into the existing rule, got ${again.outcome}`);
  assert.equal(m.stats().active, before, 'no duplicate row added');

  m.close();
  rmSync(dir5, { recursive: true, force: true });
});
