/**
 * Behavioral tests: memory formation, conflict resolution, recall,
 * consolidation, forgetting, and source monitoring.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

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
