/**
 * Adapter tests. They run on Node (no opencode host required) by driving the
 * plugin object directly: the hooks and tools are plain functions, which is
 * exactly how opencode calls them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the store cache before importing the plugin (it reads the env lazily).
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'hippo-oc-cache-'));
const { default: HippoMemoryPlugin } = await import('../lib/index.js');
const { DISCIPLINE, storeFile, cueFromMessages, buildDigest, resetStores, hasSystemHook } = HippoMemoryPlugin;

function project() {
  return mkdtempSync(join(tmpdir(), 'hippo-oc-proj-'));
}

async function pluginFor(options = {}, dir = project()) {
  resetStores();
  const hooks = await HippoMemoryPlugin({ directory: dir }, options);
  return { hooks, dir, ctx: { directory: dir } };
}

test('exposes the four memory tools and the injection hooks', async () => {
  const { hooks } = await pluginFor();
  assert.deepEqual(
    Object.keys(hooks.tool).sort(),
    ['memory_maintain', 'memory_recall', 'memory_remember', 'memory_verify'],
  );
  assert.equal(typeof hooks['experimental.chat.system.transform'], 'function');
  assert.equal(typeof hooks['experimental.chat.messages.transform'], 'function');
  assert.equal(typeof hooks['experimental.session.compacting'], 'function');
  assert.equal(typeof hooks.event, 'function');
});

test('enabled: false yields no tools and no hooks (data untouched)', async () => {
  const { hooks } = await pluginFor({ enabled: false });
  assert.deepEqual(Object.keys(hooks), []);
});

test('remember -> recall round trip uses the project store', async () => {
  const { hooks, dir, ctx } = await pluginFor();
  const written = JSON.parse(
    await hooks.tool.memory_remember.execute(
      { kind: 'semantic', summary: 'billing service database -> postgres', entities: ['billing'] },
      ctx,
    ),
  );
  assert.equal(written.outcome, 'new');
  assert.ok(written.id);
  assert.ok(storeFile(dir).endsWith('.db'));

  const recalled = JSON.parse(await hooks.tool.memory_recall.execute({ query: 'billing database' }, ctx));
  assert.equal(recalled.hits.length, 1);
  assert.equal(recalled.hits[0].summary, 'billing service database -> postgres');
  assert.equal(recalled.reason, 'ok');
  assert.equal(typeof recalled.threshold, 'number');
});

test('a changed value on the same subject overrides and reports what it retired', async () => {
  const { hooks, ctx } = await pluginFor();
  await hooks.tool.memory_remember.execute(
    { kind: 'semantic', summary: 'billing service database -> postgres', entities: ['billing'] },
    ctx,
  );
  const second = JSON.parse(
    await hooks.tool.memory_remember.execute(
      { kind: 'semantic', summary: 'billing service database -> mysql', entities: ['billing'] },
      ctx,
    ),
  );
  assert.equal(second.outcome, 'override');
  assert.ok(second.superseded?.id, 'the retired revision must be reported');
  assert.match(second.warning ?? '', /override/);
});

test('verify reports support, contradiction and superseded matches', async () => {
  const { hooks, ctx } = await pluginFor();
  await hooks.tool.memory_remember.execute({ kind: 'semantic', summary: 'cache size -> 512 MB' }, ctx);
  await hooks.tool.memory_remember.execute({ kind: 'semantic', summary: 'cache size -> 1024 MB' }, ctx);
  const verdict = JSON.parse(await hooks.tool.memory_verify.execute({ claim: 'cache size is 1024 MB' }, ctx));
  assert.equal(typeof verdict.substantiated, 'boolean');
  assert.ok(Array.isArray(verdict.contradicting));
  assert.ok(Array.isArray(verdict.superseded_matches));
  assert.ok(verdict.note);
});

test('verify passes the WEAK_MATCH verdict and vetoing premises through to the model', async () => {
  const { hooks, ctx } = await pluginFor();
  await hooks.tool.memory_remember.execute({ kind: 'semantic', summary: 'ZZOCCUR the backend language is python' }, ctx);
  const weak = JSON.parse(await hooks.tool.memory_verify.execute({ claim: 'ZZOCCUR python brews the best espresso' }, ctx));
  assert.equal(weak.substantiated, false, `topical proximity is not a yes: ${weak.note}`);
  assert.equal(weak.weak_match, true, 'the adapter must hand over the verdict, not swallow it');

  await hooks.tool.memory_remember.execute({ kind: 'semantic', summary: 'ZZVETO quota -> 40', scope: 'env=prod' }, ctx);
  await hooks.tool.memory_remember.execute({ kind: 'semantic', summary: 'ZZVETO quota numbers are watched closely' }, ctx);
  const veto = JSON.parse(await hooks.tool.memory_verify.execute({ claim: 'ZZVETO quota -> 40', scope: 'env=dev' }, ctx));
  assert.equal(veto.out_of_scope, true, `a scope-less fallback must not bless foreign premises: ${veto.note}`);
  assert.ok(Array.isArray(veto.scope_conflicts) && veto.scope_conflicts.length > 0, 'the vetoing row is named');
});

test('remember carries scope and verify answers OUT_OF_SCOPE for foreign premises', async () => {
  const { hooks, ctx } = await pluginFor();
  const written = JSON.parse(
    await hooks.tool.memory_remember.execute(
      {
        kind: 'semantic',
        summary: 'the pair stays at the independence baseline',
        scope: 'population=all records; comparator=instruction start',
      },
      ctx,
    ),
  );
  assert.equal(written.scope, 'population=all records; comparator=instruction start');

  const off = JSON.parse(
    await hooks.tool.memory_verify.execute(
      { claim: 'the pair stays at the independence baseline', scope: 'comparator=disp field of the recorded instruction' },
      ctx,
    ),
  );
  assert.equal(off.out_of_scope, true, `foreign premises must not substantiate: ${off.note}`);
  assert.equal(off.substantiated, false);

  const on = JSON.parse(
    await hooks.tool.memory_verify.execute(
      { claim: 'the pair stays at the independence baseline', scope: 'comparator=instruction start' },
      ctx,
    ),
  );
  assert.equal(on.out_of_scope, false);
  assert.equal(on.substantiated, true);

  const recalled = JSON.parse(await hooks.tool.memory_recall.execute({ query: 'independence baseline comparator' }, ctx));
  assert.equal(recalled.hits[0].scope, 'population=all records; comparator=instruction start');
});

test('system.transform appends the discipline and a digest exactly once', async () => {
  const { hooks, ctx } = await pluginFor();
  await hooks.tool.memory_remember.execute({ kind: 'semantic', summary: 'digest probe -> visible' }, ctx);

  const system = { system: ['base'] };
  await hooks['experimental.chat.system.transform']({ sessionID: 's' }, system);
  assert.equal(system.system.filter((p) => p.includes('## Long-term memory')).length, 1);
  assert.equal(
    system.system.filter((p) => p.trimStart().startsWith('[hippo-memory digest]')).length,
    1,
    'exactly one injected digest block',
  );
  // The discipline may mention the digest by name; that is not a second injection.
  assert.equal(system.system.filter((p) => p.includes('[hippo-memory digest]')).length, 2);

  // A second turn must not stack duplicates of the discipline section.
  const again = { system: [...system.system] };
  await hooks['experimental.chat.system.transform']({ sessionID: 's' }, again);
  assert.equal(again.system.filter((p) => p.includes('## Long-term memory')).length, 1);
});

test('the messages.transform fallback stays out of the way once the system hook runs', async () => {
  const { hooks, ctx } = await pluginFor();
  await hooks.tool.memory_remember.execute({ kind: 'semantic', summary: 'fallback probe -> visible' }, ctx);

  // Before the system hook runs, the fallback injects.
  resetStores();
  const fresh = await HippoMemoryPlugin({ directory: ctx.directory }, {});
  const messages = { messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'fallback probe' }] }] };
  await fresh['experimental.chat.messages.transform']({}, messages);
  assert.equal(messages.messages.length, 2);
  assert.ok(messages.messages[0].parts[0].text.includes('[hippo-memory digest]'));
  assert.equal(hasSystemHook(), false);

  // After the system hook has been used, the fallback must no-op.
  const system = { system: [] };
  await fresh['experimental.chat.system.transform']({ sessionID: 's' }, system);
  assert.equal(hasSystemHook(), true);
  const later = { messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'fallback probe' }] }] };
  await fresh['experimental.chat.messages.transform']({}, later);
  assert.equal(later.messages.length, 1, 'no double injection');
});

test('compaction carry-over attaches the durable memory block', async () => {
  const { hooks, ctx } = await pluginFor();
  await hooks.tool.memory_remember.execute({ kind: 'semantic', summary: 'survives compaction -> yes' }, ctx);
  const output = { context: [] };
  await hooks['experimental.session.compacting']({ sessionID: 's' }, output);
  assert.equal(output.context.length, 1);
  assert.match(output.context[0], /Durable memory/);
  assert.match(output.context[0], /hippo-memory digest/);
});

test('a broken store never throws out of a hook', async () => {
  const { hooks } = await pluginFor();
  // A directory that cannot be created as a database file path.
  const bad = await HippoMemoryPlugin({ directory: '\u0000invalid' }, {});
  const output = { system: [] };
  await bad['experimental.chat.system.transform']({ sessionID: 's' }, output);
  // Either it succeeded with a store, or it swallowed the error; never throws.
  assert.ok(Array.isArray(output.system));
  assert.equal(typeof hooks.tool.memory_recall.execute, 'function');
});

test('maintain status reports the driver and store diagnostics', async () => {
  const { hooks, ctx } = await pluginFor();
  await hooks.tool.memory_remember.execute({ kind: 'semantic', summary: 'status probe -> ok' }, ctx);
  const status = JSON.parse(await hooks.tool.memory_maintain.execute({ action: 'status' }, ctx));
  assert.ok(['node:sqlite', 'bun:sqlite'].includes(status.driver));
  assert.ok(status.diagnostics?.embedder?.kind);
  assert.ok(status.diagnostics?.thresholds);
  const stats = JSON.parse(await hooks.tool.memory_maintain.execute({ action: 'stats' }, ctx));
  assert.equal(stats.active, 1);
});

test('maintain status: an empty project store says the memories are next door', async () => {
  const full = await pluginFor();
  await full.hooks.tool.memory_remember.execute({ kind: 'semantic', summary: 'ZZSPL the fact lives here -> 1' }, full.ctx);
  const empty = await pluginFor();
  const status = JSON.parse(await empty.hooks.tool.memory_maintain.execute({ action: 'status' }, empty.ctx));
  const file = storeFile(full.dir).split(/[\\/]/).pop();
  const sibling = status.diagnostics.sibling_stores.stores.find((s) => s.file === file);
  assert.equal(sibling?.rows, 1, `the other project store is counted: ${JSON.stringify(status.diagnostics.sibling_stores)}`);
  assert.equal(sibling.current, false, 'and it is not the one answering');
  assert.match(String(status.health), /split|another store|sibling/i, `status says it, not just the table: ${status.health}`);
  assert.match(String(status.diagnostics.scope_rule), /never cross|one store|per /i);
  assert.match(String(status.path_rule), /project director/i, 'and names the rule this host applies');
});

test('maintain: duplicates -> merge previews, then retires the extra into the survivor', async () => {
  const { hooks, ctx } = await pluginFor();
  const ep = JSON.parse(
    await hooks.tool.memory_remember.execute(
      { kind: 'episode', summary: 'ZZMRG modbus timeout -> 1500 ms on the gateway', entities: ['zzmrg'], importance: 0.9 },
      ctx,
    ),
  );
  await hooks.tool.memory_maintain.execute({ action: 'consolidate' }, ctx);
  const rep = JSON.parse(await hooks.tool.memory_maintain.execute({ action: 'duplicates' }, ctx));
  const group = rep.groups.find((g) => g.memories.some((x) => x.id === ep.id));
  assert.ok(group, `the episode/rule pair is reported: ${JSON.stringify(rep)}`);
  assert.equal(group.mixedPremises, false, 'the report says the pair is mergeable');
  const ids = group.memories.map((x) => x.id);

  const preview = JSON.parse(await hooks.tool.memory_maintain.execute({ action: 'merge', ids }, ctx));
  assert.equal(preview.dry_run, true, 'the default is a preview');
  assert.equal(preview.retired.length, 1);
  const before = JSON.parse(await hooks.tool.memory_maintain.execute({ action: 'list' }, ctx));
  assert.ok(ids.every((id) => before.some((x) => x.id === id)), 'a preview retires nothing');

  const applied = JSON.parse(await hooks.tool.memory_maintain.execute({ action: 'merge', ids, dry_run: false }, ctx));
  assert.equal(applied.ok, true, `merge applied: ${JSON.stringify(applied)}`);
  assert.equal(applied.retired.length, 1);
  const listed = JSON.parse(await hooks.tool.memory_maintain.execute({ action: 'list' }, ctx));
  const folded = listed.find((x) => x.id === applied.retired[0].id);
  assert.ok(folded, 'the folded row is still listed — merge did not delete it');
  assert.equal(folded.demoted, true, 'and it says which row is folded, so undemote has an id to work from');
  const after = JSON.parse(await hooks.tool.memory_maintain.execute({ action: 'duplicates' }, ctx));
  assert.ok(!after.groups.some((g) => g.memories.some((x) => ids.includes(x.id))), 'merged group stops being reported');
  const rec = JSON.parse(await hooks.tool.memory_recall.execute({ query: 'ZZMRG modbus timeout', limit: 10 }, ctx));
  assert.equal(rec.hits.filter((h) => ids.includes(h.id)).length, 1, 'one restatement is offered, not two');

  // The note promises undemote restores the retired row; the host must offer it.
  const back = JSON.parse(
    await hooks.tool.memory_maintain.execute({ action: 'undemote', ids: [applied.retired[0].id] }, ctx),
  );
  assert.deepEqual(back.restored, [applied.retired[0].id], 'merge is reversible from this host');
  const again = JSON.parse(await hooks.tool.memory_maintain.execute({ action: 'duplicates' }, ctx));
  assert.ok(again.groups.some((g) => g.memories.some((x) => x.id === applied.retired[0].id)), 'restored row is reported again');
});

test('maintain: merge refuses to fold rows that state different premises', async () => {
  const { hooks, ctx } = await pluginFor();
  const a = JSON.parse(
    await hooks.tool.memory_remember.execute(
      { kind: 'semantic', summary: 'ZZMIX replacement rate -> below the independence baseline', scope: 'population=all records', entities: ['zzmix'] },
      ctx,
    ),
  );
  const b = JSON.parse(
    await hooks.tool.memory_remember.execute(
      { kind: 'semantic', summary: 'ZZMIX replacement rate -> below the independence baseline', scope: 'population=first 4096 rows', entities: ['zzmix'] },
      ctx,
    ),
  );
  const rep = JSON.parse(await hooks.tool.memory_maintain.execute({ action: 'duplicates' }, ctx));
  const group = rep.groups.find((g) => g.memories.some((x) => x.id === a.id));
  assert.ok(group, `pair reported: ${JSON.stringify(rep)}`);
  assert.equal(group.mixedPremises, true, 'the report flags the clash before anyone merges');
  // Per-pair flag, per-row consequence: the advice must not tell the model to
  // write off the whole group, because the rest of it can still be real duplicates.
  assert.match(rep.note, /not restatements of each other/, 'the note names what the flag means');
  assert.doesNotMatch(rep.note, /is NOT duplicates/);
  const applied = JSON.parse(
    await hooks.tool.memory_maintain.execute({ action: 'merge', ids: [a.id, b.id], dry_run: false }, ctx),
  );
  assert.equal(applied.survivor, null, 'nothing folded');
  assert.equal(applied.retired.length, 0);
  assert.match(applied.blocked[0].reason, /premise/i);
  assert.match(applied.blocked[0].reason, /population/, 'the clashing premise key is named, not hinted');
  assert.deepEqual(
    group.memories.map((x) => x.scope).sort(),
    ['population=all records', 'population=first 4096 rows'],
    'the report shows which value each row carries',
  );
});

test('options: contextLimit / similarityThreshold / sharedStore are honoured', async () => {
  const dirA = project();
  const dirB = project();
  resetStores();
  const shared = await HippoMemoryPlugin({ directory: dirA }, { sharedStore: true });
  await shared.tool.memory_remember.execute({ kind: 'semantic', summary: 'shared store -> visible everywhere' }, { directory: dirA });
  const fromB = JSON.parse(await shared.tool.memory_recall.execute({ query: 'shared store' }, { directory: dirB }));
  assert.equal(fromB.hits.length, 1, 'both projects read the same store');
  assert.ok(storeFile(dirA, true).endsWith('shared.db'));

  const strict = await pluginFor({ similarityThreshold: 0.95 });
  await strict.hooks.tool.memory_remember.execute({ kind: 'semantic', summary: 'threshold probe -> value' }, strict.ctx);
  const strictRecall = JSON.parse(await strict.hooks.tool.memory_recall.execute({ query: 'threshold probe' }, strict.ctx));
  assert.equal(strictRecall.threshold, 0.95);
});

test('cue helpers flatten opencode message shapes', () => {
  assert.equal(cueFromMessages([{ parts: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]), 'a b');
  assert.equal(cueFromMessages([{ info: { parts: [{ type: 'text', text: 'c' }] } }]), 'c');
  assert.equal(cueFromMessages([]), '');
  assert.ok(DISCIPLINE.includes('memory_verify'));
});

test('discipline names merge and explains the digest guess line', () => {
  assert.match(DISCIPLINE, /\bmerge\b/, 'a duplicates report the agent cannot act on is a dead end');
  assert.match(DISCIPLINE, /low-confidence/, 'the digest can carry one line that is a guess');
});

// ---------------------------------------------------------------------------
// F5 (black-box report #6): the host accepts arguments a tool never declared.
//
// `@deepseek-ai/dsh-tools` builds the parameter object schema without
// `additionalProperties` ("implicit open parameter object"), and opencode passes
// the model's JSON through as-is, so an invented key — a typo of `detail`, a
// hallucinated `not_a_field` — was accepted, silently dropped by the engine, and
// then echoed back on the tool card from `rawInput` as if it had landed. The
// boundary is the only place that knows what it declared, so the boundary says so.
// ---------------------------------------------------------------------------

test('F5: an undeclared argument is refused, naming the declared ones', async () => {
  const { hooks, ctx } = await pluginFor();
  const res = JSON.parse(
    await hooks.tool.memory_remember.execute(
      { kind: 'semantic', summary: 'ZZF5 the deploy gate runs the smoke suite first', detail2: 'typo', not_a_field: true },
      ctx,
    ),
  );
  assert.equal(res.ok, false, `the call must fail: ${JSON.stringify(res)}`);
  assert.match(res.error, /unknown argument/i);
  assert.match(res.error, /detail2/);
  assert.match(res.error, /not_a_field/);
  assert.match(res.error, /summary/, 'the caller must see what it could have written');

  const rec = JSON.parse(await hooks.tool.memory_recall.execute({ query: 'ZZF5 the deploy gate runs the smoke suite first' }, ctx));
  assert.equal(rec.hits.length, 0, 'a refused write stores nothing');
});

test('F5 guard: declared arguments still pass the boundary', async () => {
  const { hooks, ctx } = await pluginFor();
  const written = JSON.parse(
    await hooks.tool.memory_remember.execute(
      { kind: 'semantic', summary: 'ZZF5b the deploy gate runs the smoke suite first', detail: 'after the build', scope: 'env=staging' },
      ctx,
    ),
  );
  assert.equal(written.outcome, 'new', JSON.stringify(written));
});

// F4b: same plumbing guarantee on the opencode side — `hitView` lists fields
// explicitly, so an unlisted engine field never reaches the model.

test('F4b: memory_recall carries the anchor fields on every hit', async () => {
  const { hooks, ctx } = await pluginFor();
  await hooks.tool.memory_remember.execute(
    { kind: 'semantic', summary: 'ZZF4b the canary window is one hour before the rollback gate' },
    ctx
  );
  const rec = JSON.parse(await hooks.tool.memory_recall.execute({ query: 'ZZF4b canary window' }, ctx));
  assert.equal(rec.hits.length, 1, 'the fixture row is a hit');
  assert.equal(typeof rec.hits[0].anchored, 'boolean', `anchored must arrive: ${JSON.stringify(rec.hits[0])}`);
  assert.equal(rec.hits[0].anchored, true, 'a cue naming the claim subject is anchored');
  assert.ok(rec.hits[0].anchors.includes('subject'), `tiers: ${JSON.stringify(rec.hits[0].anchors)}`);
});

// The instruction surface for the F batch: the engine changed what a hit means,
// so the text the model reads has to change with it. Report #2's root cause was
// an instruction that taught one ritual (`key=value`) agents do not write, and
// report #4's was a ranking number that reads like a confidence score.

test('instruction surface: memory_recall describes the fields it actually sends', async () => {
  const { hooks } = await pluginFor();
  const d = hooks.tool.memory_recall.description;
  assert.match(d, /anchored/i, `the hit field must be named where the model reads how to use it: ${d}`);
  assert.match(d, /anchors/, 'the tier list is the readable part');
  assert.match(d, /relativeScore/, 'the ranking value must be told apart from evidence');
  // hitView sends similarity/relativeScore, never a bare `score`.
  assert.doesNotMatch(d, /\bscore\b/, `the description must not promise a field the view drops: ${d}`);
});

test('instruction surface: duplicates is described as two channels', async () => {
  const { hooks } = await pluginFor();
  const d = `${hooks.tool.memory_maintain.description} ${hooks.tool.memory_maintain.args.action.description}`;
  assert.match(d, /\btext\b/, 'the verbatim-restatement channel');
  assert.match(d, /vector/i, 'a paraphrase of one statement is a duplicate too (report #1)');
});

test('instruction surface: every scope argument documents the plain form', async () => {
  const { hooks } = await pluginFor();
  for (const name of ['memory_remember', 'memory_recall', 'memory_verify']) {
    const sc = hooks.tool[name].args.scope;
    assert.ok(sc, `${name} takes scope`);
    assert.match(sc.description ?? '', /plain condition/i, `${name}: scope must not teach only key=value`);
  }
});

test('instruction surface: DISCIPLINE names anchors, both channels, plain premises', async () => {
  assert.match(DISCIPLINE, /anchored/, 'RECALL must say what anchored:false means');
  assert.match(DISCIPLINE, /vector/i, 'MAINTAIN must say the report also catches paraphrases');
  assert.match(DISCIPLINE, /plain condition/i, 'WRITE must not teach a ritual agents do not write');
});
