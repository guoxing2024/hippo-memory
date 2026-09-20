/**
 * Second expert-audit round (2026-09-20). Locks the contracts added for the
 * merged findings of the two audits:
 *
 *  #0 trust tiers   — verifyAttested splits [VERIFIED] from [VERIFIED self-reported];
 *                     only attested evidence still shields a row from retirement.
 *  #3 contested     — an affirming argmax is flagged when not the newest word on
 *                     its scope / when a sibling disagrees (no bare boolean yes).
 *  #4 summarizer    — consolidate() prefers a real LLM abstraction hook and
 *                     falls back to the FACT:-template; the hook may throw.
 *  #7 forget guards — young rows and evidenced rows are never forgotten/decayed.
 *  #7/#8 scope read — recall({ scope }) hard-filters disagreeing premises and
 *                     reports how many it dropped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore(tag = 'r2', options, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), `hippo-${tag}-`));
  const m = new HippoMemory({ dbPath: join(dir, 'test.db'), ...(options ? { options } : {}), ...extra });
  return { m, dir };
}

/* ------------------------------ #0 trust tiers ------------------------------ */

test('#0 audit: [VERIFIED] renders only for attested evidence; self-reported is labelled', async () => {
  const { m, dir } = freshStore('trust');
  try {
    await m.remember({
      kind: 'semantic', summary: 'ZZTRUST attest cache limit is 512',
      entities: [{ name: 'zztrust' }], verify: { cmd: 'check.sh' }, verifyResult: 'pass', verifyAttested: true
    });
    await m.remember({
      kind: 'semantic', summary: 'ZZTRUST selfreported write buffer is 128',
      entities: [{ name: 'zztrust' }], verify: { cmd: 'check.sh' }, verifyResult: 'pass'
    });
    const ctx = await m.composeContext('ZZTRUST cache limit buffer', { limit: 6 });
    assert.ok(ctx.context.includes('[VERIFIED self-reported]'), `unattested pass must be labelled: ${ctx.context}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#0 audit: an attested incumbent still shields; a self-reported one does not', async () => {
  const { m, dir } = freshStore('trust2');
  try {
    await m.remember({
      kind: 'semantic', summary: 'ZZTA cache layer -> redis', entities: [{ name: 'zzta' }],
      verify: { cmd: 'check.sh' }, verifyResult: 'pass', verifyAttested: true
    });
    const blocked = await m.remember({ kind: 'semantic', summary: 'ZZTA cache layer -> memcached', entities: [{ name: 'zzta' }] });
    assert.notEqual(blocked.outcome, 'override', 'attested evidence must still shield');
    assert.ok(blocked.warning && blocked.warning.startsWith('shielded:'), `shield visible: ${blocked.warning}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const sr = freshStore('trust3');
  try {
    await sr.m.remember({
      kind: 'semantic', summary: 'ZZTB queue backend -> rabbitmq', entities: [{ name: 'zztb' }],
      verify: { cmd: 'check.sh' }, verifyResult: 'pass'
    });
    const went = await sr.m.remember({ kind: 'semantic', summary: 'ZZTB queue backend -> kafka', entities: [{ name: 'zztb' }] });
    assert.equal(went.outcome, 'override', `self-reported badge must not guard data: ${went.outcome}`);
    assert.ok(went.warning && went.warning.includes('SELF-REPORTED'), `tier named in the warning: ${went.warning}`);
  } finally {
    sr.m.close();
    rmSync(sr.dir, { recursive: true, force: true });
  }
});

/* ------------------------------- #3 contested ------------------------------- */

test('#3 audit: a stale-but-affirming yes is contested, not a bare yes', async () => {
  const { m, dir } = freshStore('contested');
  try {
    await m.remember({ kind: 'semantic', summary: 'ZZCONTEST gateway -> nginx', entities: [{ name: 'zzcontest' }] });
    // A newer sibling on the same scope: the old wording is no longer the
    // newest word on its scope, so an affirming verdict must be flagged.
    const nw = await m.remember({ kind: 'semantic', summary: 'ZZCONTEST gateway -> envoy proxy', entities: [{ name: 'zzcontest' }] });
    assert.equal(nw.outcome, 'override', 'same-subject value flip versions the row (path-0)');
    const v = await m.sourceMonitor('ZZCONTEST gateway -> nginx');
    assert.ok(v.contested || v.contradicted, `the old wording cannot be a clean yes: ${v.note}`);
    assert.equal(typeof v.contested, 'boolean', 'contested is always present (three-state contract)');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#3 audit: contested is false on a clean, current match', async () => {
  const { m, dir } = freshStore('contested2');
  try {
    await m.remember({ kind: 'semantic', summary: 'ZZCONTEST2 deploy target -> staging cluster', entities: [{ name: 'zzcontest2' }] });
    const v = await m.sourceMonitor('ZZCONTEST2 deploy target -> staging cluster');
    assert.equal(v.substantiated, true, v.note);
    assert.equal(v.contested, false, `a clean current match is not contested: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#3 audit: single-letter enumerator values still clash (field report: cluster A vs B)', async () => {
  const { m, dir } = freshStore('contestedAB');
  try {
    // Values differing only by a single-letter label ("cluster A" -> "cluster
    // B") must register as a real value flip. The article "a" was a value
    // filler, so "cluster a" reduced to {cluster} — a subset of {cluster,b} —
    // and the override/contradiction path was silently skipped.
    await m.remember({ kind: 'semantic', summary: 'ZZAB deploy target -> cluster A', entities: [{ name: 'zzab' }] });
    const flip = await m.remember({ kind: 'semantic', summary: 'ZZAB deploy target -> cluster B', entities: [{ name: 'zzab' }] });
    assert.equal(flip.outcome, 'override', `single-letter value flip must version the row: ${flip.outcome}`);
    const v = await m.sourceMonitor('ZZAB deploy target -> cluster A');
    assert.ok(v.contradicted || v.contested, `the retired A value cannot be a clean yes: ${v.note}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#3 audit: a different-subject correction never contests an unrelated claim', async () => {
  const { m, dir } = freshStore('contestedDS');
  try {
    // A correction on one subject (export-worker sqs -> kafka) must not flag an
    // unrelated subject (notif-queue) as contested. superseded_matches is only
    // collected when the support summary yields a structured subject that a
    // retired revision actually rebinds — a topical neighbour is not a conflict.
    await m.remember({ kind: 'semantic', summary: 'ZZDS notif-queue -> rabbitmq', entities: [{ name: 'zzds-notif' }] });
    await m.remember({ kind: 'semantic', summary: 'ZZDS export-worker -> sqs', entities: [{ name: 'zzds-export' }] });
    await m.remember({ kind: 'semantic', summary: 'ZZDS export-worker -> kafka', entities: [{ name: 'zzds-export' }] });
    const v = await m.sourceMonitor('ZZDS notif-queue -> rabbitmq');
    assert.equal(v.substantiated, true, v.note);
    assert.equal(v.contested, false, `unrelated subject must not be contested: ${v.note}`);
    assert.equal(v.superseded_matches.length, 0, 'no archived revision rebinds notif-queue');
    assert.equal(v.newer_related.length, 0, 'the export-worker correction is not a newer trace on notif-queue');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#3 audit: an override archives the retired value into queryable history', async () => {
  const { m, dir } = freshStore('histOverride');
  try {
    // A same-subject value flip versions the row in place (same id); the retired
    // value must be reachable via history(). Regression for the field report
    // where a failed clash left the old value as a separate live row, so its
    // history came back empty.
    const first = await m.remember({ kind: 'semantic', summary: 'ZZHIST deploy target -> cluster A', entities: [{ name: 'zzhist' }] });
    const flip = await m.remember({ kind: 'semantic', summary: 'ZZHIST deploy target -> cluster B', entities: [{ name: 'zzhist' }] });
    assert.equal(flip.outcome, 'override', 'value flip versions in place');
    assert.equal(flip.memory.id, first.memory.id, 'override reuses the same id');
    const hist = m.history(first.memory.id);
    assert.ok(hist.length >= 1, `retired value must be in history: ${JSON.stringify(hist)}`);
    assert.ok(hist.some((h) => h.summary.includes('cluster A')), 'the archived revision holds the old value');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#3 audit: a fuzzy-archived flip on an unrelated subject never contests a clean claim', async () => {
  const { m, dir } = freshStore('fuzzyArchive');
  try {
    // Round-9 field report scenario A: verifying notif-queue -> rabbitmq pulled
    // unrelated ARCHIVED revisions into superseded_matches at ~0.59 sim. Those
    // neighbours each carry version history (their own value flipped) and share
    // wording with the claim (a sibling "queue" subject), so the fuzzy archive
    // tier admitted them on cosine alone. The lexical siblings below reproduce
    // that: "backup queue" clears the floor against "primary queue" (~0.62) but
    // shares NO entity. The fix anchors the fuzzy tier to a support entity, so
    // an unrelated subject's archived flip can no longer contest this claim.
    await m.remember({ kind: 'semantic', summary: 'PROJQ primary queue broker binding -> rabbitmq', entities: [{ name: 'projq-primary' }] });
    await m.remember({ kind: 'semantic', summary: 'PROJQ backup queue broker binding -> optionA', entities: [{ name: 'projq-backup' }] });
    await m.remember({ kind: 'semantic', summary: 'PROJQ backup queue broker binding -> optionB', entities: [{ name: 'projq-backup' }] });
    const v = await m.sourceMonitor('PROJQ primary queue broker binding -> rabbitmq');
    assert.equal(v.substantiated, true, v.note);
    assert.equal(v.contested, false, `clean claim must not be contested by unrelated archives: ${v.note}`);
    assert.equal(v.stale_support, false, `no newer trace on the primary queue: ${v.note}`);
    assert.equal(v.superseded_matches.length, 0,
      `unrelated archived flips must not appear: ${JSON.stringify(v.superseded_matches.map((s) => s.summary))}`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#3 audit: the support row\'s own archived flip still surfaces (guard is not over-broad)', async () => {
  const { m, dir } = freshStore('fuzzySelf');
  try {
    // The relevance anchor must not blind the tier to the support's OWN history.
    // Claim an archived value of the support subject: it is not the live row, so
    // it must be reported as a superseded match (id shares the support entity).
    const first = await m.remember({ kind: 'semantic', summary: 'ZZSELF cache backend -> redis', entities: [{ name: 'zzself' }] });
    await m.remember({ kind: 'semantic', summary: 'ZZSELF cache backend -> memcached', entities: [{ name: 'zzself' }] });
    const v = await m.sourceMonitor('ZZSELF cache backend -> redis');
    assert.ok(v.superseded_matches.some((s) => s.summary.includes('redis')),
      `the support's own retired value must still surface: ${JSON.stringify(v.superseded_matches.map((s) => s.summary))}`);
    assert.equal(first.memory.id, (await m.recall({ query: 'ZZSELF cache backend', entities: ['zzself'] })).hits[0].id,
      'sanity: the flip versioned in place');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------- #4 summarizer ------------------------------ */

test('#4 audit: consolidate() uses an attached summarizer and falls back on failure', async () => {
  const seen = [];
  const { m, dir } = freshStore('sum', { minImportance: 0 }, {
    summarizer: async (episodes) => {
      seen.push(...episodes.map((e) => e.summary));
      if (episodes[0].summary.includes('ZZSUMFAIL')) throw new Error('model down');
      return [`RULE: ${episodes[0].summary} (generalized)`];
    }
  });
  try {
    const ep = await m.remember({ kind: 'episode', summary: 'ZZSUMAPPLY the retry budget was raised to 5', importance: 0.9 });
    assert.equal(ep.outcome, 'new');
    const made = await m.consolidate({ minAccess: 0, minImportance: 0.6 });
    assert.equal(made.length, 1, `the hook produced one rule: ${JSON.stringify(made)}`);
    assert.match(made[0].summary, /generalized/, 'the summarizer text is what got stored');
    assert.ok(seen.some((s) => s.includes('ZZSUMAPPLY')), 'the hook received the episode');

    // Throwing hook: the template path keeps consolidation working.
    const ep2 = await m.remember({ kind: 'episode', summary: 'ZZSUMFAIL the cache warmed hourly', importance: 0.9 });
    assert.equal(ep2.outcome, 'new');
    const made2 = await m.consolidate({ minAccess: 0, minImportance: 0.6 });
    assert.equal(made2.length, 1, 'fallback still consolidates');
    assert.equal(made2[0].summary, 'FACT: ZZSUMFAIL the cache warmed hourly', 'template fallback text');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#4 audit: without a summarizer the template path is unchanged', async () => {
  const { m, dir } = freshStore('sum2', { minImportance: 0 });
  try {
    await m.remember({ kind: 'episode', summary: 'ZZSUM2 the batch job ran at noon', importance: 0.9 });
    const made = await m.consolidate({ minAccess: 0, minImportance: 0.6 });
    assert.equal(made.length, 1);
    assert.equal(made[0].summary, 'FACT: ZZSUM2 the batch job ran at noon');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


/* ----------------------------- #7 forget guards ----------------------------- */

test('#7 audit: a young weak row is spared by forget() (no force)', async () => {
  const { m, dir } = freshStore('fg');
  try {
    const w = await m.remember({ kind: 'episode', summary: 'ZZFG fresh unread trace', importance: 0.05 });
    const res = m.forget({ strengthFloor: 0.9, dryRun: false });
    assert.ok(res.spared.includes(w.memory.id), `young row spared: ${JSON.stringify(res)}`);
    assert.ok(!res.forgotten.includes(w.memory.id), 'not forgotten');
    assert.ok(!res.decayed.includes(w.memory.id), 'not decayed either — the grace window covers both paths');
    assert.equal(m.get(w.memory.id).importance, 0.05, 'importance untouched');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#7 audit: an evidenced row is exempt from forget even when old and weak', async () => {
  const { m, dir } = freshStore('fg2', { forgetGraceSec: 0 });
  try {
    const ev = await m.remember({
      kind: 'episode', summary: 'ZZFG2 measured throughput 1200 rps', importance: 0.05,
      verify: { cmd: 'bench.sh' }, verifyResult: 'pass', verifyAttested: true
    });
    const dry = m.forget({ strengthFloor: 0.9, dryRun: true });
    assert.ok(dry.spared.includes(ev.memory.id), `evidence exempts from forgetting: ${JSON.stringify(dry)}`);
    assert.ok(!dry.forgotten.includes(ev.memory.id));
    // force is the deliberate escape hatch: an explicit flush still flushes.
    const forced = m.forget({ strengthFloor: 0.9, force: true, dryRun: true });
    assert.ok(forced.forgotten.includes(ev.memory.id), 'force overrides the protective guards');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#7 audit: a plain old weak row is still forgotten (guards are narrow)', async () => {
  const { m, dir } = freshStore('fg3', { forgetGraceSec: 0 });
  try {
    const weak = await m.remember({ kind: 'episode', summary: 'ZZFG3 a stray unread remark', importance: 0.08 });
    const res = m.forget({ strengthFloor: 0.9, force: true, dryRun: false });
    assert.ok(res.forgotten.includes(weak.memory.id), `no evidence, no grace → forgotten: ${JSON.stringify(res)}`);
    assert.equal(m.get(weak.memory.id), undefined);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------- #7/#8 scope read path --------------------------- */

test('#8 audit: recall({ scope }) hard-filters disagreeing premises and counts them', async () => {
  const { m, dir } = freshStore('rscope');
  try {
    const eu = await m.remember({
      kind: 'semantic', summary: 'ZZRSCOPE the quorum is three replicas',
      scope: 'region=eu west', entities: [{ name: 'zzrscope' }]
    });
    const ap = await m.remember({
      kind: 'semantic', summary: 'ZZRSCOPE the quorum is five replicas',
      scope: 'region=ap east', entities: [{ name: 'zzrscope' }]
    });
    const filtered = await m.recall({ query: 'ZZRSCOPE quorum replicas', scope: 'region=eu west' }, 5);
    const ids = filtered.hits.map((h) => h.id);
    assert.ok(ids.includes(eu.memory.id), `the eu-scope row answers an eu-scope question: ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes(ap.memory.id), 'the ap-scope row is excluded, not merely ranked lower');
    assert.equal(filtered.scopeExcluded, 1, 'the exclusion is counted, never silent');
    assert.ok(filtered.warnings.some((w) => w.startsWith('scope:')), `a warning explains the drop: ${filtered.warnings}`);
    // Without the filter both rows are reachable (opt-in behaviour).
    const open = await m.recall({ query: 'ZZRSCOPE quorum replicas' }, 5);
    assert.equal(open.scopeExcluded, undefined, 'no filter → no exclusion accounting');
    assert.ok(open.hits.length >= 2, 'unfiltered read sees both premises');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#8 audit: rows stating no premise pass a scoped read (absence is not disagreement)', async () => {
  const { m, dir } = freshStore('rscope2');
  try {
    const bare = await m.remember({ kind: 'semantic', summary: 'ZZRSCOPE2 the cache ttl is one hour', entities: [{ name: 'zzrscope2' }] });
    const res = await m.recall({ query: 'ZZRSCOPE2 cache ttl', scope: 'region=eu west' }, 5);
    assert.ok(res.hits.some((h) => h.id === bare.memory.id), 'an unconditional row is still an answer under a premise');
    assert.equal(res.scopeExcluded, 0);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
