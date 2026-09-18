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
