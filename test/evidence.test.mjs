/**
 * Suggestion round (anti-hallucination): evidence, shield, retraction,
 * guard, range priors, [recent] repair.
 *
 *  S1: numeric semantic claims without passing evidence downgrade to
 *      episodes; [VERIFIED]/[ASSERTED] render in context.
 *  S2: VERIFIED incumbents are retired only by passing evidence
 *      (fabrication wash); verify() sees archived revisions.
 *  S3: range priors warn (never block) on impossible values.
 *  S4: retraction rows are never overridden; hits on retracted ids are
 *      flagged and boosted.
 *  S6: guard rows store trigger/action and surface on matching cues.
 *  S7: [recent] tag renders when the recency buffer contributes; zero hits
 *      with includeRecent render an explicit status, never silent filler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore(tag = 'ev', options) {
  const dir = mkdtempSync(join(tmpdir(), `hippo-${tag}-`));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db'), ...(options ? { options } : {}) });
  return { m, dir };
}

test('S1: numeric semantic without evidence downgrades to episode', async () => {
  const { m, dir } = freshStore('s1');
  try {
    const w = await m.remember({ kind: 'semantic', summary: 'D1 coverage ratio -> 1.350565', entities: [{ name: 'd1' }] });
    assert.equal(w.outcome, 'new');
    assert.equal(w.memory.kind, 'episode', `unverified numeric claim must not become a rule: ${w.memory.kind}`);
    assert.ok(w.warning && w.warning.includes('downgraded'), `downgrade is visible: ${w.warning}`);
    const v = await m.remember({
      kind: 'semantic', summary: 'D1 coverage ratio -> 1.350565', entities: [{ name: 'd1' }],
      verify: { cmd: 'python check.py', expect: '1.350565' }, verifyResult: 'pass', verifiedAt: '2026-09-18T01:30:00Z'
    });
    assert.equal(v.memory.kind, 'semantic', 'passing evidence keeps the rule');
    assert.equal(v.memory.verifyResult, 'pass');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S1 narrowed (R29): prose mentioning numbers keeps its kind', async () => {
  const { m, dir } = freshStore('s1n');
  try {
    const w = await m.remember({ kind: 'semantic', summary: 'release 2.1 shipped Tuesday', entities: [{ name: 'rel' }] });
    assert.equal(w.memory.kind, 'semantic', 'version strings are not value assertions');
    assert.ok(!w.warning || !w.warning.includes('downgraded'), 'no downgrade noise');
    const c = await m.remember({ kind: 'semantic', summary: 'cache size is 512 MB', entities: [{ name: 'cache' }] });
    assert.equal(c.memory.kind, 'episode', 'copula value assertion still downgrades');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S1: context renders [VERIFIED] vs [ASSERTED]', async () => {
  const { m, dir } = freshStore('s1b');
  try {
    await m.remember({
      kind: 'semantic', summary: 'cache limit -> 512', entities: [{ name: 'cache' }],
      verify: { cmd: 'check.sh', expect: '512' }, verifyResult: 'pass'
    });
    await m.remember({ kind: 'semantic', summary: 'plain policy statement here', entities: [{ name: 'policy' }] });
    const ctx = await m.composeContext('cache limit policy', { limit: 6 });
    assert.ok(ctx.context.includes('[VERIFIED]'), `verified row tagged: ${ctx.context.slice(0, 400)}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2: fabrication cannot retire a VERIFIED row (wash)', async () => {
  const { m, dir } = freshStore('s2');
  try {
    const t = await m.remember({
      kind: 'semantic', summary: 'D1 coverage ratio -> 1.350565', entities: [{ name: 'd1' }],
      verify: { cmd: 'python check.py', expect: '1.350565' }, verifyResult: 'pass'
    });
    assert.equal(t.memory.kind, 'semantic');
    // Numeric challengers without evidence are downgraded to episodes first:
    // the VERIFIED rule stands either way — retirement is what must not happen.
    const f = await m.remember({ kind: 'semantic', summary: 'D1 coverage ratio -> 1.566', entities: [{ name: 'd1' }] });
    assert.notEqual(f.outcome, 'override', `unverified fabrication must not override: ${f.outcome}`);
    assert.equal(m.stats().active, 2, 'truth and challenger coexist');
    assert.ok(!m.get(t.memory.id) || m.get(t.memory.id)?.summary.includes('1.350565'), 'truth untouched');
    // Passing evidence DOES retire: correction with proof wins.
    const c = await m.remember({
      kind: 'semantic', summary: 'D1 coverage ratio -> 1.350566', entities: [{ name: 'd1' }],
      verify: { cmd: 'python check.py', expect: '1.350566' }, verifyResult: 'pass'
    });
    assert.equal(c.outcome, 'override', `evidenced correction still versions: ${c.outcome}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2: shield fires for non-numeric challengers (same kind, no downgrade)', async () => {
  const { m, dir } = freshStore('s2c');
  try {
    await m.remember({
      kind: 'semantic', summary: 'gateway -> nginx', entities: [{ name: 'gateway' }],
      verify: { cmd: 'check.sh', expect: 'nginx' }, verifyResult: 'pass'
    });
    const f = await m.remember({ kind: 'semantic', summary: 'gateway -> envoy', entities: [{ name: 'gateway' }] });
    assert.notEqual(f.outcome, 'override', `unverified challenger must not override: ${f.outcome}`);
    assert.ok(f.warning && f.warning.startsWith('shielded:'), `shield is visible: ${f.warning}`);
    assert.equal(m.stats().active, 2, 'both rows kept');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2: verify() sees archived revisions', async () => {
  const { m, dir } = freshStore('s2b');
  try {
    const a = await m.remember({ kind: 'semantic', summary: 'link speed -> slow', entities: [{ name: 'link' }] });
    assert.equal(a.outcome, 'new');
    const b = await m.remember({
      kind: 'semantic', summary: 'link speed -> fast', entities: [{ name: 'link' }],
      verify: { cmd: 'ethtool x', expect: 'fast' }, verifyResult: 'pass'
    });
    assert.equal(b.outcome, 'override');
    const v = await m.sourceMonitor('link speed -> slow');
    assert.ok(
      v.superseded_matches.some((s) => s.version === 1),
      `archived v1 surfaced: ${JSON.stringify(v.superseded_matches)}`
    );
    assert.ok(v.note.includes('archived v1'), `archive note names the old version: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S3: range priors warn on impossible values, never block', async () => {
  const { m, dir } = freshStore('s3');
  try {
    const neg = await m.remember({ kind: 'episode', summary: 'conditional entropy = -1.02 bit', entities: [{ name: 'r20' }] });
    assert.equal(neg.outcome, 'new', 'warn-only must not block the write');
    assert.ok(neg.warning && neg.warning.includes('negative'), `negative entropy flagged: ${neg.warning}`);
    const pct = await m.remember({ kind: 'episode', summary: 'coverage 141% of target reached', entities: [{ name: 'r20' }] });
    assert.ok(pct.warning && pct.warning.includes('outside [0,100]'), `bad percent flagged: ${pct.warning}`);
    const ok = await m.remember({ kind: 'episode', summary: 'coverage 64.19% of target reached', entities: [{ name: 'r20' }] });
    assert.ok(!ok.warning, `sane values stay quiet: ${ok.warning}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4: retraction rows are never overridden and flag their target', async () => {
  const { m, dir } = freshStore('s4');
  try {
    const t = await m.remember({ kind: 'semantic', summary: 'T source copy is safe to move', entities: [{ name: 'tbl' }] });
    const r = await m.remember({
      kind: 'semantic', summary: 'WITHDRAWN: T source copy breaks alignment', tags: ['retraction'],
      retracts: t.memory.id, detail: 'alignment rate only 0.162290 over 28979 pairs', entities: [{ name: 'tbl' }]
    });
    assert.equal(r.outcome, 'new');
    // A later "correction" aimed at the retraction itself must not retire it.
    const attack = await m.remember({
      kind: 'semantic', summary: 'WITHDRAWN: T source copy breaks alignment', tags: ['retraction'],
      detail: 'actually it is fine', entities: [{ name: 'tbl' }]
    });
    assert.notEqual(attack.outcome, 'override', 'retraction markers are append-only in effect');
    const rec = await m.recall({ query: 'T source copy move' }, 5);
    const hit = rec.hits.find((h) => h.id === t.memory.id);
    assert.ok(hit && hit.retracted, `target hit carries the flag: ${JSON.stringify(hit?.retracted)}`);
    const ctx = await m.composeContext('T source copy move', { limit: 6 });
    assert.ok(ctx.context.includes('[retracted:'), 'injection carries the marker, never silent');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S6: guard rows store trigger/action and surface on cue', async () => {
  const { m, dir } = freshStore('s6');
  try {
    const g = await m.remember({
      kind: 'semantic', summary: 'guard: parse tagged lines', tags: ['guard'],
      guard: { trigger: 'parse tagged lines', action: 'capture the marker then whitelist-check' },
      entities: [{ name: 'parsing' }]
    });
    assert.equal(g.outcome, 'new');
    assert.deepEqual(g.memory.guard, { trigger: 'parse tagged lines', action: 'capture the marker then whitelist-check' });
    const rec = await m.recall({ query: 'how to parse tagged lines', limit: 5 });
    assert.ok(rec.hits.some((h) => h.guard), 'guard row recalled by trigger');
    const ctx = await m.composeContext('how to parse tagged lines', { limit: 6 });
    assert.ok(ctx.context.includes('[GUARD]'), 'guard row labelled at injection');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S7: [recent] tag renders when the buffer contributes', async () => {
  const { m, dir } = freshStore('s7');
  try {
    await m.remember({ kind: 'semantic', summary: 'alpha fact one', entities: [{ name: 'a' }] });
    await new Promise((r) => setTimeout(r, 20));
    await m.remember({ kind: 'semantic', summary: 'beta fact two', entities: [{ name: 'b' }] });
    await new Promise((r) => setTimeout(r, 20));
    await m.remember({ kind: 'semantic', summary: 'gamma fact three', entities: [{ name: 'c' }] });
    // One hit + recency extras inside the limit: the extra row renders tagged.
    const ctx = await m.composeContext('alpha fact', { limit: 2, includeRecent: true, recentLimit: 2 });
    assert.ok(ctx.items.length >= 1, 'ranked hit present');
    assert.ok(ctx.context.includes('[recent]'), `buffer rows labelled: ${ctx.context.slice(0, 500)}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cue follow-up 3: zero hits render status, never silent filler', async () => {
  const { m, dir } = freshStore('s7b');
  try {
    const ctx = await m.composeContext('anything at all', { limit: 2, includeRecent: true, recentLimit: 2 });
    assert.equal(ctx.items.length, 0, 'empty store, empty items');
    assert.ok(ctx.context.includes('no memory above threshold'), `failure visible: ${ctx.context}`);
    assert.ok(!ctx.context.includes('[recent]'), 'no filler masquerading as recall');
    assert.ok(ctx.warnings.some((w) => w.includes('includeRecent')), 'supplement path still marked');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fuzzy archive: reworded old value surfaces from history', async () => {
  const { m, dir } = freshStore('fz');
  try {
    await m.remember({ kind: 'semantic', summary: 'deploy target -> prod cluster A', entities: [{ name: 'deploy' }] });
    await m.remember({ kind: 'semantic', summary: 'deploy target -> prod cluster B', entities: [{ name: 'deploy' }] });
    // Reworded question about the old value: no verbatim archive text matches.
    const v = await m.sourceMonitor('which cluster was the deploy target before');
    const arch = v.superseded_matches.filter((s) => s.version === 1);
    assert.ok(arch.length >= 1, `fuzzy archive hit: ${JSON.stringify(v.superseded_matches)}`);
    assert.ok(arch[0].summary.includes('cluster A'), 'old value readable without exact wording');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence TTL: stale proof loses shield and VERIFIED', async () => {
  const { m, dir } = freshStore('ttl', { evidenceTtlSec: 60 });
  try {
    const old = new Date(Date.now() - 3600 * 1000).toISOString();
    await m.remember({
      kind: 'semantic', summary: 'gateway -> nginx', entities: [{ name: 'gateway' }],
      verify: { cmd: 'check.sh', expect: 'nginx' }, verifyResult: 'pass', verifiedAt: old
    });
    // Stale incumbent: unverified challenger retires with a normal override.
    const c = await m.remember({ kind: 'semantic', summary: 'gateway -> envoy', entities: [{ name: 'gateway' }] });
    assert.equal(c.outcome, 'override', `stale proof must not shield: ${c.outcome}`);
    assert.ok(!c.warning.startsWith('shielded:'), 'no shield warning on stale evidence');
    // Fresh incumbent: shield holds.
    const m2store = freshStore('ttl2', { evidenceTtlSec: 3600 });
    try {
      await m2store.m.remember({
        kind: 'semantic', summary: 'gateway -> nginx', entities: [{ name: 'gateway' }],
        verify: { cmd: 'check.sh', expect: 'nginx' }, verifyResult: 'pass', verifiedAt: new Date().toISOString()
      });
      const f2 = await m2store.m.remember({ kind: 'semantic', summary: 'gateway -> envoy', entities: [{ name: 'gateway' }] });
      assert.ok(f2.warning && f2.warning.startsWith('shielded:'), `fresh proof shields: ${f2.warning}`);
      const ctx = await m2store.m.composeContext('gateway', { limit: 4 });
      assert.ok(ctx.context.includes('[VERIFIED]'), 'fresh proof renders VERIFIED');
    } finally {
      m2store.m.close();
      rmSync(m2store.dir, { recursive: true, force: true });
    }
    // Stale proof renders ASSERTED, not VERIFIED.
    const ctx = await m.composeContext('gateway', { limit: 4 });
    assert.ok(!ctx.context.includes('[VERIFIED]'), 'stale proof loses the tag');
    assert.ok(ctx.context.includes('[ASSERTED]'), 'stale proof reads as assertion');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('low-confidence recall warns unless backed by evidence', async () => {
  const { m, dir } = freshStore('lc');
  try {
    await m.remember({ kind: 'semantic', summary: 'ZZLC hunch about cache sizing', entities: [{ name: 'zzlc' }], confidence: 'low' });
    await m.remember({
      kind: 'semantic', summary: 'ZZLC checked cache sizing', entities: [{ name: 'zzlc' }],
      confidence: 'low', verify: { cmd: 'check.sh', expect: 'ok' }, verifyResult: 'pass'
    });
    const rec = await m.recall({ query: 'ZZLC cache sizing' }, 5);
    assert.ok(rec.warnings.some((w) => w.startsWith('low-confidence:')), `unbacked hunch flagged: ${rec.warnings}`);
    assert.ok(!rec.warnings.some((w) => w.includes('checked cache')), 'evidenced row excuses its own flag');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R30-6: guard tag without object (and vice versa) warns at write time', async () => {
  const { m, dir } = freshStore('gd');
  try {
    const bare = await m.remember({ kind: 'semantic', summary: 'ZZGD check markers first', tags: ['guard'], entities: [{ name: 'zzgd' }] });
    assert.ok(bare.warning && bare.warning.includes('guard-note'), `bare tag flagged: ${bare.warning}`);
    const objless = await m.remember({
      kind: 'semantic', summary: 'ZZGD capture then whitelist', guard: { trigger: 'parse lines', action: 'whitelist' }, entities: [{ name: 'zzgd' }]
    });
    assert.ok(objless.warning && objless.warning.includes('guard-note'), `object without tag flagged: ${objless.warning}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
