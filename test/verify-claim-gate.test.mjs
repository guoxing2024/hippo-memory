/**
 * `memory_verify` over-confirmation — two defects from the 2026-09-25 field
 * report (stored as memories e0363f70 and 42476cff), both on the one gate whose
 * whole job is to stop hallucination.
 *
 *  D1  `verify("Python 是用来煮咖啡的")` answered SUBSTANTIATED at sim 0.485
 *      against a row about which language the backend is written in. The verdict
 *      is gated on `similarityThreshold` (0.32) — a RECALL bar asking "is
 *      anything topically nearby?" — while the tool promises a CLAIM-level
 *      answer. `claimThreshold` (0.75) is published by the same store's
 *      `diagnostics().thresholds` and consulted nowhere on this path.
 *      Measured in the hashing space, the bar alone cannot fix it: the
 *      hallucination scores 0.444 claim-to-summary, and so does a legitimate
 *      paraphrase of the same fact. What separates them is not the number, it
 *      is an ANCHOR — the claim binding the same subject/value, sharing an
 *      identifier, or restating the trace.
 *
 *  D2  Premise isolation is evaluated only against the row that was chosen as
 *      support (`if (queryScope && best.scope)`). The premise-aware ranking puts
 *      a scope-less row ABOVE one whose scope conflicts, so when the scope-less
 *      row wins, nothing compares the caller's premises against the conflicting
 *      trace: `substantiated: true, out_of_scope: false`, and the conflicting
 *      row surfaced in none of contradicting[] / newer_related[] /
 *      superseded_matches[]. The veto must run over the whole above-floor
 *      candidate set, and a veto that does NOT fire must still name the row.
 *      (Round-30 R2 narrowed the FIRST clause, not this one: a scope-less row
 *      keeps that rank only when it states this claim — same subject/value, a
 *      shared identifier, or the sentence itself. A scope-less row about
 *      something else no longer takes the seat, so in the D2 fixture below the
 *      conflicting row is now named as `support` rather than in
 *      `scope_conflicts`; the requirement "named in the answer" is unchanged.)
 *
 * `weak_match` is the verdict these cases are measured against: something
 * cleared the RECALL floor and nothing anchors the claim to it. Not a yes and
 * not an empty store — the closest trace is attached as `support`, labelled,
 * for inspection only.
 *
 * Second field report on the SAME gate, two residual defects found by testing
 * the shipped 0.3.2 under `bge-small-zh-v1.5` (the reporter could not run this
 * suite — the published tarball carries only `dist/`):
 *
 *  R1  中文值冲突漏判 — the dangerous direction. `probe-reg 副本数 -> 3` in the
 *      store, then `verify("probe-reg 副本数是 99")` answered SUBSTANTIATED while
 *      `verify("probe-reg 副本数 -> 99")` answered CONTRADICTED. The value check
 *      demanded `claimParts()` on BOTH sides, and that parser knows only
 *      `主体 -> 值` plus a table of English copulas, so a Chinese claim parsed to
 *      null, the check became unreachable, and the run fell through to an anchor
 *      that high similarity alone can satisfy. The 0.3.2 notes described the
 *      Chinese risk as "fewer yes", which is the safe direction; a wrong value
 *      being blessed is the unsafe one and was not listed.
 *
 *  R2  矛盾路径缺锚定 — D1 put an anchor in front of the yes; the contradiction
 *      path never got one. `NEGATION_RE`'s CJK branch matches a single character,
 *      so any stored row containing 不 made an unrelated negated claim read as
 *      refuted: `the moon is made of cheese` came back CONTRADICTED against a
 *      row about service restarts. Polarity was compared with no subject anchor,
 *      before the anchor gate, on the strength of a similarity bar built for
 *      recall.
 *
 *  R3  标识符的数字被当成值 — `numberFlip` read its quantity out of the text AFTER
 *      the shared prefix, so for `KAPPA-1` vs `KAPPA-2` the `-` its own lookbehind
 *      needed was sliced away and two different tickets were judged to contradict
 *      each other. Fixed by matching sticky on the full text at the divergence
 *      offset — which, alone, moved those pairs from a false CONTRADICTED to a
 *      false SUBSTANTIATED, so the anchor gate also got an identifier veto.
 *
 *  R4  that veto was blind to labels that START with digits. `probe-k8 2024z …`
 *      vs `… 2025z …` diverges inside a digit run: the R3 fix correctly refuses to
 *      read a value there, and nothing else was holding the shape. The pre-R3
 *      build had covered it by accident — measured across three builds on disk
 *      (`.hippo/probe-r4-three-builds.mjs`): CONTRADICTED with the note binding the
 *      truncated subject `"probe-k8 202"` to `"4"` vs `"5"`, then SUBSTANTIATED
 *      0.793 hashing / 0.949 bge on the R3 build, then WEAK_MATCH. Retiring a
 *      guard has to come with the guard it was standing in for, not with the
 *      verdict it produced.
 *
 *  R4b  closing R4 by adding branches to the label grammar turned out to be the
 *      wrong lever. A family sweep (`.hippo/probe-numeric-family.mjs`, 14 shapes,
 *      run against both builds) showed 6 shapes still answered SUBSTANTIATED in
 *      BOTH — ISO dates, a year-month cut, an IP's last octet, `us-east1a`, `h7`,
 *      and the CJK sentence carrying any of them. Three different reasons, only
 *      one of them "the grammar named nothing": the dotted branch harvested
 *      `10.20.30` from both sides of an IP pair (the divergent octet fell outside
 *      the token), and `probe-k8 2024z` is vetoed today *only* because no branch
 *      harvests `probe-k8` — the comparison asks whether the two label sets are
 *      DISJOINT, so harvesting the shared prefix as a token cancels the veto.
 *      Growing the grammar is not monotone in safety. The fix is therefore the
 *      comparison: a label is any run of alphanumerics joined by `- _ . : /` that
 *      contains a digit, and the veto fires when EACH side names a label the other
 *      does not — which keeps a trace's extra detail from vetoing a partial
 *      restatement (R1's refinement ruling).
 *
 *  R4c  the digit requirement in that definition silently retired the old
 *      `[0-9a-f]{7,40}` branch, and a commit sha with no digit at all stopped
 *      being a label: `commit deadbeef …` asked back as `commit cafebabe …` went
 *      WEAK_MATCH on the R3 build, WEAK_MATCH on the R4 build, SUBSTANTIATED on
 *      the first R4b cut (`.hippo/probe-digitless.mjs`). Same lesson as R4, one
 *      round later, in the same fix. What makes the restoration safe is R4b's
 *      other half: under a both-private comparison, harvesting MORE can only
 *      enlarge a side's private set, so widening the harvest cannot undo a veto.
 *      The boundary it still leaves open is the word case — `long-tailed` vs
 *      `short-tailed` substantiates on every build, which is why the digit rule
 *      stays (arm (d) of `.hippo/subtract-r4b.sh` turns 5 and 22 red without it).
 *
 * Contract under test: three verdict shapes stay distinct — no match at all, a
 * weak/topical match (never a yes), and claim-level support; a caller-stated
 * scope vetoes on conflicting premises wherever they are found; a value the
 * trace disagrees with is a contradiction no matter which side of it the
 * parser could read; and a polarity flip counts only when the two texts are
 * about the same thing.
 *
 * Every subject below is unique to its own case and the probe sentence is
 * never stored: a bug note that quotes the failing claim verbatim becomes the
 * strongest match in the store and misdirects `support.id` (the reporter's
 * methodology note — all their conclusions were re-taken after clearing that
 * self-contamination).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HippoMemory } from '../dist/index.js';

function freshStore(options) {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-claimgate-'));
  return { m: new HippoMemory({ dbPath: join(dir, 'test.db'), ...(options ? { options } : {}) }), dir };
}

const write = (m, payload) => m.remember({ kind: 'semantic', tags: ['fact'], ...payload });

/* ---- D1: a topical-only match must not be stamped as support ---------- */

test('verify D1: a topically-related trace is WEAK support, not a substantiated yes', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, {
      summary: 'Python 是后端服务使用的编程语言',
      detail: '网关与计费服务用 Python 编写，跑在 uvicorn 上。',
      entities: ['python', 'backend']
    });
    const v = await m.sourceMonitor('Python 是用来煮咖啡的');
    assert.ok(v.support, 'the closest trace is still shown for inspection');
    assert.equal(v.substantiated, false, `sim ${v.support.score.toFixed(2)} is above the recall floor but claims nothing`);
    assert.equal(v.weak_match, true, 'a below-claim-bar match must be labelled as its own verdict');
    assert.match(v.note, /WEAK/i);
    assert.doesNotMatch(v.note, /^SUBSTANTIATED/, 'the yes must not be the headline');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify D1: an empty store and a weak match are not the same answer', async () => {
  const { m, dir } = freshStore();
  try {
    const v = await m.sourceMonitor('zznothing at all matches this unrelated claim xyzzy');
    assert.equal(v.substantiated, false);
    assert.equal(v.weak_match ?? false, false, 'no trace at all is not a weak match');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify D1: restating the stored claim still substantiates', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'api gateway -> envoy proxy', detail: '替换掉 nginx。', entities: ['gateway'] });
    const v = await m.sourceMonitor('api gateway -> envoy proxy');
    assert.equal(v.substantiated, true, `exact restatement was demoted: ${v.note}`);
    assert.equal(v.weak_match ?? false, false);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify D1: a shared identifier anchors the claim to the trace', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: '工单 OPS-417 决定 cache backend -> redis', entities: ['cache', 'ops-417'] });
    const v = await m.sourceMonitor('OPS-417 的 cache backend 定下来了');
    assert.ok(v.support, `the identifier must clear the recall floor: ${v.note}`);
    assert.equal(v.substantiated, true, `an exact ticket id is stronger evidence than cosine: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify D1: the same subject and value phrased differently substantiates', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the billing database is postgres', entities: ['billing'] });
    const v = await m.sourceMonitor('the billing database runs on postgres');
    assert.ok(v.support, `the pair must clear the recall floor: ${v.note}`);
    assert.equal(v.substantiated, true, `same subject, same value, no clash: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* ---- D2: premise veto across the candidate set ------------------------ */

test('verify D2: a conflicting-scope row vetoes even when a scope-less row is in the store', async () => {
  const { m, dir } = freshStore();
  try {
    const scoped = await write(m, {
      summary: 'gto 内存上限 4GB',
      detail: 'gto 服务在 prod 环境的容器内存上限是 4GB。',
      entities: ['gto'],
      scope: 'env=prod'
    });
    const unscoped = await write(m, {
      summary: 'gto 服务的内存占用需要关注',
      detail: '压测时 gto 的 RSS 涨得比较快。',
      entities: ['gto'],
      tags: ['observation']
    });
    const v = await m.sourceMonitor('gto 内存上限是 4GB', { scope: 'env=dev' });
    assert.equal(v.out_of_scope, true, `the store holds a premise the caller contradicts: ${v.note}`);
    assert.equal(v.substantiated, false, 'a scope-less trace must not bless a premise-bound claim');
    // R2 (round 30) moved WHERE the vetoing row is named. "gto 服务的内存占用需要关注" states
    // a different sentence, so it no longer takes the support seat for merely naming no
    // premise; the `env=prod` row the caller contradicts is now the support itself, and the
    // veto fires from `supportDiffers`. The D2 requirement is that the conflicting row is
    // NAMED in the answer, not that it sits in one particular array, so both exits are
    // accepted — while the seat assertion below pins which route this store now takes.
    const named = (v.scope_conflicts ?? []).some((r) => r.id === scoped.memory.id) || v.support?.id === scoped.memory.id;
    assert.ok(named, 'the vetoing row must be named, not silently demoted out of the answer');
    assert.notEqual(v.support?.id, unscoped.memory.id, 'and the seat is no longer the scope-less neighbour');
    assert.match(String(v.note), /env=prod/, `the note names the premise it is reporting: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify D2: the veto still fires when the scoped row is the support (unchanged)', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto 内存上限 4GB', detail: 'prod 容器内存上限 4GB。', entities: ['gto'], scope: 'env=prod' });
    const v = await m.sourceMonitor('gto 内存上限是 4GB', { scope: 'env=dev' });
    assert.equal(v.out_of_scope, true);
    assert.equal(v.substantiated, false);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify D2: no conflicting premise anywhere leaves the verdict alone', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto 内存上限 4GB', detail: '默认容器内存上限。', entities: ['gto'] });
    const v = await m.sourceMonitor('gto 内存上限 4GB', { scope: 'env=dev' });
    assert.equal(v.out_of_scope, false, 'an unconditional trace has no premise to disagree with');
    assert.equal(v.substantiated, true, `the veto must not invent a conflict: ${v.note}`);
    assert.equal((v.scope_conflicts ?? []).length, 0);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify D2: a matching premise still substantiates and names no conflict', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto 内存上限 4GB', detail: 'dev 环境实测。', entities: ['gto'], scope: 'env=dev' });
    await write(m, { summary: 'gto 内存上限 8GB', detail: 'prod 环境实测。', entities: ['gto'], scope: 'env=prod' });
    const v = await m.sourceMonitor('gto 内存上限 4GB', { scope: 'env=dev' });
    assert.equal(v.substantiated, true, `the caller-scope trace must win: ${v.note}`);
    assert.equal(v.support?.scope, 'env=dev');
    assert.equal((v.scope_conflicts ?? []).length, 0, 'the row the caller agrees with is not a conflict');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* ---- R1: the value check must survive the side the parser cannot read ---- */

test('verify R1: a Chinese copula claim with a different value is a contradiction, not a yes', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, {
      summary: 'probeR1a-reg 副本数 -> 3',
      detail: 'probeR1a-reg 在 staging 的副本数配置。',
      entities: ['prober1a'],
      scope: 'env=staging'
    });
    const v = await m.sourceMonitor('probeR1a-reg 副本数是 99', { scope: 'env=staging' });
    assert.equal(v.substantiated, false, `a wrong value must never be blessed: ${v.note}`);
    assert.equal(v.contradicted, true, `the stored row binds this subject to another value: ${v.note}`);
    assert.match(v.note, /99/);
    assert.match(v.note, /\b3\b/);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R1: two prose rows that differ only in their number are a contradiction', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probeR1b-gateway 超时设定为 30 秒', detail: 'probeR1b-gateway 上游超时。', entities: ['prober1b'] });
    const v = await m.sourceMonitor('probeR1b-gateway 超时设定为 90 秒');
    assert.equal(v.substantiated, false, `no parser read either side, yet the value flipped: ${v.note}`);
    assert.equal(v.contradicted, true, `same wording, different number: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R1: the stored value phrased in Chinese still substantiates', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probeR1c-reg 副本数 -> 3', detail: 'probeR1c-reg 在 staging 的副本数配置。', entities: ['prober1c'] });
    const v = await m.sourceMonitor('probeR1c-reg 副本数是 3');
    assert.equal(v.contradicted, false, `the fix must not manufacture a conflict out of agreement: ${v.note}`);
    assert.equal(v.substantiated, true, `the reverse guard (right value, Chinese wording) stays a yes: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R1: a claim that keeps the stored number and adds detail is a refinement, not a clash', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probeR1d-cache TTL -> 300 秒，最多 3 个分片', entities: ['prober1d'] });
    const v = await m.sourceMonitor('probeR1d-cache TTL 是 300 秒');
    assert.equal(v.contradicted, false, `restating part of the value is not disagreeing with it: ${v.note}`);
    assert.equal(v.substantiated, true, `the paraphrase is still support: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R1: a non-numeric Chinese value clashes the same way', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probeR1e-队列 -> rabbitmq', detail: 'probeR1e 的消息队列选型。', entities: ['prober1e'] });
    const v = await m.sourceMonitor('probeR1e-队列 是 redis');
    assert.equal(v.substantiated, false, `redis is not what the row binds here to: ${v.note}`);
    assert.equal(v.contradicted, true, `the one-sided parse must still compare values: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R1: a non-numeric Chinese value that agrees stays a yes', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probeR1f-队列 -> rabbitmq', detail: 'probeR1f 的消息队列选型。', entities: ['prober1f'] });
    const v = await m.sourceMonitor('probeR1f-队列 是 rabbitmq');
    assert.equal(v.contradicted, false, `the one-sided tail must not fire on agreement: ${v.note}`);
    assert.equal(v.substantiated, true, `Chinese paraphrase of the stored value is support: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R1: a question that merely mentions the subject invents no clash', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probeR1g-target -> prod cluster B', entities: ['prober1g'] });
    const v = await m.sourceMonitor('which cluster was the probeR1g-target before');
    assert.equal(v.contradicted, false, `"before" is not a value bound to the subject: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R1: a number inside an identifier is not a competing value', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probeR1h record KAPPA-1', detail: 'probeR1h 的标记：DETAIL-MARKER-BETA-2222。', entities: ['prober1h'] });
    const v = await m.sourceMonitor('probeR1h record needs DETAIL-MARKER-BETA-2222');
    assert.equal(v.contradicted, false, `1 and 2222 are label fragments, not the same slot: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* ---- R2: a polarity flip is a contradiction only about the same thing ---- */

test('verify R2: an unrelated claim is not refuted by whatever row happens to be nearby', async () => {
  // The floor is dialled to 0 on purpose: the defect is structural (polarity
  // compared with no subject anchor), and under bge the reported pair cleared the
  // real 0.32 floor by semantic similarity alone. Pinning the floor keeps the
  // case deterministic with the built-in hashing encoder and no model download.
  const { m, dir } = freshStore({ similarityThreshold: 0 });
  try {
    await write(m, { summary: 'probeR2a 服务重启会打断长连接', detail: 'probeR2a 发布窗口内的观察。', entities: ['prober2a'] });
    const v = await m.sourceMonitor('python is not a compiled language');
    assert.equal(v.contradicted, false, `nothing here is about python: ${v.note}`);
    assert.equal(v.substantiated, false, `${v.note}`);
    assert.doesNotMatch(v.note, /^CONTRADICTED/);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R2: an unanchored polarity mismatch is labelled weak and says what it saw', async () => {
  const { m, dir } = freshStore({ similarityThreshold: 0 });
  try {
    await write(m, { summary: 'probeR2b 服务重启会打断长连接', detail: 'probeR2b 发布窗口内的观察。', entities: ['prober2b'] });
    const v = await m.sourceMonitor('the moon is not made of cheese');
    assert.equal(v.contradicted, false, `a coincidence of negation is not a verdict: ${v.note}`);
    assert.equal(v.weak_match, true, `the nearby opposite-polarity trace stays a lead: ${v.note}`);
    assert.match(v.note, /WEAK/i);
    assert.match(v.note, /nothing anchors/i);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R2: a polarity flip on the same subject is still CONTRADICTED', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the billing gateway routes long-lived websocket connections', entities: ['billing-gateway'] });
    const v = await m.sourceMonitor('the billing gateway does not route websocket connections');
    assert.equal(v.contradicted, true, `the anchor must not cost the feature it guards: ${v.note}`);
    assert.ok(v.contradiction ?? v.contradicting?.length, 'the refuting row is named');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R2: the same anchor rule holds for a Chinese subject', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probeR2d-网关 支持 websocket 长连接', detail: 'probeR2d 入口网关能力。', entities: ['prober2d'] });
    const v = await m.sourceMonitor('probeR2d-网关 不支持 websocket 长连接');
    assert.equal(v.contradicted, true, `same wording up to the negation is the real case: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R2: an anchored polarity mismatch does not fall back into a yes', async () => {
  // The counterpart to the two cases above. Wording ties the two texts together
  // (anchor 4 covers the claim's distinctive tokens 3/3), so the anchor gate would
  // stamp a yes — but the polarity is flipped, and nothing anchors it as a
  // refutation either. The belt is what keeps this a lead.
  //
  // The second half is the differential: the SAME row asked without the negation
  // does get a yes (sim 0.68 hashing / 0.90 bge). Without it, "weak_match" here
  // could just mean the pair was never anchorable, which is a different claim.
  // Note there is deliberately no shared identifier in either text — give both
  // sides one and the polarity anchor fires, turning this into a CONTRADICTED.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'cache warmup -> warmed during startup' });
    const v = await m.sourceMonitor('during startup the cache is not warmed');
    assert.equal(v.substantiated, false, `wording anchors it, polarity refutes it: ${v.note}`);
    assert.equal(v.contradicted, false, `a refutation needs a subject anchor, not shared wording: ${v.note}`);
    assert.equal(v.weak_match, true, v.note);
    assert.match(v.note, /OPPOSITE polarities/i);

    const ok = await m.sourceMonitor('the cache is warmed during startup');
    assert.equal(ok.substantiated, true, `same row, same wording, matching polarity: ${ok.note}`);
    assert.equal(ok.weak_match, false, ok.note);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* ---- R3: the digits inside an identifier are not the value slot ---------- */

test('verify R3: two identifiers that differ only in their digits are not a value flip', async () => {
  // `numberFlip` compares "same wording, then a different number", but it ran its
  // quantity regex on the text AFTER the shared prefix. For `KAPPA-1` vs `KAPPA-2`
  // the prefix is `kappa-`, so the `-` that `LEADING_QUANTITY_RE`'s lookbehind
  // needs to reject an identifier was sliced away, and the ticket number was read
  // as the value the two rows disagree about.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'KAPPA-1 record', detail: 'ticket KAPPA-1 is the cache warmup record.' });
    const v = await m.sourceMonitor('KAPPA-2 record');
    assert.equal(v.contradicted, false, `1 and 2 are label fragments of two tickets, not one slot: ${v.note}`);
    assert.doesNotMatch(v.note, /binds "kappa-"/, `the subject must not be cut at a dangling hyphen: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R3: that same pair must not be stamped as a yes either', async () => {
  // This is the case that makes the R3 fix more than a regex tweak. Narrowing
  // `numberFlip` alone moves the verdict from a false CONTRADICTED to a false
  // SUBSTANTIATED — measured 0.48 in the hashing space, anchored by the wording
  // route because `record` is the claim's only distinctive token and the trace
  // carries it. A different ticket number has to outrank shared wording.
  //
  // The differential is the same identifier asked back: still a yes, so the belt
  // cannot be read as "identifier-shaped text is never anchorable".
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'KAPPA-1 record', detail: 'ticket KAPPA-1 is the cache warmup record.' });
    const v = await m.sourceMonitor('KAPPA-2 record');
    assert.equal(v.substantiated, false, `shared wording cannot outrank a different ticket: ${v.note}`);
    assert.equal(v.weak_match, true, `a cleared trace about another ticket is still a lead: ${v.note}`);
    assert.match(v.note, /different identifier/i, `the note must say what it saw: ${v.note}`);
    assert.doesNotMatch(v.note, /nothing anchors/i, `the wording DOES anchor here: ${v.note}`);
    assert.doesNotMatch(v.note, /OPPOSITE polarities/i, `no polarity is involved: ${v.note}`);

    const same = await m.sourceMonitor('KAPPA-1 record');
    assert.equal(same.substantiated, true, `same identifier, same wording: ${same.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R3 control: a numeric flip with no identifier boundary still contradicts', async () => {
  // The guard the R3 fix adds must stay at the boundary. Here the two rows share
  // everything up to a space and then state different quantities, which is the
  // shape `numberFlip` was written for.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probeR3d-gateway 超时设定为 30 秒' });
    const v = await m.sourceMonitor('probeR3d-gateway 超时设定为 90 秒');
    assert.equal(v.contradicted, true, `same wording, different number: ${v.note}`);
    assert.equal(v.substantiated, false, v.note);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* ---- R4: labels whose digits are the part that differs ------------------- */

test('verify R4: a digit-initial label that differs inside its own digits is not a yes', async () => {
  // `2024z` / `2025z` diverge in the middle of a digit run, so the R3-correct
  // quantity read declines to call either side a value. Fine — but then the
  // shared wording anchors a yes (measured 0.787 hashing / 0.944 bge on the pair
  // below, where the pre-R3 build answered CONTRADICTED, accidentally, by binding
  // the truncated subject `probe-k8 202` to `4` vs `5`). The veto that catches
  // `KAPPA-1` needs to see a label that starts with a digit too.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probe-k8 2024z quarter rollout plan', entities: ['probe-k8'] });
    const v = await m.sourceMonitor('probe-k8 2025z quarter rollout plan');
    assert.equal(v.substantiated, false, `two quarter labels are two subjects: ${v.note}`);
    assert.equal(v.weak_match, true, `a cleared trace about another label is still a lead: ${v.note}`);
    assert.match(v.note, /2024z/, `the note must name the label the trace carries: ${v.note}`);
    assert.match(v.note, /2025z/i, `and the one the claim carries: ${v.note}`);

    const same = await m.sourceMonitor('probe-k8 2024z quarter rollout plan');
    assert.equal(same.substantiated, true, `same label, same wording: ${same.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R4: the same shape with a quarter code is not a yes either', async () => {
  // `2025Q1` vs `2026Q1` — the digits and the letter are one token, and the run
  // that differs is longer than one character, so neither the value parser nor a
  // single-digit rule reaches it.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probe-k10 freeze scheduled for 2025Q1 window', entities: ['probe-k10'] });
    const v = await m.sourceMonitor('probe-k10 freeze scheduled for 2026Q1 window');
    assert.equal(v.substantiated, false, `a different quarter is a different freeze: ${v.note}`);
    assert.equal(v.weak_match, true, v.note);
    assert.match(v.note, /2026q1/i, `the note names both labels: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R4: a bare number whose digits diverge is not a yes either', async () => {
  // Nothing is glued to these numbers, so `identifierTokens`'s hyphen and dot
  // grammars name nothing here — yet the divergence is still inside a digit run,
  // which is exactly where `numberFlip` declines to call a value. Same hole, the
  // plainest shape of it.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'plan for 2024 quarter rollout approval' });
    const v = await m.sourceMonitor('plan for 2025 quarter rollout approval');
    assert.equal(v.substantiated, false, `2024 and 2025 are not the same plan: ${v.note}`);
    assert.equal(v.weak_match, true, v.note);

    const same = await m.sourceMonitor('plan for 2024 quarter rollout approval');
    assert.equal(same.substantiated, true, `same year, same wording: ${same.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R4 control: a standalone quantity stated after words still contradicts', async () => {
  // Widening the veto to numbers must not eat the real contradictions. Here the
  // divergence is at a number that begins its own word, which is the case
  // `numberFlip` was written for, and the two rows cannot both be true.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'we run 3 nodes for the cache' });
    const v = await m.sourceMonitor('we run 5 nodes for the cache');
    assert.equal(v.contradicted, true, `3 and 5 nodes is a value flip: ${v.note}`);
    assert.equal(v.substantiated, false, v.note);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* ---- R4b: the rest of the family the report's two shapes belong to -------- */
/*
 * Measured with `.hippo/probe-numeric-family.mjs` on the PRE-R4 build and on the
 * R4 build: both answer SUBSTANTIATED for every row below, so these are not the
 * regression R4 closed — they are the hole R4's fix stops short of. Each is the
 * same structure: identical wording, and the part that differs is a label that
 * carries digits. They broke in three different ways, which is why one more
 * regex branch could not have closed them:
 *   `2024-05-01` / `h7` / `us-east1a` — no branch of the label grammar named
 *     anything, so both label sets were empty and a rule that asks "did either
 *     side name a label the other did not?" had nothing to compare.
 *   `10.20.30.41` / `10.20.30.42` — the dotted branch harvested `10.20.30` from
 *     BOTH sides, stopping short of the octet that differs. The labels looked
 *     shared.
 *   `probe-k8 2024z` — vetoed today only because no branch harvests `probe-k8`.
 *     Add such a branch and the two sets start intersecting, which UNDOES the
 *     veto: under a disjointness test, widening the grammar moves verdicts back
 *     toward the dangerous side. That is the reason the comparison is what
 *     changes here, not the grammar.
 */

test('verify R4b: a release date that differs inside its own digits is not a yes', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto released on 2024-05-01 the patch' });
    const v = await m.sourceMonitor('gto released on 2024-05-02 the patch');
    assert.equal(v.substantiated, false, `two release dates are two releases: ${v.note}`);
    assert.equal(v.weak_match, true, v.note);
    assert.match(v.note, /2024-05-01/, `the note names the stored label: ${v.note}`);
    assert.match(v.note, /2024-05-02/, `and the claimed one: ${v.note}`);
    assert.doesNotMatch(v.note, /nothing anchors/i, `the wording DOES anchor here: ${v.note}`);

    const same = await m.sourceMonitor('gto released on 2024-05-01 the patch');
    assert.equal(same.substantiated, true, `same date, same wording: ${same.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R4b: a year-month cut is the same shape as a full date', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto shipped in 2024-05 cut' });
    const v = await m.sourceMonitor('gto shipped in 2024-06 cut');
    assert.equal(v.substantiated, false, v.note);
    assert.equal(v.weak_match, true, v.note);
    assert.match(v.note, /different identifier/i, v.note);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R4b: the octet that differs must be inside the label being compared', async () => {
  // The dotted run is one label, not a prefix that ends where a branch stops
  // reading: 10.20.30.41 and 10.20.30.42 are two listeners.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gateway listens on 10.20.30.41 tcp' });
    const v = await m.sourceMonitor('gateway listens on 10.20.30.42 tcp');
    assert.equal(v.substantiated, false, `one address is not the other: ${v.note}`);
    assert.equal(v.weak_match, true, v.note);
    assert.match(v.note, /10\.20\.30\.41/, `the note must print the whole label: ${v.note}`);
    assert.match(v.note, /10\.20\.30\.42/, v.note);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R4b: a zone code with its digits between letters is a label too', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto runs in us-east1a zone' });
    const v = await m.sourceMonitor('gto runs in us-east1b zone');
    assert.equal(v.substantiated, false, `1a and 1b are two zones: ${v.note}`);
    assert.equal(v.weak_match, true, v.note);
    assert.match(v.note, /us-east1a/i, v.note);
    assert.match(v.note, /us-east1b/i, v.note);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R4b: one letter after the number is still a different host', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'node h7 wins the election' });
    const v = await m.sourceMonitor('node h8 wins the election');
    assert.equal(v.substantiated, false, `h7 and h8 are two nodes: ${v.note}`);
    assert.equal(v.weak_match, true, v.note);
    assert.doesNotMatch(v.note, /nothing anchors/i, v.note);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R4b: the same rule holds when the sentence is Chinese', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto 的上线日期是 2024-05-01' });
    const v = await m.sourceMonitor('gto 的上线日期是 2024-05-02');
    assert.equal(v.substantiated, false, `the label grammar is not language-specific: ${v.note}`);
    assert.equal(v.weak_match, true, v.note);
    assert.match(v.note, /2024-05-02/, v.note);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R4b control: labels the claim never states cannot veto it', async () => {
  // The other side of the comparison. A trace routinely carries more labels than
  // the claim does — the date it was written, a shard count, a ticket. Vetoing on
  // "the two sets are not equal" would demote every partial restatement, which is
  // the refinement R1 already ruled a yes. The veto needs the CLAIM to name a
  // label the trace does not, as well.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probeR4x-cache TTL -> 300 秒，复盘于 2024-05-01' });
    const v = await m.sourceMonitor('probeR4x-cache TTL 是 300 秒');
    assert.equal(v.contradicted, false, v.note);
    assert.equal(v.substantiated, true, `the trace holds more labels than the claim needs: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R4b: a hex label with no digits at all is still a different commit', async () => {
  // The digit requirement is what keeps `long-tailed` out of the label set, and it
  // nearly cost the other half of the old grammar for nothing: `[0-9a-f]{7,40}` used
  // to harvest `deadbeef`, and a sha is exactly the shape where a run of
  // letters-only-hex is normal. Measured on three builds (`.hippo/probe-digitless.mjs`):
  // the pair below was WEAK_MATCH on the pre-R4 build and on the R4 build, and
  // SUBSTANTIATED 0.750 here — the same transfer R4 was, this time introduced by
  // R4b's own filter. Widening a harvest that can only downgrade is monotone under
  // the both-private comparison, so this shape comes back without touching the rest.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'commit deadbeef fixes the leak' });
    const v = await m.sourceMonitor('commit cafebabe fixes the leak');
    assert.equal(v.substantiated, false, `two different commits: ${v.note}`);
    assert.equal(v.weak_match, true, v.note);
    assert.match(v.note, /deadbeef/, `the note names the stored commit: ${v.note}`);
    assert.match(v.note, /cafebabe/i, `and the one asked about: ${v.note}`);

    const same = await m.sourceMonitor('commit deadbeef fixes the leak');
    assert.equal(same.substantiated, true, `same commit, same wording: ${same.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* ---- R5: a shape the fifth-round report cited that the suite never pinned -- */

test('verify anchor boundary: a Chinese value with no space and no copula still flips', async () => {
  // Every earlier R1 fixture either used `主体 -> 值`, an English copula, or spaced
  // Chinese (`超时设定为 30 秒`). The report's fifth round asked `超时30秒` against
  // `超时90秒` — nothing between the subject and the number — and the value parser
  // has to find the digits there too. Two builds place this shape: a staged copy
  // with no anchor at all (`anchoredBy` count 0 in `.hippo/desktop-032/stage/core`)
  // reads SUBSTANTIATED 0.64 here, while the D1+R2 build (`quantityAt` 0, i.e.
  // pre-R3, `.hippo/desktop-032-prer3/core`) already reads CONTRADICTED. So the
  // route belongs to the anchor work, not to R3 — and no build between D1 and R1
  // survives on disk, so the pair is pinned in the hashing fallback space, which
  // is where the weaker of the two spaces is. Same verdict under bge (`.hippo/
  // probe-report5.txt`).
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probe5-gateway 超时30秒' });
    const v = await m.sourceMonitor('probe5-gateway 超时90秒');
    assert.equal(v.contradicted, true, `digits glued to the subject still carry the value: ${v.note}`);
    assert.equal(v.substantiated, false, v.note);
    assert.match(v.note, /"30"/, `the note names the stored value: ${v.note}`);
    assert.match(v.note, /"90"/, `and the one asked about: ${v.note}`);

    const agree = await m.sourceMonitor('probe5-gateway 超时30秒');
    assert.equal(agree.substantiated, true, `same value, same spelling: ${agree.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});


/* ---- V1: the round-5 census — the VALUE SLOT never entered the verdict ------- */
//
// Stored "gto deploys to staging cluster", asked about "production": SUBSTANTIATED
// at 0.87 (bge) / 0.75 (hash). Asked about "zzzqqq" — a string that names nothing
// in any language — SUBSTANTIATED at 0.83 / 0.77. The claim was certified without
// the value position being read at all, so no wordlist of environment names could
// have changed the outcome.
//
// Attribution was measured per shape rather than inferred: .hippo/probe-anchor-name.mjs
// runs against an instrumented COPY of dist (.hippo/instrument-anchor.cjs appends the
// anchor name to the yes-path note; src is never touched). Six of the eight census
// shapes ride anchor #5 (claim-to-summary similarity); three ride #4 (the trace
// carrying the claim's wording), which is reachable because `carriesTheWording`
// counts only tokens of >= 6 characters, so "9999" and "eu-west" (split past the
// hyphen) are invisible to it while the surrounding context words are not.
//
// Both anchors sit downstream of one absence: valueFlip (src/memory.ts:523) is the
// only route that reads a value at all, and when neither side parses, its single
// fallback is numberFlip — which requires BOTH sides to state a number (:226). A
// numeric flip therefore has a grammar-independent route and an alphabetic flip has
// none. That is the structural reason test 38 (超时30秒 / 超时90秒) is caught while
// "staging" / "production" is not: the copula table at :3169 holds eight
// alternatives, and "deploys to", "runs in", "enters", "serves as", "ships in" are
// not in it.
//
// The fix follows the numberFlip precedent (position, not morphology, not a lexicon)
// and produces WEAK_MATCH, not CONTRADICTED: "commit A fixes the leak" does not
// refute "commit B fixes the leak", because a predicate can hold of several values.
// Refuting stays the copula route's job, where the store does know the slot is
// single-valued.

/** A one-word swap in the value slot must come back as a lead, never as a yes. */
const expectWordSwap = async (m, claim, storedWord, claimedWord) => {
  const v = await m.sourceMonitor(claim);
  assert.equal(v.substantiated, false, `the claim's "${claimedWord}" was certified against a trace stating "${storedWord}": ${v.note}`);
  assert.equal(v.contradicted, false, `one word apart is not a refutation — the predicate may hold of both: ${v.note}`);
  assert.equal(v.weak_match, true, `expected WEAK_MATCH, got: ${v.note}`);
  assert.match(v.note, new RegExp(`"${storedWord}"`), `the note must name the stored value: ${v.note}`);
  assert.match(v.note, new RegExp(`"${claimedWord}"`), `and the one asked about: ${v.note}`);
  return v;
};

test('verify V1: an environment value outside the copula table is not certified', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto deploys to staging cluster' });
    await expectWordSwap(m, 'gto deploys to production cluster', 'staging', 'production');
    const same = await m.sourceMonitor('gto deploys to staging cluster');
    assert.equal(same.substantiated, true, `the value the row states must still substantiate: ${same.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V1: the decisive control — a nonsense word in the value slot is not certified either', async () => {
  // If this shape is refused after the fix, the value POSITION is being read,
  // which is the only claim that separates a positional rule from a wordlist.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto deploys to staging cluster' });
    await expectWordSwap(m, 'gto deploys to zzzqqq cluster', 'staging', 'zzzqqq');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V1: a bare number in the value slot is not certified by the wording anchor', async () => {
  // Anchor #4 was the route here: "deploys" and "cluster" are the claim's only
  // >= 6-character tokens and both appear in the trace, so "the trace carries the
  // claim's wording" was satisfied while 9999 was never looked at.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto deploys to staging cluster' });
    await expectWordSwap(m, 'gto deploys to 9999 cluster', 'staging', '9999');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V1: a hyphen-split region value is not certified', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto gateway runs in us-east region' });
    await expectWordSwap(m, 'gto gateway runs in eu-west region', 'us-east', 'eu-west');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V1: a state-machine value is not certified', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto worker enters draining state' });
    await expectWordSwap(m, 'gto worker enters running state', 'draining', 'running');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V1: the word case closes on the same route, and the verbatim twin still passes', async () => {
  // This is the shape ROADMAP.md carried as the label rule's unpayable price:
  // "flag long-tailed cat mode" asked back as "flag short-tailed cat mode" answered
  // SUBSTANTIATED on every build since D1, because the label harvest demands a digit
  // and "long-tailed" has none. A positional rule needs no digit, so the residue
  // goes with it — and the digit filter stays where it is, which is what protects
  // the legitimate paraphrases (.hippo/wordcase-price-hash.txt).
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'flag long-tailed cat mode is on' });
    await expectWordSwap(m, 'flag short-tailed cat mode is on', 'long-tailed', 'short-tailed');
    const same = await m.sourceMonitor('flag long-tailed cat mode is on');
    assert.equal(same.substantiated, true, `asking the stored wording back must still be a yes: ${same.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V1: the same shape in Chinese with spaces is caught too', async () => {
  // Measured before this test was written (.hippo/probe-cjk-guard.mjs): 0.833
  // SUBSTANTIATED. A CJK token carries in two characters what an English word
  // carries in seven, so the length floor is script-aware: two CJK characters, but
  // four Latin ones (which is what keeps "the", "port" and "blue" out of the pair).
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probe5 网关 使用 蓝色 主题' });
    await expectWordSwap(m, 'probe5 网关 使用 绿色 主题', '蓝色', '绿色');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V1: a two-character CJK value in the last slot is caught', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: '计费 worker 处理 队列' });
    await expectWordSwap(m, '计费 worker 处理 死信', '队列', '死信');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V1 control: an inserted article is a paraphrase, not a value swap', async () => {
  // Token counts differ, so the one-word rule cannot see it. Without that guard the
  // fix would repeat R4b's mistake on a wider stage: every pair of sentences of
  // different length would veto.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto deploys to staging cluster' });
    const v = await m.sourceMonitor('gto deploys to the staging cluster');
    assert.equal(v.substantiated, true, `a dropped or inserted article must stay a yes: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V1 control: a reworded restatement of the stored value stays a yes', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the leak is fixed by commit 7f3a9b1' });
    const v = await m.sourceMonitor('commit 7f3a9b1 fixes the leak');
    assert.equal(v.substantiated, true, `word order is not a value swap: ${v.note}`);

    await write(m, { summary: 'token scope is readonly for auditors' });
    const w = await m.sourceMonitor('auditors get a readonly token scope');
    assert.equal(w.substantiated, true, `a rephrased restatement must stay a yes: ${w.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V1 control: text with no spaces is outside this mechanism entirely', async () => {
  // Pinned so a later "generalise the token rule to CJK runs" change cannot quietly
  // start reading unsegmented Chinese as one giant token and veto on it. Today this
  // pair never reaches a verdict at all: it falls below the recall floor, which is a
  // disclosed space limitation and not this belt's business.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: '网关使用蓝色主题' });
    const v = await m.sourceMonitor('网关使用绿色主题');
    assert.equal(v.substantiated, false, v.note);
    assert.equal(v.weak_match, false, `nothing cleared the recall floor, so no anchor verdict is made: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V1 price, stated: a synonym in the value slot loses its yes', async () => {
  // The cost of the rule, on the record. "requests" -> "queries" is a legitimate
  // restatement and it now reads WEAK_MATCH. This price already exists on the
  // in-table half of the same shape (second half of this test, unchanged by the
  // fix): "is in enabled state" against "is in active state" has answered
  // CONTRADICTED since the copula route was written. The belt extends an existing
  // cost to the verbs the table does not hold; it does not open a new class of loss.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto gateway serves 200 requests per second' });
    const v = await m.sourceMonitor('gto gateway serves 200 queries per second');
    assert.equal(v.substantiated, false, `documented price: ${v.note}`);
    assert.equal(v.weak_match, true, v.note);

    await write(m, { summary: 'the feature flag is in enabled state' });
    const twin = await m.sourceMonitor('the feature flag is in active state');
    assert.equal(twin.contradicted, true, `the copula route already refused this twin: ${twin.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V1: naming the value in entities changes nothing, because no anchor reads entities', async () => {
  // The census report asked whether declaring "staging" as an entity helps. It
  // cannot: entities appears on the verify path only inside polarityAnchored
  // (src/memory.ts:568), which decides whether a POLARITY mismatch is allowed to
  // refute — never as a substantiation anchor. Pinned so nobody re-offers it.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto deploys to staging cluster', entities: ['gto', 'staging'] });
    await expectWordSwap(m, 'gto deploys to production cluster', 'staging', 'production');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* ------------------------------------------------------------------ V2 ------
 * Round six, same gate, one line of code. `wordFlip` vetoes a yes when the two
 * texts agree word for word except at one position, but it first asks how much
 * text sits BEFORE that position:
 *
 *      if (contentChars(b.slice(0, at).join(' ')) < 4) return null;
 *
 * That measures how far the difference is from the start of the sentence, and the
 * sixth-round report found it wrong in both directions:
 *
 *  V2a  A row whose subject carries no name — `the primary replica never accepts
 *      client traffic` asked back as `the standby …` — has only the article
 *      before the swap, so the belt steps aside and the claim's own cosine
 *      certifies it (0.824 hashing / 0.831 bge). Adding one real word in front
 *      of the same pair flips the reading to WEAK_MATCH at a LOWER similarity.
 *      Four such controlled pairs, all splitting on prefix length alone.
 *
 *  V2b  The opposite cost, introduced by this batch: `tokenize` treats a whole
 *      CJK run as one token, so `网关超时设定为` vs `网关超时最多` is a
 *      ONE-token divergence sitting behind a 5-character prefix — the shape the
 *      belt was written to catch. Four legitimate Chinese paraphrases of "the
 *      timeout is 30 seconds" lost their yes (bge SUBSTANTIATED -> WEAK_MATCH at
 *      0.937 / 0.958 / 0.971 / 0.934) while the English wording for the same
 *      fact was untouched, because English edits span several tokens.
 *
 * Both readings come from the same fixture in the reporter's own shapes; the
 * numbers here were re-measured on the LIVE build (.hippo/probe-v2-round6.mjs,
 * mirrors .hippo/v2-round6-{hash,bge}.txt). What separates the two cases is not
 * distance from the start of the sentence — it is WHICH SLOT the divergence is
 * in, and whether the sentence still states its value on both sides of it.
 */

test('verify V2a: a swap whose only prefix is an article is the subject moving, and that is not evidence', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the primary replica never accepts client traffic' });
    await expectWordSwap(m, 'the standby replica never accepts client traffic', 'primary', 'standby');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V2a: the same shape with the swap in the very first position', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'nginx proxies every inbound request over tls' });
    await expectWordSwap(m, 'haproxy proxies every inbound request over tls', 'nginx', 'haproxy');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V2a guard: an article is not a subject, so swapping one must not veto', async () => {
  // The veto reads the value slot; `the`/`a` are not values. Without this the
  // V2a widening would refuse every row that merely changed its determiner.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the primary gateway serves internal write traffic' });
    const v = await m.sourceMonitor('a primary gateway serves internal write traffic');
    assert.equal(v.substantiated, true, `a determiner is not what the row is about: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V2b: wording around a stated quantity is not that quantity moving', async () => {
  // `configured` vs `capped` is predicate wording; the value BOTH sides state is
  // `30 seconds`, and it agrees. wordFlip's own contract says it reads values
  // that are NOT numbers — where the sentence states a number on both sides, the
  // number is the value and it was never in dispute.
  //
  // Pinned in Latin because that is the mechanism the CJK family hits: the
  // reporter's four Chinese shapes (`设定为` / `最多` / `是` / `限制为` + `30 秒`)
  // fall below the recall floor in this space, so only bge shows their verdicts.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probe gateway timeout configured 30 seconds' });
    const v = await m.sourceMonitor('probe gateway timeout capped 30 seconds');
    assert.equal(v.weak_match, false, `the stated value agrees on both sides: ${v.note}`);
    assert.equal(v.substantiated, true, `a paraphrase of the same quantity must still substantiate: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V2b belt: the same frame with a different number must still refute', async () => {
  // V2b narrows a veto, which is the direction that has produced a false yes in
  // every earlier round of this file. The exemption therefore has to leave the
  // numeric flip exactly where it is: same wording, different number.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'probe gateway timeout configured 30 seconds' });
    const v = await m.sourceMonitor('probe gateway timeout configured 90 seconds');
    assert.equal(v.contradicted, true, `a real quantity flip still refutes: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V2a note: an article in front is not a subject, and the note says which slot moved', async () => {
  // The veto wording this batch shipped with claimed "the trace binds THIS SUBJECT
  // to …". For `a primary replica …` asked back as `a standby replica …` that is
  // false as printed: an article is all that stands before the swap, so the subject
  // is exactly what disagrees. A note that misnames its own reason cannot be audited.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'a primary replica never accepts client traffic' });
    const v = await expectWordSwap(m, 'a standby replica never accepts client traffic', 'primary', 'standby');
    assert.match(v.note, /puts first/, `the note must name the slot that moved: ${v.note}`);
    assert.doesNotMatch(v.note, /binds this subject/, `there is no shared subject here: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify V1 note: a value-slot swap keeps the wording about the value', async () => {
  // The other half of the same requirement: where a named subject does stand before
  // the swap, the veto must not hedge into "something was put first" — the row
  // states a subject and then a different value for it.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'gto deploys to staging cluster' });
    const v = await expectWordSwap(m, 'gto deploys to production cluster', 'staging', 'production');
    assert.match(v.note, /binds this subject to "staging"/, `the subject is shared here: ${v.note}`);
    assert.doesNotMatch(v.note, /puts first/, `the swap is not in the subject slot: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* ------------------------------------------------------------------ R7 ------
 * Round seven, same gate, two findings — one introduced by V2, one older than
 * it. Both are `wordFlip` not entering at all, so both read as certified yes.
 *
 *  R7a  The quantity exemption asks "does each side state the same number past
 *      the swap" but never asks whose number it is. `node zone alpha and 30
 *      slots` asked back as `… bravo …` states 30 on both sides, so the veto
 *      stepped aside — yet the 30 belongs to the slots clause, a second
 *      parameter the swap never touched. The reporter's对照 nails the
 *      boundary: moving the number away restores WEAK, differing numbers
 *      refute, so only the co-occurring shape is wrong.
 *
 *  R7b  `isValueWord` refuses every Latin token under 4 characters, which makes
 *      `aws` / `gcp`, `red` / `blue`, `hot` / `cold` invisible to the belt. In
 *      the hashing space only `aws`→`gcp` clears an anchor (0.68 SUBSTANTIATED
 *      while `hot`→`cold` at the same sim finds no anchor), but in bge all three
 *      pairs certify (0.896 / 0.853 / 0.828) — the veto is the only thing that
 *      can catch them there.
 */

test('verify R7a: a number past a coordinator belongs to another clause, so it cannot exempt the swap', async () => {
  // `and` joins a second parameter: the 30 is the slots' count, not alpha's
  // phrasing. The exemption must see only numbers in the swap's own clause.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'node zone alpha and 30 slots' });
    await expectWordSwap(m, 'node zone bravo and 30 slots', 'alpha', 'bravo');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R7a: second co-occurring-parameter shape, lane plus replica count', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'service lane blue and 3 replicas' });
    await expectWordSwap(m, 'service lane green and 3 replicas', 'blue', 'green');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R7a guard: a preposition keeps the number in the swap’s own clause', async () => {
  // `put at 30` is one constituent: the 30 is what `put` phrases. Only
  // coordinators (`and` / `or` / commas) start a clause the swap never touched.
  // (`configured at 30` would NOT pin this — `configured at ` alone spends 14
  // of the 12-char budget, so that shape vetoes on the old build already.)
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'timeout set at 30 seconds' });
    const v = await m.sourceMonitor('timeout put at 30 seconds');
    assert.equal(v.weak_match, false, `the stated value agrees on both sides: ${v.note}`);
    assert.equal(v.substantiated, true, `a paraphrase of the same quantity must still substantiate: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R7b: a three-letter value is visible to the belt', async () => {
  // `aws`→`gcp` certified at sim 0.68 hashing / 0.828 bge: the floor kept the
  // belt from ever seeing the slot. Short does not mean connective.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'deploy runs aws today' });
    await expectWordSwap(m, 'deploy runs gcp today', 'aws', 'gcp');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R7b guard: a reworded verb around an agreed number still substantiates', async () => {
  // Lowering the floor lets `set`/`put` into the belt — but the pair states the
  // same 30 in the swap's own clause, so the quantity exemption still applies
  // and the paraphrase keeps its yes. The floor and the exemption overlap, and
  // this pins the overlap rather than either half alone.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'timer set to 30 seconds' });
    const v = await m.sourceMonitor('timer put to 30 seconds');
    assert.equal(v.weak_match, false, `the stated value agrees on both sides: ${v.note}`);
    assert.equal(v.substantiated, true, `a reworded verb is phrasing, not a new value: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* ---- R9 stem: `valueClash` has no inflectional morphology -----------------
 *
 * Lowering the Latin floor to 3 (R7b) let more word-form pairs into the belt,
 * which made an older gap visible: `valueClash` compares raw tokens, so `run`
 * vs `runs` and `lane` vs `lanes` read as two different values. The former now
 * lands WEAK_MATCH (the belt vetoes an inflection), the latter still lands
 * CONTRADICTED (field report round 8, both builds unchanged) — one root, two
 * exits. The fix is an inflectional stem applied inside the value comparison
 * only: it merges two spellings of one value — except the collision pairs
 * R10 suppresses by pair key (`https`/`http` and kin: two values, not two
 * spellings). Out of scope on purpose: `app` vs `application` is abbreviation/synonymy, not
 * inflection — no stemmer reaches it, and reaching for it would reopen the
 * lexicon direction V1 closed.
 */

test('verify R9 stem: an inflected verb is phrasing, not a new value (run/runs)', async () => {
  // Round-8 census: SUBST 0.927 on the pre-R7b build, WEAK after the floor drop.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'deploy run aws today' });
    const v = await m.sourceMonitor('deploy runs aws today');
    assert.equal(v.weak_match, false, `the value did not move, only its inflection: ${v.note}`);
    assert.equal(v.substantiated, true, `an inflectional rewrite keeps its yes: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R9 stem: set/sets keeps its yes', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'service set hot mode' });
    const v = await m.sourceMonitor('service sets hot mode');
    assert.equal(v.weak_match, false, `the value did not move, only its inflection: ${v.note}`);
    assert.equal(v.substantiated, true, `an inflectional rewrite keeps its yes: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R9 stem: use/uses keeps its yes', async () => {
  // The bar is pinned to 0 on purpose (R2 precedent): in the hashing space this
  // pair scores claim-to-summary 0.68, under the 0.75 bar (bge: 0.915), while
  // the defect is structural — the belt vetoing an inflection. Pinning the bar
  // keeps the case deterministic with no model download and isolates the veto.
  const { m, dir } = freshStore({ claimThreshold: 0 });
  try {
    await write(m, { summary: 'node use blue theme' });
    const v = await m.sourceMonitor('node uses blue theme');
    assert.equal(v.weak_match, false, `the value did not move, only its inflection: ${v.note}`);
    assert.equal(v.substantiated, true, `an inflectional rewrite keeps its yes: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R9 stem: add/adds keeps its yes', async () => {
  // Same pin as use/uses: hashing claim-to-summary sits under the bar while
  // the veto is what stands between the pair and its yes.
  const { m, dir } = freshStore({ claimThreshold: 0 });
  try {
    await write(m, { summary: 'cache add hot item' });
    const v = await m.sourceMonitor('cache adds hot item');
    assert.equal(v.weak_match, false, `the value did not move, only its inflection: ${v.note}`);
    assert.equal(v.substantiated, true, `an inflectional rewrite keeps its yes: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R9 stem: get/gets keeps its yes', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'job get blue ticket' });
    const v = await m.sourceMonitor('job gets blue ticket');
    assert.equal(v.weak_match, false, `the value did not move, only its inflection: ${v.note}`);
    assert.equal(v.substantiated, true, `an inflectional rewrite keeps its yes: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R9 stem: a plural of the stored value is no refutation (lane/lanes)', async () => {
  // The same root through the other exit: `deploy uses blue lane` asked back as
  // `… blue lanes` answers CONTRADICTED on both the V2 and R7 builds. Merging
  // the inflection removes the clash, the anchor then agrees, and the verdict
  // returns to yes instead of stopping at WEAK.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'deploy uses blue lane' });
    const v = await m.sourceMonitor('deploy uses blue lanes');
    assert.equal(v.contradicted, false, `a plural is not a dispute: ${v.note}`);
    assert.equal(v.substantiated, true, `an inflectional rewrite keeps its yes: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R9 stem guard: stemming does not blind the belt (run/aws vs run/gcp)', async () => {
  // Round-8 gain side: `deploy run aws` asked back as `deploy run gcp` must
  // stay WEAK (0.790). The stem merges spellings of one value — `aws`
  // (untouched: too short to stem) and `gcp` still clash, and neither word
  // is in a suppressed collision pair.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'deploy run aws today' });
    await expectWordSwap(m, 'deploy run gcp today', 'aws', 'gcp');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R9 stem guard: a real flip next to an inflection still vetoes (set/hot vs set/cold)', async () => {
  // Round-8 gain side: `service set hot` asked back as `service set cold`
  // must stay WEAK (0.820). The verbs agree here, so the stem changes nothing
  // and the value flip is still caught.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'service set hot mode' });
    await expectWordSwap(m, 'service set cold mode', 'hot', 'cold');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* ---- R10 collision pairs: the stem merges two values, not two spellings --
 *
 * Round-9 census (both spaces): the trailing-`s` strip merges `https`->`http`,
 * `ftps`->`ftp`, `smtps`->`smtp`, `imaps`->`imap`, `amqps`->`amqp`,
 * `ldaps`->`ldap` and `news`->`new` — each pair is two values, not two
 * spellings of one, so the `stemToken` comment's "never two values" is dead.
 * Five of the seven certify in the hashing space on this build (RED below);
 * `ldaps` needs the claim bar pinned to 0 (R2 precedent) because the hashing
 * cosine alone does not anchor it, while bge certifies it outright. The fix
 * is a pair-keyed merge-suppression table consulted only to *restore* a
 * clash — its failure direction is the safe side by construction.
 * Deliberately out: `ws`/`wss` (the 3-letter floor owns it, not the stem —
 * pre-existing false yes, ROADMAP, never in this table).
 */

test('verify R10 collision: a protocol suffix is a different value (http/https)', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the gateway speaks http' });
    await expectWordSwap(m, 'the gateway speaks https', 'http', 'https');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R10 collision: a protocol suffix is a different value (ftp/ftps)', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the mirror serves ftp' });
    await expectWordSwap(m, 'the mirror serves ftps', 'ftp', 'ftps');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R10 collision: a protocol suffix is a different value (smtp/smtps)', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the relay accepts smtp' });
    await expectWordSwap(m, 'the relay accepts smtps', 'smtp', 'smtps');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R10 collision: a protocol suffix is a different value (imap/imaps)', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the client reads imap' });
    await expectWordSwap(m, 'the client reads imaps', 'imap', 'imaps');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R10 collision: a protocol suffix on the parsed route is a different value (amqp/amqps)', async () => {
  // `uses` parses, so this pair travels `valueFlip` route one, not the belt:
  // pre-stem it answered CONTRADICTED (0.921) and the suppression restores
  // exactly that — never a yes.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the queue uses amqp' });
    const v = await m.sourceMonitor('the queue uses amqps');
    assert.equal(v.substantiated, false, `a protocol suffix was certified as the same value: ${v.note}`);
    assert.equal(v.contradicted, true, `prev behavior was a refutation, not a downgrade: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R10 collision: a protocol suffix is a different value (ldap/ldaps)', async () => {
  // The bar is pinned to 0 (R2 precedent): the hashing cosine alone does not
  // anchor this pair, so the structural defect — the merge hiding the flip —
  // would be invisible at the default bar, while bge certifies it outright.
  const { m, dir } = freshStore({ claimThreshold: 0 });
  try {
    await write(m, { summary: 'the realm binds ldap' });
    await expectWordSwap(m, 'the realm binds ldaps', 'ldap', 'ldaps');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R10 collision: the class is wider than protocols (news/new)', async () => {
  // Not a protocol: a singular noun whose stem is itself a word. The table is
  // keyed by pair, not by concept, which is why this row belongs here.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the feed carries news' });
    await expectWordSwap(m, 'the feed carries new', 'news', 'new');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R10 guard: a digit-bearing token never entered the stem (pop3/pop3s)', async () => {
  // `stemToken` only touches pure-letter tokens, so this pair clashed before
  // the stem and must keep clashing after the suppression lands.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the reader fetches pop3' });
    await expectWordSwap(m, 'the reader fetches pop3s', 'pop3', 'pop3s');
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R10 guard: the es-arm still merges (box/boxes)', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the cache uses blue box' });
    const v = await m.sourceMonitor('the cache uses blue boxes');
    assert.equal(v.contradicted, false, `a plural is not a dispute: ${v.note}`);
    assert.equal(v.substantiated, true, `an inflectional rewrite keeps its yes: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R10 guard: the es-arm still merges (class/classes)', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the loader picks green class' });
    const v = await m.sourceMonitor('the loader picks green classes');
    assert.equal(v.contradicted, false, `a plural is not a dispute: ${v.note}`);
    assert.equal(v.substantiated, true, `an inflectional rewrite keeps its yes: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R10 guard: the ies-arm still merges (story/stories)', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the report names hot story' });
    const v = await m.sourceMonitor('the report names hot stories');
    assert.equal(v.contradicted, false, `a plural is not a dispute: ${v.note}`);
    assert.equal(v.substantiated, true, `an inflectional rewrite keeps its yes: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify R10 standing panel: ws/wss is a pinned known-open (panel P-WSS)', async () => {
  // Deliberately out of NO_MERGE_PAIRS: `ws` is two letters, so the R7b
  // 3-letter floor owns this pair, not the stem — the similarity alone
  // carries it to SUBSTANTIATED (hashing sim 0.74 on this build). This pins
  // today's answer so EITHER direction of change goes red: if a later round
  // puts the pair in the table, flip this to expectWordSwap; if the yes ever
  // spreads (more items certifying), that is a new leak, not this one.
  // ROADMAP carries the open item; panel P-WSS is the leak detector.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the socket opens ws' });
    const v = await m.sourceMonitor('the socket opens wss');
    assert.equal(v.substantiated, true, `P-WSS changed shape (was a false yes): ${v.note}`);
    assert.equal(v.contradicted, false, `a suffix pair is not a refutation: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* ---- #64 second cut: the quantity exemption must not fire past a preposition
 *
 * Round-11 census (both spaces, `pins blue <P> 30 replicas` asked as `pins
 * green <P> 30 replicas`): 16/24 prepositions certify a value swap against a
 * number that belongs to another parameter. No threshold separates these from
 * the pinned verb-rewordings (`configured 30`, `set at 30`, `set to 30`) — the
 * budget arithmetic keeps both — so the separation is constituency knowledge,
 * same as the R7a coordinator cut. Thirteen prepositions join the boundary
 * set; `at` / `to` stay out because items 61/63 pin verb-rewordings through
 * them, and `with` stays out as genuinely ambiguous. Each cut row below failed
 * as SUBSTANTIATED before the fix (RED); the three pins assert today's SUBST.
 */
const PREP_CUT = ['for', 'in', 'on', 'by', 'from', 'near', 'per', 'under', 'over', 'of', 'upon', 'via', 'since'];

for (const prep of PREP_CUT) {
  test(`verify #64 cut: a number past "${prep}" belongs to another parameter`, async () => {
    const { m, dir } = freshStore();
    try {
      await write(m, { summary: `pins blue ${prep} 30 replicas` });
      await expectWordSwap(m, `pins green ${prep} 30 replicas`, 'blue', 'green');
    } finally {
      m.close();
      assert.ok(dir);
    }
  });
}

test('verify #64 pin: "at" keeps the exemption (item 61 verb-rewording lives here)', async () => {
  // `at` is load-bearing for the pinned `set at 30` / `put at 30` paraphrase:
  // cutting it would amend item 61, which is a reversal of V2, not a price.
  // This pins the residual false yes so any change in either direction goes red.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'pins blue at 30 replicas' });
    const v = await m.sourceMonitor('pins green at 30 replicas');
    assert.equal(v.substantiated, true, `#64 residual changed shape: ${v.note}`);
    assert.equal(v.contradicted, false, `a suffix pair is not a refutation: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify #64 pin: "to" keeps the exemption (item 63 verb-rewording lives here)', async () => {
  // Same bargain as "at": item 63 pins `set to 30` / `put to 30` as a yes.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'pins blue to 30 replicas' });
    const v = await m.sourceMonitor('pins green to 30 replicas');
    assert.equal(v.substantiated, true, `#64 residual changed shape: ${v.note}`);
    assert.equal(v.contradicted, false, `a suffix pair is not a refutation: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify #64 pin: "with" stays ambiguous (declared, not measured)', async () => {
  // `pins blue with 30 replicas` reads as one parameter or two — the ambiguity
  // is in the English, not the engine. Leaving it is a semantic decision.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'pins blue with 30 replicas' });
    const v = await m.sourceMonitor('pins green with 30 replicas');
    assert.equal(v.substantiated, true, `#64 residual changed shape: ${v.note}`);
    assert.equal(v.contradicted, false, `a suffix pair is not a refutation: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify #65: a filler-word state does not certify the opposite state', async () => {
  // `on` is a connective filler, so `flag is on` carries an empty value-token
  // set: `valueClash` stays silent on it (correct — an unknown must never
  // manufacture CONTRADICTED) and the V1 belt stays blind (`on` is a
  // two-letter filler, not a value word). The pair is still a one-word swap in
  // the value slot, so the filler belt (`fillerSwap`) downgrades it to a lead
  // and the note names both values — the verdict triple plus the naming is the
  // contract, both directions.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'flag is on' });
    await expectWordSwap(m, 'flag is off', 'on', 'off');
  } finally {
    m.close();
    assert.ok(dir);
  }
  const second = freshStore();
  try {
    await write(second.m, { summary: 'flag is off' });
    await expectWordSwap(second.m, 'flag is on', 'off', 'on');
  } finally {
    second.m.close();
    assert.ok(second.dir);
  }
});

test('verify #65b-101: a filler/value combination does not certify the flip (currently)', async () => {
  // `currently on` vs `currently off`: both sides keep a comparable term, so the
  // shipped belt bailed and `valueClash` read containment as refinement — but the
  // single differing slot is filler-vs-value, which is the swap, not agreement.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'release flag is currently on' });
    await expectWordSwap(m, 'release flag is currently off', 'currently on', 'currently off');
    const same = await m.sourceMonitor('release flag is currently on');
    assert.equal(same.substantiated, true, `same value must still substantiate: ${same.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
  const second = freshStore();
  try {
    await write(second.m, { summary: 'release flag is currently off' });
    await expectWordSwap(second.m, 'release flag is currently on', 'currently off', 'currently on');
  } finally {
    second.m.close();
    assert.ok(second.dir);
  }
});

test('verify #65b-104: a filler/value combination does not certify the flip (duty)', async () => {
  // `on duty` vs `off duty`: the comparable sets are identical ({duty}), so the
  // comparison routes see agreement — but the one word that differs is the state.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'support rotation is on duty' });
    await expectWordSwap(m, 'support rotation is off duty', 'on duty', 'off duty');
    const refined = await m.sourceMonitor('support rotation is on');
    assert.equal(refined.substantiated, true, `a strict word-prefix refinement is not a swap: ${refined.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify #65b-106: a filler/value combination does not certify the flip (telemetry)', async () => {
  // `with telemetry` vs `without telemetry`: containment-as-refinement plus a
  // filler-blind positional belt. Includes the bare `with` vs `without` pair,
  // where raw-string containment (`without`.includes(`with`)) is the hole.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'agent tracing is with telemetry' });
    await expectWordSwap(m, 'agent tracing is without telemetry', 'with telemetry', 'without telemetry');
  } finally {
    m.close();
    assert.ok(dir);
  }
  const second = freshStore();
  try {
    await write(second.m, { summary: 'agent tracing is with' });
    await expectWordSwap(second.m, 'agent tracing is without', 'with', 'without');
    const refined = await second.m.sourceMonitor('agent tracing is with telemetry');
    assert.equal(refined.substantiated, true, `adding detail to the same state is refinement, not a flip: ${refined.note}`);
  } finally {
    second.m.close();
    assert.ok(second.dir);
  }
});

test('verify #65b-109: a both-filler swap inside a longer value is paraphrase, not a flip', async () => {
  // `red and blue` vs `red or blue`: the single differing slot joins two
  // fillers with comparable context around it — no value moved. This pins the
  // exception that keeps the positional arm from over-blocking connective
  // alternation; without it this pair falls to WEAK_MATCH.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'the wire is red and blue' });
    const v = await m.sourceMonitor('the wire is red or blue');
    assert.equal(v.substantiated, true, `connective alternation must still substantiate: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify #65b-110: single-letter enumerators still contradict after the belt widening', async () => {
  // `cluster a` vs `cluster b`: the widened belt now fires here (single-token
  // both-filler swap), but the contradiction exit runs before the anchor gate,
  // so `valueClash` still gets the last word.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'deploy target is cluster a' });
    const v = await m.sourceMonitor('deploy target is cluster b');
    assert.equal(v.substantiated, false, `must not certify: ${v.note}`);
    assert.equal(v.contradicted, true, `single-letter values still clash: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* -------------------------------------------------------------------- */
// Round 23 (G1) — the 2026-10-05 black-box re-test reported the P0 that D2 was
// supposed to have closed: "out_of_scope / scope_conflicts 依旧恒为 false 和 []",
// with a store holding a subject-identical, premise-different `us-east` row,
// asked under `env=staging; region=ap-south`, answered `weak_match` with an
// unrelated row as support (sim 0.553). Their read — "这个分支从未被执行过",
// with polarity analysis present but never wired to the scope branch — is the
// right shape of diagnosis, and the census (`.hippo/repro-p0-scope-round23*.mjs`,
// 20 arms in the hashing space plus the same arms under the host's
// `bge-small-zh-v1.5`) refined it: the exit IS wired (engine, both adapters
// forward `scope`, and the D2/ZZBARE tests below it are green) but TWO
// comparability judgements disarm it before it can be reached.
//
//  Arm A — `supportMeetsScope` and the ranking both read
//          `scopeDifferences(scope, queryScope).length === 0` as "this row
//          states the caller's premise". `scopeDifferences` can only ever find
//          a difference under a key BOTH sides name, so a row stored under
//          `release=v2` against a caller asking about `env`/`region` shares no
//          key, returns [], and is ranked as the caller's OWN premise — which
//          both wins the support slot and skips the whole veto scan. Measured
//          (item 111): support `release=v2` at 0.521 while the
//          `env=staging; region=us-east` row sits at 0.699, named nowhere. In
//          bge space the same fixture reproduces the reporter's line byte for
//          byte: `weak_match`, support `release=v2` at 0.662, the us-east row
//          at 0.811, `scope_conflicts: []`.
//          Root cause is the empty-set-as-agreement shape again (the same class
//          as #65's `flag is on/off`): "no shared key" was read as "no
//          disagreement" and then, one step further, as "agreement".
//
//  Arm B — the scan demotes a conflicting row that scores below the support it
//          was displaced by (`sim < bestSim`). That bar was D2's own guard
//          against listing every topical neighbour, but it makes the veto
//          depend on the support's score rather than on the conflicting row's
//          relevance. Measured (item 112): a scope-less row wins at 0.689, the
//          `us-east` row is at 0.486 — above the 0.32 floor, anchored on both
//          `entity` and `subject` — and is discarded, so the claim is stamped
//          SUBSTANTIATED against a store whose only staging premise says
//          otherwise.
//
//  The route arm B needs is a second, structural one: a row that names the
//  caller's premise differently AND states the same THING as the claim — an
//  identifier both sides carry, or the subject of a structured claim the claim
//  repeats. The first cut of it also accepted the `entity` tier, and the price
//  census (116) showed why that is too wide: `api` is a topic, not a claim, so
//  a 0.40 row about `api latency budget` vetoed a 0.93 verbatim restatement of
//  `api timeout`. `vocabulary` was never in question — one shared topic word is
//  what a real embedding model supplies for a hundred irrelevant rows. The score
//  route stays untouched beside this one, so every D2 reading that fires today
//  still fires.
//
//  Two residuals are pinned as guards rather than fixed: a premise on another
//  axis is NOT a conflict (113 — the opposite direction would make the feature
//  veto everything), and a below-floor row is not a veto no matter what it
//  states (114). 115 pins the short-circuit D2 needed: when the support itself
//  states the caller's premise, a foreign-premise neighbour must not veto.
//  116 pins the price the census caught on the first cut of the anchor route,
//  and 117 the ranking half of arm A — the one row in this batch whose fix
//  moves a verdict TOWARD a yes, so it is pinned with its disclosure asserted.
//
//  The vocabulary-only guard the census also wanted (above floor, anchored
//  nothing but a shared topic word) is NOT a deterministic unit test: every
//  candidate fixture came back BELOW FLOOR in the hashing space
//  (`.hippo/fixture-g1-guard2-round23h.mjs`), so it belongs to the bge panel,
//  where cosine does clear the floor with no structural anchor.
//
//  Note on the fixtures: the probe sentence IS stored here, under the
//  conflicting premise. That is the defect — the veto must fire on a PREMISE
//  mismatch, and the only way to separate a premise disarm from a lexical one
//  is to hold the text constant.

test('verify #G1-111: a support on another axis must not silence the scope veto', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'api timeout -> 30 seconds', entities: ['api'], scope: 'env=staging; region=us-east' });
    await write(m, {
      summary: 'api timeout -> 30 seconds is the gateway default',
      entities: ['gateway'],
      scope: 'release=v2'
    });
    const foreign = m.list().find((r) => (r.scope ?? '').includes('us-east'));
    const v = await m.sourceMonitor('api timeout -> 30 seconds', { scope: 'env=staging; region=ap-south' });
    assert.equal(
      v.out_of_scope,
      true,
      `a store whose only staging premise contradicts the caller must not certify: ${v.note}`
    );
    assert.equal(v.substantiated, false, `arm A false-yes: ${v.note}`);
    // Round 24 moved this row from `scope_conflicts` into the support seat (a row
    // that speaks the caller's axis and disagrees now outranks one keyed on
    // `release`, which the caller never named), so the durable property is
    // "named", not "named in that field" — asserting the field would pin G1's
    // accident instead of G1's point.
    const named = (v.scope_conflicts ?? []).some((r) => r.id === foreign?.id) || v.support?.id === foreign?.id;
    assert.ok(named, `the us-east row must be named, not left unseen: support=${JSON.stringify(v.support?.scope)} conflicts=${JSON.stringify(v.scope_conflicts)}`);
    assert.match(v.note, /region/, `the veto must name the shared key that differs: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify #G1-112: an anchored conflicting premise below the winner still vetoes', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'timeout is 30 seconds', entities: ['timeout'] });
    await write(m, {
      summary: 'api timeout -> 30 seconds across the staging gateway after the tenant override landed',
      entities: ['api'],
      scope: 'env=staging; region=us-east'
    });
    const foreign = m.list().find((r) => (r.scope ?? '').includes('us-east'));
    const v = await m.sourceMonitor('api timeout -> 30 seconds', { scope: 'env=staging; region=ap-south' });
    assert.equal(
      v.out_of_scope,
      true,
      `a row that restates the claim's own subject outranks a score bar set by a scope-less trace: ${v.note}`
    );
    assert.equal(v.substantiated, false, `arm B false-yes: ${v.note}`);
    assert.ok(
      (v.scope_conflicts ?? []).some((r) => r.id === foreign.id),
      `the anchored us-east row must be named: ${JSON.stringify(v.scope_conflicts)}`
    );
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify #G1-113: a premise on another axis is not a conflict, and no longer a yes either', async () => {
  // RE-RULED by round 24 (D5). This guard was written after the G1 census to pin
  // the over-block a naive comparability cut would introduce, and it asserted two
  // things at once: `out_of_scope: false` (nothing disagrees) and
  // `substantiated: true` (so the trace answers). The first half still holds —
  // naming another axis is not disagreeing, and `scope_conflicts` must stay empty
  // — and the second half was the conflation the reporter's shape (a) measured as
  // a false certification at 0.846 hashing / 0.909 bge. "Not a conflict" and "is
  // support" are two different questions; the answer to the first does not
  // decide the second, and a trace keyed on `release` says nothing about a claim
  // checked under `env`/`region`.
  const { m, dir } = freshStore();
  try {
    await write(m, {
      summary: 'api timeout -> 30 seconds is the gateway default',
      entities: ['gateway'],
      scope: 'release=v2'
    });
    const v = await m.sourceMonitor('api timeout -> 30 seconds', { scope: 'env=staging; region=ap-south' });
    assert.equal(v.substantiated, false, `an off-axis trace may not certify: ${v.note}`);
    assert.equal(v.out_of_scope, true, `the only trace is keyed on a premise nobody asked about: ${v.note}`);
    assert.deepEqual(v.scope_conflicts, [], `nothing conflicts, so nothing may be listed as a conflict: ${JSON.stringify(v.scope_conflicts)}`);
    assert.match(v.note, /release/, `the note must name the trace's own axis: ${v.note}`);
    assert.match(v.note, /env/, `and the axes the caller stated: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify #G1-114: a below-floor conflicting premise does not veto (guard)', async () => {
  // 112's anchor route must not turn the veto into "any scoped row in the
  // store": the train row states the foreign premise but never reaches the
  // recall floor against the claim, so it is not about this claim at all.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'api timeout -> 30 seconds', entities: ['api'] });
    await write(m, {
      summary: 'the release train leaves at 30 seconds past the hour',
      entities: ['train'],
      scope: 'env=staging; region=us-east'
    });
    const v = await m.sourceMonitor('api timeout -> 30 seconds', { scope: 'env=staging; region=ap-south' });
    assert.equal(v.out_of_scope, false, `an irrelevant row is not a premise conflict: ${v.note}`);
    assert.equal(v.substantiated, true, `the 0.93 support stands: ${v.note}`);
    assert.deepEqual(v.scope_conflicts, []);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test("verify #G1-115: the caller's own premise short-circuits the veto (guard)", async () => {
  // D2's completion rule, kept whole: the scan exists to catch a foreign
  // premise the ranking hid, not to overrule an answer found under the
  // conditions the caller stated.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'api timeout -> 30 seconds', entities: ['api'], scope: 'env=staging; region=ap-south' });
    await write(m, { summary: 'api timeout -> 30 seconds in us-east', entities: ['api'], scope: 'env=staging; region=us-east' });
    const v = await m.sourceMonitor('api timeout -> 30 seconds', { scope: 'env=staging; region=ap-south' });
    assert.equal(v.out_of_scope, false, `the support IS the caller's premise: ${v.note}`);
    assert.equal(v.substantiated, true, `and must support it: ${v.note}`);
    assert.deepEqual(v.scope_conflicts, []);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify #G1-116: a shared entity alone does not veto (census-priced guard)', async () => {
  // NOT red-first: this one was written after the price was measured, because
  // the price is what found it (`.hippo/panel-g1-scope-round23k.mjs`, case C2).
  // The first cut of arm B route accepted every non-`vocabulary` anchor tier,
  // which includes `entity` — and then it vetoed a VERBATIM restatement at 0.93
  // hashing / 0.98 bge on the strength of a 0.40 / 0.70 row about
  // `api latency budget` living under `region=us-east`. An entity is a TOPIC:
  // every fact ever recorded about one service shares that token, so sharing it
  // is not evidence that two texts state ONE claim under TWO conditions, which
  // is the only thing this veto is for. The route now takes the subject and
  // identifier tiers only; this row goes red the moment it is widened back.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'api timeout -> 30 seconds', entities: ['api'] });
    await write(m, {
      summary: 'api latency budget -> 30 seconds in the other staging cell',
      entities: ['api'],
      scope: 'env=staging; region=us-east'
    });
    const v = await m.sourceMonitor('api timeout -> 30 seconds', { scope: 'env=staging; region=ap-south' });
    assert.equal(v.out_of_scope, false, `a row about another attribute of the same entity is not this claim under another premise: ${v.note}`);
    assert.equal(v.substantiated, true, `the verbatim trace must still answer: ${v.note}`);
    assert.deepEqual(v.scope_conflicts, [], `no veto may be collected on an entity alone: ${JSON.stringify(v.scope_conflicts)}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify #G1-117: a premise on another axis does not win the support slot', async () => {
  // The other half of arm A, and the one move in the census that goes TOWARD a
  // yes, so it is pinned rather than waved through: `release=v2` is not the
  // caller's premise, it is not comparable to it either, and the ranking used to
  // read `scopeDifferences() === []` as "this row states the caller's own
  // conditions" — which put a 0.456 row about a DIFFERENT attribute in the
  // support seat ahead of a 0.933 verbatim restatement, and the claim then fell
  // to WEAK_MATCH for no reason the reader could see. The yes here is the
  // premise-less verbatim match, with its unchecked premise disclosed.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'api timeout -> 30 seconds', entities: ['api'] });
    await write(m, {
      summary: 'api latency budget -> 30 seconds on the v2 gateway',
      entities: ['api'],
      scope: 'release=v2'
    });
    const v = await m.sourceMonitor('api timeout -> 30 seconds', { scope: 'env=staging; region=ap-south' });
    assert.equal(v.out_of_scope, false, `an unrelated axis cannot veto: ${v.note}`);
    assert.equal(v.substantiated, true, `the verbatim 0.93 row must be the support: ${v.note}`);
    assert.equal(v.support.scope, undefined, `the different-axis row must not take its seat: ${JSON.stringify(v.support.scope)}`);
    assert.match(v.note, /no scope/, `a premise-less yes must say so: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

/* -------------------------------------------------------------------- */
// Round 24 (G3, black-box re-test on the G1 bytes): `no difference` and `no
// shared condition` still read the same at TWO sites.
//
// G1 gave the comparability predicate to the support ranking and to the
// `supportMeetsScope` gate in front of the veto scan, and stopped there. The
// affirm fall-through (`supportDiffers.length > 0 ? best : scopeConflicts[0]`)
// and the related-row keep-test both still ask `scopeDifferences(...) === 0`,
// which is empty for a row keyed on an axis the caller never names. Measured on
// the installed build (`.hippo/repro-d5-round24-{hash,bge}.txt`):
//   (a) one trace under `tenant=acme`, claim checked under `cluster=blue` →
//       `substantiated: true` at 0.846 hashing / 0.909 bge, with nothing in the
//       answer saying the two premises share no condition;
//   (b) the same shape with a third-premise sibling → `substantiated: true` AND
//       `contradicting`/`newer_related` naming the `region=eu-west` row AND
//       `stale_support: true`, because `premiseAnchor` became the caller's
//       disjoint premise and can therefore judge nothing.
// (b) needs no separate fix: the affirm gate returns before the related scan.
// The ranking moves an off-axis row BELOW a premise-free one, because a general
// statement still answers a conditioned question while a trace about another
// axis answers nothing.
// ---------------------------------------------------------------------------

test('verify #G3-118: a trace keyed on an axis the caller never names must not affirm', async () => {
  // The reporter's shape (a), his fixture: the store holds ONE payment row,
  // stated under `tenant=acme`; the claim is checked under `cluster=blue`. Not
  // a conflict (`tenant` never disagrees with `cluster` — both keys stay in the
  // answer empty), and not support either: the trace says nothing about a
  // condition the caller stated, and a yes here is a certification the memory
  // never issued.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'payment retry limit -> 3 times', entities: ['payment'], scope: 'tenant=acme' });
    const v = await m.sourceMonitor('payment retry limit -> 3 times', { scope: 'cluster=blue' });
    assert.equal(v.substantiated, false, `key-disjoint affirm: ${v.note}`);
    assert.equal(v.out_of_scope, true, `the only trace is off the caller's axis: ${v.note}`);
    assert.deepEqual(v.scope_conflicts, [], `nothing disagrees, so nothing may be listed as a conflict: ${JSON.stringify(v.scope_conflicts)}`);
    assert.match(v.note, /tenant/, `the note must name the trace's own axis: ${v.note}`);
    assert.match(v.note, /cluster/, `and the axis the caller asked about: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify #G3-119: a third-premise sibling must not buy a false staleness', async () => {
  // Shape (b): the caller asks about `service=billing`, and BOTH stored rows
  // state `env`/`region` instead. The engine used to affirm on the us-east row
  // and then call it stale on the strength of a eu-west row 12 ms newer — a
  // yes and a warning built from two traces that are each about conditions
  // nobody asked about. One gate fixes both, because the verdict returns
  // before the related scan runs.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'api timeout -> 30 seconds', entities: ['api'], scope: 'env=staging; region=us-east' });
    await write(m, { summary: 'api timeout -> 5 seconds', entities: ['api'], scope: 'env=prod; region=eu-west' });
    const v = await m.sourceMonitor('api timeout -> 30 seconds', { scope: 'service=billing' });
    assert.equal(v.substantiated, false, `neither row states the caller's premise: ${v.note}`);
    assert.equal(v.out_of_scope, true, `${v.note}`);
    assert.equal(v.stale_support, false, `no staleness claim may survive an off-axis support: ${v.note}`);
    assert.equal(v.contested, false, `${v.note}`);
    assert.deepEqual(v.contradicting, [], `the eu-west row is not evidence about service=billing: ${JSON.stringify(v.contradicting)}`);
    assert.deepEqual(v.newer_related, [], `${JSON.stringify(v.newer_related)}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify #G3-120: the off-axis verdict must not depend on write order', async () => {
  // The reporter's own diagnosis of the 12 ms: `updatedAt` is a real timestamp,
  // so `newer_related` is order-of-writing for two rows stored in one tool
  // block. That is not a tie-window bug — the newer row IS newer — it is the
  // premise bug showing through: whichever order the two off-axis rows land in,
  // neither is about the caller's condition, so the answer must be identical.
  const a = freshStore();
  const b = freshStore();
  try {
    await write(a.m, { summary: 'api timeout -> 30 seconds', entities: ['api'], scope: 'env=staging; region=us-east' });
    await write(a.m, { summary: 'api timeout -> 5 seconds', entities: ['api'], scope: 'env=prod; region=eu-west' });
    await write(b.m, { summary: 'api timeout -> 5 seconds', entities: ['api'], scope: 'env=prod; region=eu-west' });
    await write(b.m, { summary: 'api timeout -> 30 seconds', entities: ['api'], scope: 'env=staging; region=us-east' });
    const va = await a.m.sourceMonitor('api timeout -> 30 seconds', { scope: 'service=billing' });
    const vb = await b.m.sourceMonitor('api timeout -> 30 seconds', { scope: 'service=billing' });
    assert.equal(va.out_of_scope, true, `first order: ${va.note}`);
    assert.equal(vb.out_of_scope, true, `reversed order: ${vb.note}`);
    assert.equal(va.stale_support, vb.stale_support, 'write order may not move a staleness verdict');
    assert.equal(va.contradicting.length, vb.contradicting.length, 'nor a contradiction count');
  } finally {
    a.m.close();
    b.m.close();
    assert.ok(a.dir && b.dir);
  }
});

test('verify #G3-121: a premise-free trace keeps the support seat against a closer off-axis one', async () => {
  // The move this fix must not make: vetoing a general statement because some
  // other row happens to be keyed. A premise-free trace is a claim about every
  // condition including the caller's; the `tenant=acme` restatement is about one
  // the caller never named. Ranking the two together (which is what G1's arm A
  // did, to keep a non-argument out of the support seat) lets the keyed row win
  // on similarity and then takes the honest yes down with it.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'ZZG321 payment retry limit -> 3 times', entities: ['payment'], scope: 'tenant=acme' });
    await write(m, { summary: 'ZZG321 payment retry limit is 3 times overall', entities: ['billing'] });
    const v = await m.sourceMonitor('ZZG321 payment retry limit -> 3 times', { scope: 'cluster=blue' });
    assert.equal(v.substantiated, true, `a premise-free trace must answer: ${v.note}`);
    assert.equal(v.out_of_scope, false, `an off-axis row may not veto it: ${v.note}`);
    assert.equal(v.support.scope, undefined, `the keyed row must not take the seat: ${JSON.stringify(v.support)}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

test('verify #G3-122: a trace that DOES disagree outranks an off-axis one for the named blocker', async () => {
  // Ordering inside the answer: the store holds a `release=v2` restatement and
  // a us-east row that shares the caller's `env` and disagrees on `region`.
  // Only one of them is evidence about the question, and the seat must go to it
  // — the reader is owed the row that names the caller's own axis.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'ZZG322 cache fill rate under the v2 release is 12 per cent', entities: ['cache'], scope: 'release=v2' });
    await write(m, { summary: 'ZZG322 cache fill rate in the staging us-east gateway is 12 per cent', entities: ['cache'], scope: 'env=staging; region=us-east' });
    const v = await m.sourceMonitor('ZZG322 cache fill rate is 12 per cent', { scope: 'env=staging; region=ap-south' });
    assert.equal(v.out_of_scope, true, `${v.note}`);
    assert.match(v.support?.scope ?? '', /us-east/, `the row that shares the caller's axis takes the seat: ${JSON.stringify(v.support)}`);
    assert.match(v.note, /region/, `and the note names the key that disagrees: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

// Guards (green before AND after): the admissibility rule is about the CALLER's
// premise, and every ruling the batch has already priced on comparability stays.
test('verify #G3-123 guard: subset, superset and bare-refine premises still support', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'api timeout -> 30 seconds', entities: ['api'], scope: 'env=staging' });
    const subset = await m.sourceMonitor('api timeout -> 30 seconds', { scope: 'env=staging; region=ap-south' });
    assert.equal(subset.substantiated, true, `a less specific trace still answers: ${subset.note}`);
    assert.equal(subset.out_of_scope, false, `${subset.note}`);

    const wide = await m.sourceMonitor('api timeout -> 30 seconds', { scope: 'env=staging; region=ap-south' });
    assert.equal(wide.out_of_scope, false, `${wide.note}`);
    assert.equal(wide.substantiated, true, `${wide.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
  const s2 = freshStore();
  try {
    await write(s2.m, { summary: 'api timeout -> 30 seconds', entities: ['api'], scope: 'env=staging; region=ap-south; tenant=x' });
    const sup = await s2.m.sourceMonitor('api timeout -> 30 seconds', { scope: 'env=staging; region=ap-south' });
    assert.equal(sup.substantiated, true, `a more specific trace still answers: ${sup.note}`);
    assert.equal(sup.out_of_scope, false, `${sup.note}`);
  } finally {
    s2.m.close();
    assert.ok(s2.dir);
  }
  const s3 = freshStore();
  try {
    await write(s3.m, { summary: 'the shard count is twelve', entities: ['shard'], scope: 'region=us-east' });
    const bare = await s3.m.sourceMonitor('the shard count is twelve', { scope: 'us-east' });
    assert.equal(bare.substantiated, true, `a bare premise refines a keyed one, it does not conflict: ${bare.note}`);
    assert.equal(bare.out_of_scope, false, `${bare.note}`);
  } finally {
    s3.m.close();
    assert.ok(s3.dir);
  }
});

test('verify #G3-124 guard: a caller that states no premise changes nothing', async () => {
  // The whole premise block is gated on `queryScope`; controls D1/D2 of the G1
  // census stay byte-for-byte, including the key-disjoint pair, which is an
  // ordinary side-by-side store when nobody states conditions.
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'payment retry limit -> 3 times', entities: ['payment'], scope: 'tenant=acme' });
    const v = await m.sourceMonitor('payment retry limit -> 3 times');
    assert.equal(v.substantiated, true, `unpremised query must still affirm: ${v.note}`);
    assert.equal(v.out_of_scope, false, `${v.note}`);
    assert.match(v.note, /CONDITIONAL SCOPE/, `the trace's own premise stays disclosed: ${v.note}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});

// Declared residual (safe side, pinned so a future widening of this route goes
// red rather than silently dropping a warning): with a PREMISE-FREE support the
// verdict is admissible, so the related scan still runs, and a newer row keyed
// on an axis the caller never names still counts as `newer_related`. Removing it
// there would delete a downgrade-only signal — a row that may be a correction —
// on the strength of a key name, which is the dangerous direction.
test('verify #G3-125 guard: an off-axis sibling may still WARN against a premise-free support', async () => {
  const { m, dir } = freshStore();
  try {
    await write(m, { summary: 'api timeout -> 30 seconds', entities: ['api'] });
    await write(m, { summary: 'the eu-west api timeout budget was tightened after the failover', entities: ['api'], scope: 'env=prod; region=eu-west' });
    const v = await m.sourceMonitor('api timeout -> 30 seconds', { scope: 'service=billing' });
    assert.equal(v.substantiated, true, `a premise-free support is admissible: ${v.note}`);
    assert.equal(v.out_of_scope, false, `${v.note}`);
    assert.equal(v.stale_support, true, `and the newer off-axis row still gets to warn: ${JSON.stringify(v.newer_related)}`);
  } finally {
    m.close();
    assert.ok(dir);
  }
});
