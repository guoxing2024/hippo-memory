/**
 * V2 adapter tests (route B: V2 only).
 *
 * There is no V2 host on this machine that has ever loaded this package, so these
 * tests drive the plugin against a fake `ctx` whose shape is copied from the
 * published artifacts, not from prose. Every shape below cites the file it came from
 * (spec: .hippo/opencode-v2-spec-round35.md):
 *
 *   entry            plugin/package/dist/promise/plugin.d.ts:55-59  {id, setup(ctx) => Cleanup|void}
 *   system inject    plugin/package/dist/promise/session.d.ts:25,29-35  SessionContext{system: SystemPart[], messages: Message[]}
 *   SystemPart       ai/package/dist/schema/messages.d.ts:7-13        {type:'text', text, cache?, metadata?}
 *   Message          ai/package/dist/schema/messages.d.ts:428-431     {role, content:[{type:'text', text}]}  (no V1 `info.parts`)
 *   compaction       plugin/package/dist/promise/session.d.ts:36-45   SessionCompaction = SessionContext + result?
 *   tools            plugin/package/dist/promise/tool.d.ts:13-15,24   Tool.Info{name, input, description, execute} via editor.add
 *   ValueSchema      schema/package/dist/tool.d.ts:32                 Schema.Codec | StandardSchemaV1 | JsonSchema  (=> inline JSON Schema)
 *   Result           schema/package/dist/tool.d.ts:66-69,70-77        {output?, content?: string | Content[]}
 *   events           plugin/package/dist/promise/event.d.ts           subscribe({signal}) -> AsyncIterable  (no callback form)
 *   logging          plugin/package/dist/app.d.ts                     ctx.app = {name, version, channel}  — no log face
 *
 * Two invariants that the V1 module got backwards for V2 (spec §4): the host does not
 * persist hook edits into the session, so EVERY outgoing model call must carry the
 * digest again; and if the host does hand the same array back (retries see earlier
 * overrides) the digest must be replaced, never stacked. The V1 `systemHookSupported`
 * suppression flag has no counterpart here — there is one injection hook, so the flag
 * and the cross-hook "stay out of the way" test are deleted, not ported.
 *
 * The lower half of this file is the behaviour belts migrated from `adapter.test.mjs`
 * (the V1 suite, deleted under route B once they moved here). Those tests drove
 * `hooks.tool.X.execute(args, ctx)`; the same claims are made against
 * `host.tool('X').execute(args, {})` and the `{content}` result, so nothing about the
 * engine behaviour is re-litigated — only the host plumbing changes. Eleven V1 tests
 * were dropped as pure V1-shape duplicates (entry, enabled:false, remember->recall,
 * system.transform, messages.transform suppression, compaction, broken store, V1 cue
 * shapes) because the tests above already cover their V2 equivalent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the store cache before importing the plugin (cacheRoot() reads the env lazily).
const CACHE = mkdtempSync(join(tmpdir(), 'hippo-oc2-cache-'));
process.env.XDG_CACHE_HOME = CACHE;
const { default: HippoPlugin } = await import('../lib/index.js');

const project = () => mkdtempSync(join(tmpdir(), 'hippo-oc2-proj-'));

/* ------------------------------------------------------------------ */
/* fake V2 host                                                        */
/* ------------------------------------------------------------------ */

/**
 * A minimal stand-in for the V2 plugin context. It records registrations instead of
 * applying them, so the tests can assert the plugin touched exactly the faces the
 * spec says it may touch.
 */
function fakeHost({ directory = project(), options = {} } = {}) {
  const session = new Map();
  const toolHooks = new Map();
  const added = new Map();
  const state = { transforms: 0, subscriptions: 0, aborted: false, deliveries: 0 };
  const pending = [];
  const waiters = [];
  let signalRef = null;

  const wake = () => { for (const resolve of waiters.splice(0)) resolve(); };

  const ctx = {
    app: { name: 'opencode', version: '2.0.24', channel: 'stable' },
    location: { directory, project: { id: 'proj-1', directory } },
    options,
    session: {
      hook(name, callback) {
        session.set(name, callback);
        return Promise.resolve({ dispose: async () => session.delete(name) });
      },
    },
    tool: {
      transform(callback) {
        state.transforms += 1;
        callback({
          list: () => [...added.values()],
          get: (id) => added.get(id),
          namespace: () => {},
          add: (info) => { added.set(info.name, info); },
          update: (id, fn) => { const t = added.get(id); if (t) fn(t); },
          remove: (id) => { added.delete(id); },
        });
        return Promise.resolve({ dispose: async () => {} });
      },
      hook(name, callback) {
        toolHooks.set(name, callback);
        return Promise.resolve({ dispose: async () => {} });
      },
    },
    event: {
      subscribe({ signal } = {}) {
        state.subscriptions += 1;
        signalRef = signal ?? null;
        if (signal) signal.addEventListener('abort', () => { state.aborted = true; wake(); });
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                for (;;) {
                  if (pending.length) { state.deliveries += 1; return { value: pending.shift(), done: false }; }
                  if (signal?.aborted) return { value: undefined, done: true };
                  await new Promise((resolve) => waiters.push(resolve));
                }
              },
            };
          },
        };
      },
    },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => [],
    },
  };

  const host = {
    ctx,
    directory,
    session,
    toolHooks,
    state,
    tools: added,
    emit(event) { pending.push(event); wake(); },
    tool(name) { return added.get(name); },
    async run(name, event) {
      const callback = session.get(name) ?? toolHooks.get(name);
      if (!callback) throw new Error(`hook ${name} was never registered`);
      return callback(event);
    },
  };
  return host;
}

/** A SessionContext as the host would hand it (promise/session.d.ts:29-35). */
function contextEvent({ system, messages } = {}) {
  return {
    sessionID: 'ses-1',
    agent: 'build',
    model: { providerID: 'relay', modelID: 'test-model' },
    system,
    messages,
    options: {},
    tools: {},
  };
}

const text = (part) => String(part?.text ?? '');
// The discipline block *names* the digest marker in its own body, so "contains"
// cannot tell the two injected parts apart. Identity is the metadata tag first
// (SystemPart.metadata is a legal field), the block's own header line second.
const isDigest = (part) => part?.metadata?.['hippo-memory'] === 'digest' || text(part).startsWith('[hippo-memory digest]');
const isDiscipline = (part) => part?.metadata?.['hippo-memory'] === 'discipline' || text(part).startsWith('## Long-term memory');
const countDigest = (system) => (system ?? []).filter(isDigest).length;
const countDiscipline = (system) => (system ?? []).filter(isDiscipline).length;

/** Build a plugin against a fresh project store and return the host. */
async function mounted(options = {}, directory = project()) {
  HippoPlugin.resetStores?.();
  const host = fakeHost({ directory, options });
  const cleanup = await HippoPlugin.setup(host.ctx);
  return { host, cleanup, directory };
}

/** Run `fn` with console.log captured; the only log face V2 gives us (spec §7). */
async function withLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

/** Mount a plugin without clearing the shared store cache (for cross-project tests). */
async function mountAlongside(options = {}, directory = project()) {
  const host = fakeHost({ directory, options });
  await HippoPlugin.setup(host.ctx);
  return host;
}

/** Call a memory tool through the V2 boundary and parse the JSON it reports. */
async function call(host, name, args) {
  return JSON.parse((await host.tool(name).execute(args, {})).content);
}

/* ------------------------------------------------------------------ */
/* entry shape                                                         */
/* ------------------------------------------------------------------ */

test('the default export is a V2 plugin object, not a V1 hook factory', async () => {
  assert.equal(typeof HippoPlugin, 'object', 'V1 exported an async function; route B exports {id, setup}');
  assert.equal(typeof HippoPlugin.id, 'string');
  assert.ok(HippoPlugin.id.length > 0);
  assert.equal(typeof HippoPlugin.setup, 'function');
  // The V1 face must be gone, not merely unused (route B).
  assert.equal(HippoPlugin.tool, undefined);
  assert.equal(HippoPlugin['experimental.chat.system.transform'], undefined);
  assert.equal(HippoPlugin.event, undefined);
  // Test seams hang off the entry object: opencode only ever takes the default export.
  assert.equal(typeof HippoPlugin.resetStores, 'function');
});

test('setup registers exactly the faces the spec allows, once each', async () => {
  const { host } = await mounted();
  assert.deepEqual([...host.session.keys()].sort(), ['compaction', 'context'],
    'context carries the digest, compaction the carry-over; title/generate deliberately do not');
  assert.deepEqual([...host.toolHooks.keys()], ['execute.after']);
  assert.equal(host.state.transforms, 1);
  assert.equal(host.state.subscriptions, 1);
});

test('setup returns an async cleanup that closes the event subscription', async () => {
  const { host, cleanup } = await mounted();
  assert.equal(typeof cleanup, 'function');
  await cleanup();
  assert.equal(host.state.aborted, true, 'the subscribe signal must be aborted, or the loop outlives the plugin');
});

test('enabled:false registers nothing and still returns a callable cleanup', async () => {
  const { host, cleanup } = await mounted({ enabled: false });
  assert.equal(host.session.size, 0);
  assert.equal(host.toolHooks.size, 0);
  assert.equal(host.state.transforms, 0);
  assert.equal(host.state.subscriptions, 0);
  assert.equal(host.tools.size, 0);
  assert.equal(typeof cleanup, 'function');
  await cleanup();
});

/* ------------------------------------------------------------------ */
/* digest injection                                                    */
/* ------------------------------------------------------------------ */

test('the context hook appends the discipline and one digest as SystemPart objects', async () => {
  const { host } = await mounted();
  const written = JSON.parse((await host.tool('memory_remember').execute(
    { kind: 'semantic', summary: 'billing service database -> postgres' },
    {},
  )).content);
  assert.equal(written.outcome, 'new');

  const event = contextEvent({ system: [{ type: 'text', text: 'base prompt' }], messages: [] });
  await host.run('context', event);

  for (const part of event.system) {
    assert.equal(part.type, 'text', 'V2 system entries are SystemPart objects, not V1 strings');
    assert.equal(typeof part.text, 'string');
  }
  assert.equal(countDiscipline(event.system), 1);
  assert.equal(countDigest(event.system), 1);
  assert.match(event.system.at(-1).text, /postgres/);
  assert.equal(event.system.filter((p) => text(p) === 'base prompt').length, 1, 'the host prompt is untouched');
});

test('a system array carried into a second call is replaced, never stacked', async () => {
  const { host } = await mounted();
  await host.tool('memory_remember').execute({ kind: 'semantic', summary: 'deploy target -> k8s' }, {});

  const event = contextEvent({ system: [{ type: 'text', text: 'base prompt' }], messages: [] });
  await host.run('context', event);
  await host.run('context', event);

  assert.equal(countDigest(event.system), 1, 'the digest is replaced, never accumulated');
  assert.equal(countDiscipline(event.system), 1, 'and so is the discipline section');
});

test('a fresh outgoing call gets the digest again; edits are not persisted by the host', async () => {
  const { host } = await mounted();
  await host.tool('memory_remember').execute({ kind: 'semantic', summary: 'release train -> 2026.10' }, {});

  const first = contextEvent({ system: [], messages: [] });
  await host.run('context', first);
  const second = contextEvent({ system: [{ type: 'text', text: 'base prompt' }], messages: [] });
  await host.run('context', second);

  assert.equal(countDigest(second.system), 1,
    'a tool continuation is a new model call; suppressing it would leave it memoryless');
  assert.equal(countDigest(first.system), 1);
});

test('with no usable system array the digest falls back to a user message', async () => {
  const { host } = await mounted();
  await host.tool('memory_remember').execute({ kind: 'semantic', summary: 'cache tier -> redis' }, {});

  const event = contextEvent({ system: undefined, messages: [{ role: 'user', content: [{ type: 'text', text: 'which cache?' }] }] });
  await host.run('context', event);

  assert.equal(event.messages.length, 2);
  assert.equal(event.messages[0].role, 'user', 'retrieved content rides the ordinary user channel (spec §5)');
  assert.equal(event.messages[0].content[0].type, 'text');
  assert.match(event.messages[0].content[0].text, /\[hippo-memory digest\]/);
  assert.equal(event.messages.filter((m) => m.content?.some((c) => text(c).includes('[hippo-memory digest]'))).length, 1);
});

test('the cue is read from the V2 message shape {role, content:[{type:"text"}]}', () => {
  assert.equal(
    HippoPlugin.cueFromMessages([{ role: 'user', content: [{ type: 'text', text: 'billing  database' }] }]),
    'billing database',
  );
  assert.equal(
    HippoPlugin.cueFromMessages([
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
    ]),
    'first second',
  );
});

test('a broken store never throws out of a hook', async () => {
  HippoPlugin.resetStores?.();
  // Deterministic break: the cache root is a *file*, so every path under it is
  // ENOTDIR. A too-long path would only hope to fail.
  const blocker = join(CACHE, 'not-a-directory');
  writeFileSync(blocker, 'deliberately a file');
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = blocker;
  try {
    const host = fakeHost({ directory: project() });
    await HippoPlugin.setup(host.ctx);

    // First prove the fixture really broke the store, or the assertions below are vacuous.
    await assert.rejects(host.tool('memory_recall').execute({ query: 'anything' }, {}));

    const event = contextEvent({ system: [{ type: 'text', text: 'base prompt' }], messages: [] });
    await host.run('context', event);
    assert.ok(Array.isArray(event.system), 'the hook degrades to the untouched prompt instead of throwing');
    assert.equal(countDigest(event.system), 0);
    assert.equal(event.system.filter((p) => text(p) === 'base prompt').length, 1);

    const compaction = contextEvent({ system: [], messages: [] });
    await host.run('compaction', compaction);
    assert.equal(compaction.result, undefined);
  } finally {
    process.env.XDG_CACHE_HOME = previous;
    HippoPlugin.resetStores?.();
  }
});

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

test('the four memory tools arrive as V2 Tool.Info with self-carried JSON Schema', async () => {
  const { host } = await mounted();
  assert.deepEqual([...host.tools.keys()].sort(), ['memory_maintain', 'memory_recall', 'memory_remember', 'memory_verify']);

  const required = {
    memory_remember: ['kind', 'summary'],
    memory_recall: ['query'],
    memory_verify: ['claim'],
    memory_maintain: ['action'],
  };
  for (const [name, keys] of Object.entries(required)) {
    const info = host.tool(name);
    assert.equal(typeof info.description, 'string');
    assert.match(info.description, /\S/);
    assert.equal(typeof info.execute, 'function');
    assert.equal(info.input.type, 'object', `${name} must submit a JSON Schema object, not a V1 args map`);
    assert.ok(Object.keys(info.input.properties ?? {}).length > 0, `${name} declares properties`);
    for (const key of keys) assert.ok(info.input.required.includes(key), `${name}.${key} is required`);
  }
  assert.deepEqual(host.tool('memory_remember').input.properties.kind.enum, ['episode', 'semantic', 'procedure']);
});

test('remember -> recall round trip through the V2 result shape', async () => {
  const { host } = await mounted();
  const res = await host.tool('memory_remember').execute(
    { kind: 'semantic', summary: 'billing service database -> postgres', entities: ['billing'] },
    {},
  );
  assert.equal(typeof res, 'object');
  assert.equal(typeof res.content, 'string', 'V2 Tool.Result carries content (schema/tool.d.ts:66-69)');
  const written = JSON.parse(res.content);
  assert.equal(written.outcome, 'new');
  assert.ok(written.id);

  const recalled = JSON.parse((await host.tool('memory_recall').execute({ query: 'billing database' }, {})).content);
  assert.equal(recalled.hits.length, 1);
  assert.equal(recalled.hits[0].summary, 'billing service database -> postgres');
  assert.equal(recalled.reason, 'ok');
});

test('an undeclared argument is refused at the boundary (F5 belt survives the port)', async () => {
  const { host } = await mounted();
  const refused = JSON.parse((await host.tool('memory_remember').execute(
    { kind: 'semantic', summary: 'ghost -> written', nplus_one: 'invented' },
    {},
  )).content);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /nplus_one/);
  assert.match(refused.error, /Declared: /);

  const recalled = JSON.parse((await host.tool('memory_recall').execute({ query: 'ghost' }, {})).content);
  assert.equal(recalled.hits.length, 0, 'nothing was written');
});

test('tools resolve the store from ctx.location, not from the tool context (V2 has no directory there)', async () => {
  const directory = project();
  const { host } = await mounted({}, directory);
  await host.tool('memory_remember').execute({ kind: 'semantic', summary: 'pinned store -> here' }, {});

  const status = JSON.parse((await host.tool('memory_maintain').execute(
    { action: 'status' },
    { sessionID: 'ses-1', agent: 'build', messageID: 'msg-1', id: 'call-1', directory: '/somewhere/else', signal: new AbortController().signal },
  )).content);
  assert.equal(status.storeFile, HippoPlugin.storeFile(directory, false), 'a bogus per-call directory must not re-key the store');
  assert.match(status.storeFile, /\.db$/);
});

/* ------------------------------------------------------------------ */
/* compaction + observability                                          */
/* ------------------------------------------------------------------ */

test('compaction carries the durable block into system and never replaces the host summary', async () => {
  const { host } = await mounted();
  await host.tool('memory_remember').execute({ kind: 'semantic', summary: 'survives compaction -> yes' }, {});

  const event = contextEvent({ system: [{ type: 'text', text: 'base prompt' }], messages: [] });
  delete event.result;
  await host.run('compaction', event);

  assert.equal(event.result, undefined, 'SessionCompaction.result stays the host\u2019s to set (spec §6)');
  assert.equal(event.system.filter((p) => text(p).includes('Durable memory')).length, 1);
  assert.match(event.system.at(-1).text, /hippo-memory digest/);
});

test('execute.after logs memory tools only, and never throws on a foreign tool', async () => {
  const { host } = await mounted();
  const memoryEvent = { tool: 'memory_recall', sessionID: 's', agent: 'a', messageID: 'm', id: 'c', input: {}, status: 'completed', result: {} };
  const foreignEvent = { tool: 'bash', sessionID: 's', agent: 'a', messageID: 'm', id: 'c', input: {}, status: 'completed', result: {} };

  const ours = await withLogs(async () => { await host.run('execute.after', memoryEvent); });
  assert.ok(ours.some((line) => line.includes('hippo-memory') && line.includes('memory_recall')),
    'the log stays greppable; ctx.app has no log face so console is the documented replacement');

  const foreign = await withLogs(async () => { await host.run('execute.after', foreignEvent); });
  assert.equal(foreign.filter((line) => line.includes('hippo-memory')).length, 0, 'other tools stay quiet');

  const errored = { ...memoryEvent, status: 'error', error: { message: 'boom' } };
  await withLogs(async () => { await host.run('execute.after', errored); });
});

test('session.idle reaches the subscription loop without breaking it', async () => {
  const { host, cleanup } = await mounted();
  await host.tool('memory_remember').execute({ kind: 'semantic', summary: 'idle probe -> kept' }, {});

  host.emit({ id: 'evt-1', created: 'now', type: 'session.idle', data: { sessionID: 'ses-1' } });
  for (let i = 0; i < 200 && host.state.deliveries === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(host.state.deliveries > 0, 'the for-await loop must actually consume the stream');
  // Housekeeping logs only at store-size milestones (V1 semantics kept), so nothing
  // is asserted about output here: an exception inside the loop would surface to
  // the runner as an unhandled rejection and fail this test.
  host.emit({ id: 'evt-2', created: 'now', type: 'session.updated', data: { sessionID: 'ses-1' } });
  for (let i = 0; i < 200 && host.state.deliveries < 2; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(host.state.deliveries, 2, 'an unrelated event type does not end the loop');

  // The loop survived, so the next outgoing call still carries the digest.
  const event = contextEvent({ system: [], messages: [] });
  await host.run('context', event);
  assert.equal(countDigest(event.system), 1);
  await cleanup();
});

/* ------------------------------------------------------------------ */
/* packaging                                                           */
/* ------------------------------------------------------------------ */

test('the package drops the V1 SDK and declares the V2 target without installing it', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies?.['@opencode-ai/plugin'], undefined,
    'route B: the V1 helper is gone, so the SDK import and its degraded-schema warning go with it');
  assert.equal(pkg.dependencies?.['@opencode/plugin'], undefined,
    'define() is an identity function and the tool schemas are inline JSON Schema: no runtime host import');
  // The official line is that a published plugin "should depend on a version of
  // @opencode/plugin compatible with the OpenCode release they target". An optional
  // peer dependency states that target without materialising the tree: declared as a
  // devDependency it resolved to 368 lock entries against 113 before (measured with
  // `npm install --package-lock-only`), i.e. effect + friends for types this repo
  // never compiles. Reopen only if a host turns out to need the package installed.
  assert.equal(pkg.peerDependencies?.['@opencode/plugin'], '^2.0.24');
  assert.equal(pkg.peerDependenciesMeta?.['@opencode/plugin']?.optional, true);
  assert.equal(pkg.devDependencies?.['@opencode/plugin'], undefined);
});

/* ------------------------------------------------------------------ */
/* behaviour belts migrated from the V1 suite (adapter.test.mjs)        */
/* ------------------------------------------------------------------ */
/*
 * These are the engine-facing claims the previous suite made through the V1 hook
 * object. They survive the port unchanged in substance: a V2 host that registers
 * four tools and one injection hook still has to answer them. Test bodies call the
 * tools the way the host will — `execute(input, toolContext)` returning
 * `{content}` — and the schema-facing assertions read `Tool.Info.input` instead of
 * the V1 `args` map.
 */

test('a changed value on the same subject overrides and reports what it retired', async () => {
  const { host } = await mounted();
  await call(host, 'memory_remember', {
    kind: 'semantic', summary: 'billing service database -> postgres', entities: ['billing'],
  });
  const second = await call(host, 'memory_remember', {
    kind: 'semantic', summary: 'billing service database -> mysql', entities: ['billing'],
  });
  assert.equal(second.outcome, 'override');
  assert.ok(second.superseded?.id, 'the retired revision must be reported');
  assert.match(second.warning ?? '', /override/);
});

test('verify reports support, contradiction and superseded matches', async () => {
  const { host } = await mounted();
  await call(host, 'memory_remember', { kind: 'semantic', summary: 'cache size -> 512 MB' });
  await call(host, 'memory_remember', { kind: 'semantic', summary: 'cache size -> 1024 MB' });
  const verdict = await call(host, 'memory_verify', { claim: 'cache size is 1024 MB' });
  assert.equal(typeof verdict.substantiated, 'boolean');
  assert.ok(Array.isArray(verdict.contradicting));
  assert.ok(Array.isArray(verdict.superseded_matches));
  assert.ok(verdict.note);
});

test('verify passes the WEAK_MATCH verdict and vetoing premises through to the model', async () => {
  const { host } = await mounted();
  await call(host, 'memory_remember', { kind: 'semantic', summary: 'ZZOCCUR the backend language is python' });
  const weak = await call(host, 'memory_verify', { claim: 'ZZOCCUR python brews the best espresso' });
  assert.equal(weak.substantiated, false, `topical proximity is not a yes: ${weak.note}`);
  assert.equal(weak.weak_match, true, 'the adapter must hand over the verdict, not swallow it');

  await call(host, 'memory_remember', { kind: 'semantic', summary: 'ZZVETO quota -> 40', scope: 'env=prod' });
  await call(host, 'memory_remember', { kind: 'semantic', summary: 'ZZVETO quota numbers are watched closely' });
  const veto = await call(host, 'memory_verify', { claim: 'ZZVETO quota -> 40', scope: 'env=dev' });
  assert.equal(veto.out_of_scope, true, `a scope-less fallback must not bless foreign premises: ${veto.note}`);
  assert.ok(Array.isArray(veto.scope_conflicts) && veto.scope_conflicts.length > 0, 'the vetoing row is named');
});

test('remember carries scope and verify answers OUT_OF_SCOPE for foreign premises', async () => {
  const { host } = await mounted();
  const written = await call(host, 'memory_remember', {
    kind: 'semantic',
    summary: 'the pair stays at the independence baseline',
    scope: 'population=all records; comparator=instruction start',
  });
  assert.equal(written.scope, 'population=all records; comparator=instruction start');

  const off = await call(host, 'memory_verify', {
    claim: 'the pair stays at the independence baseline',
    scope: 'comparator=disp field of the recorded instruction',
  });
  assert.equal(off.out_of_scope, true, `foreign premises must not substantiate: ${off.note}`);
  assert.equal(off.substantiated, false);

  const on = await call(host, 'memory_verify', {
    claim: 'the pair stays at the independence baseline',
    scope: 'comparator=instruction start',
  });
  assert.equal(on.out_of_scope, false);
  assert.equal(on.substantiated, true);

  const recalled = await call(host, 'memory_recall', { query: 'independence baseline comparator' });
  assert.equal(recalled.hits[0].scope, 'population=all records; comparator=instruction start');
});

test('maintain status reports the driver and store diagnostics', async () => {
  const { host } = await mounted();
  await call(host, 'memory_remember', { kind: 'semantic', summary: 'status probe -> ok' });
  const status = await call(host, 'memory_maintain', { action: 'status' });
  assert.ok(['node:sqlite', 'bun:sqlite'].includes(status.driver));
  assert.ok(status.diagnostics?.embedder?.kind);
  assert.ok(status.diagnostics?.thresholds);
  const stats = await call(host, 'memory_maintain', { action: 'stats' });
  assert.equal(stats.active, 1);
});

test('maintain status: an empty project store says the memories are next door', async () => {
  const full = await mounted();
  await call(full.host, 'memory_remember', { kind: 'semantic', summary: 'ZZSPL the fact lives here -> 1' });
  // mounted() resets the cache, so the write is closed and flushed before the second,
  // empty project store scans its siblings — the same order the V1 suite drove.
  const empty = await mounted();
  const status = await call(empty.host, 'memory_maintain', { action: 'status' });
  const file = HippoPlugin.storeFile(full.directory, false).split(/[\\/]/).pop();
  const sibling = status.diagnostics.sibling_stores.stores.find((s) => s.file === file);
  assert.equal(sibling?.rows, 1, `the other project store is counted: ${JSON.stringify(status.diagnostics.sibling_stores)}`);
  assert.equal(sibling.current, false, 'and it is not the one answering');
  assert.match(String(status.health), /split|another store|sibling/i, `status says it, not just the table: ${status.health}`);
  assert.match(String(status.diagnostics.scope_rule), /never cross|one store|per /i);
  assert.match(String(status.path_rule), /project director/i, 'and names the rule this host applies');
});

test('maintain: duplicates -> merge previews, then retires the extra into the survivor', async () => {
  const { host } = await mounted();
  const ep = await call(host, 'memory_remember', {
    kind: 'episode',
    summary: 'ZZMRG modbus timeout -> 1500 ms on the gateway',
    entities: ['zzmrg'],
    importance: 0.9,
  });
  await call(host, 'memory_maintain', { action: 'consolidate' });
  const rep = await call(host, 'memory_maintain', { action: 'duplicates' });
  const group = rep.groups.find((g) => g.memories.some((x) => x.id === ep.id));
  assert.ok(group, `the episode/rule pair is reported: ${JSON.stringify(rep)}`);
  assert.equal(group.mixedPremises, false, 'the report says the pair is mergeable');
  const ids = group.memories.map((x) => x.id);

  const preview = await call(host, 'memory_maintain', { action: 'merge', ids });
  assert.equal(preview.dry_run, true, 'the default is a preview');
  assert.equal(preview.retired.length, 1);
  const before = await call(host, 'memory_maintain', { action: 'list' });
  assert.ok(ids.every((id) => before.some((x) => x.id === id)), 'a preview retires nothing');

  const applied = await call(host, 'memory_maintain', { action: 'merge', ids, dry_run: false });
  assert.equal(applied.ok, true, `merge applied: ${JSON.stringify(applied)}`);
  assert.equal(applied.retired.length, 1);
  const listed = await call(host, 'memory_maintain', { action: 'list' });
  const folded = listed.find((x) => x.id === applied.retired[0].id);
  assert.ok(folded, 'the folded row is still listed — merge did not delete it');
  assert.equal(folded.demoted, true, 'and it says which row is folded, so undemote has an id to work from');
  const after = await call(host, 'memory_maintain', { action: 'duplicates' });
  assert.ok(!after.groups.some((g) => g.memories.some((x) => ids.includes(x.id))), 'merged group stops being reported');
  const rec = await call(host, 'memory_recall', { query: 'ZZMRG modbus timeout', limit: 10 });
  assert.equal(rec.hits.filter((h) => ids.includes(h.id)).length, 1, 'one restatement is offered, not two');

  // The note promises undemote restores the retired row; the host must offer it.
  const back = await call(host, 'memory_maintain', { action: 'undemote', ids: [applied.retired[0].id] });
  assert.deepEqual(back.restored, [applied.retired[0].id], 'merge is reversible from this host');
  const again = await call(host, 'memory_maintain', { action: 'duplicates' });
  assert.ok(again.groups.some((g) => g.memories.some((x) => x.id === applied.retired[0].id)), 'restored row is reported again');
});

test('maintain: merge refuses to fold rows that state different premises', async () => {
  const { host } = await mounted();
  const a = await call(host, 'memory_remember', {
    kind: 'semantic',
    summary: 'ZZMIX replacement rate -> below the independence baseline',
    scope: 'population=all records',
    entities: ['zzmix'],
  });
  const b = await call(host, 'memory_remember', {
    kind: 'semantic',
    summary: 'ZZMIX replacement rate -> below the independence baseline',
    scope: 'population=first 4096 rows',
    entities: ['zzmix'],
  });
  const rep = await call(host, 'memory_maintain', { action: 'duplicates' });
  const group = rep.groups.find((g) => g.memories.some((x) => x.id === a.id));
  assert.ok(group, `pair reported: ${JSON.stringify(rep)}`);
  assert.equal(group.mixedPremises, true, 'the report flags the clash before anyone merges');
  // Per-pair flag, per-row consequence: the advice must not tell the model to
  // write off the whole group, because the rest of it can still be real duplicates.
  assert.match(rep.note, /not restatements of each other/, 'the note names what the flag means');
  assert.doesNotMatch(rep.note, /is NOT duplicates/);
  const applied = await call(host, 'memory_maintain', { action: 'merge', ids: [a.id, b.id], dry_run: false });
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
  // sharedStore: two projects, one file. Both hosts are mounted without resetting the
  // cache in between, because the point of the option is that they share the handle.
  const dirA = project();
  const dirB = project();
  const a = await mountAlongside({ sharedStore: true }, dirA);
  await call(a, 'memory_remember', { kind: 'semantic', summary: 'shared store -> visible everywhere' });
  const b = await mountAlongside({ sharedStore: true }, dirB);
  const fromB = await call(b, 'memory_recall', { query: 'shared store' });
  assert.equal(fromB.hits.length, 1, 'both projects read the same store');
  assert.match(HippoPlugin.storeFile(dirA, true), /shared\.db$/, 'and the file is the shared one');

  // similarityThreshold reaches the report the model reads, not just the engine.
  const strict = await mounted({ similarityThreshold: 0.95 });
  await call(strict.host, 'memory_remember', { kind: 'semantic', summary: 'threshold probe -> value' });
  const strictRecall = await call(strict.host, 'memory_recall', { query: 'threshold probe' });
  assert.equal(strictRecall.threshold, 0.95);
  assert.equal(typeof strictRecall.bestSimilarity, 'number');

  // contextLimit caps the injected memory lines. The cue has to clear the recall floor
  // for the cap to be visible at all: with a cue like "the whole stack" the engine
  // returns zero items at every limit and the digest is the "no memory above threshold"
  // stub (measured: 194 chars, items 0, limits 1/2/5 identical). A cue that names each
  // subject gives the exact ladder the probe showed — limit 1 -> 1 line, 2 -> 2, 5 -> 5.
  const facts = [
    'cache tier -> redis', 'queue tier -> kafka', 'gateway port -> 8443', 'release train -> 2026.10', 'owner team -> platform',
  ];
  const cue = facts.map((f) => f.split(' -> ')[0]).join(' ');
  const lines = async (contextLimit) => {
    const { host } = await mounted({ contextLimit });
    for (const summary of facts) await call(host, 'memory_remember', { kind: 'semantic', summary });
    const event = contextEvent({ system: [], messages: [{ role: 'user', content: [{ type: 'text', text: cue }] }] });
    await host.run('context', event);
    const digest = text(event.system.find(isDigest));
    return { digest, memory: digest.split('\n').filter((line) => line.includes('->')).length };
  };
  const one = await lines(1);
  const five = await lines(5);
  assert.equal(one.memory, 1, `contextLimit 1 injects one line: ${one.digest}`);
  assert.equal(five.memory, 5, `contextLimit 5 injects all five: ${five.digest}`);
  assert.ok(five.digest.length > one.digest.length);
});

test('F5: an undeclared argument is refused, naming the declared ones', async () => {
  const { host } = await mounted();
  const res = await call(host, 'memory_remember', {
    kind: 'semantic',
    summary: 'ZZF5 the deploy gate runs the smoke suite first',
    detail2: 'typo',
    not_a_field: true,
  });
  assert.equal(res.ok, false, `the call must fail: ${JSON.stringify(res)}`);
  assert.match(res.error, /unknown argument/i);
  assert.match(res.error, /detail2/);
  assert.match(res.error, /not_a_field/);
  assert.match(res.error, /summary/, 'the caller must see what it could have written');

  const rec = await call(host, 'memory_recall', { query: 'ZZF5 the deploy gate runs the smoke suite first' });
  assert.equal(rec.hits.length, 0, 'a refused write stores nothing');
});

test('F5 guard: declared arguments still pass the boundary', async () => {
  const { host } = await mounted();
  const written = await call(host, 'memory_remember', {
    kind: 'semantic',
    summary: 'ZZF5b the deploy gate runs the smoke suite first',
    detail: 'after the build',
    scope: 'env=staging',
  });
  assert.equal(written.outcome, 'new', JSON.stringify(written));
});

test('F4b: memory_recall carries the anchor fields on every hit', async () => {
  const { host } = await mounted();
  await call(host, 'memory_remember', { kind: 'semantic', summary: 'ZZF4b the canary window is one hour before the rollback gate' });
  const rec = await call(host, 'memory_recall', { query: 'ZZF4b canary window' });
  assert.equal(rec.hits.length, 1, 'the fixture row is a hit');
  assert.equal(typeof rec.hits[0].anchored, 'boolean', `anchored must arrive: ${JSON.stringify(rec.hits[0])}`);
  assert.equal(rec.hits[0].anchored, true, 'a cue naming the claim subject is anchored');
  assert.ok(rec.hits[0].anchors.includes('subject'), `tiers: ${JSON.stringify(rec.hits[0].anchors)}`);
});

/* ------------------------------------------------------------------ */
/* the instruction surface the model actually reads                    */
/* ------------------------------------------------------------------ */
/*
 * Report #2's root cause was an instruction that taught one ritual (`key=value`)
 * agents do not write; report #4's was a ranking number that reads like a confidence
 * score. In V2 these strings live on `Tool.Info.description` and
 * `Tool.Info.input.properties.<name>.description` instead of the V1 `args` map, which
 * is exactly why they need a belt here: a port that re-plumbs the schema can drop the
 * prose that keeps the model honest without any test noticing.
 */

test('instruction surface: memory_recall describes the fields it actually sends', async () => {
  const { host } = await mounted();
  const d = host.tool('memory_recall').description;
  assert.match(d, /anchored/i, `the hit field must be named where the model reads how to use it: ${d}`);
  assert.match(d, /anchors/, 'the tier list is the readable part');
  assert.match(d, /relativeScore/, 'the ranking value must be told apart from evidence');
  // hitView sends similarity/relativeScore, never a bare `score`.
  assert.doesNotMatch(d, /\bscore\b/, `the description must not promise a field the view drops: ${d}`);
});

test('instruction surface: duplicates is described as two channels', async () => {
  const { host } = await mounted();
  const info = host.tool('memory_maintain');
  const d = `${info.description} ${info.input.properties.action.description}`;
  assert.match(d, /\btext\b/, 'the verbatim-restatement channel');
  assert.match(d, /vector/i, 'a paraphrase of one statement is a duplicate too (report #1)');
});

test('instruction surface: every scope argument documents the plain form', async () => {
  const { host } = await mounted();
  for (const name of ['memory_remember', 'memory_recall', 'memory_verify']) {
    const sc = host.tool(name).input.properties.scope;
    assert.ok(sc, `${name} takes scope`);
    assert.match(sc.description ?? '', /plain condition/i, `${name}: scope must not teach only key=value`);
  }
});

test('instruction surface: DISCIPLINE names anchors, both channels, plain premises', () => {
  const d = HippoPlugin.DISCIPLINE;
  assert.match(d, /anchored/, 'RECALL must say what anchored:false means');
  assert.match(d, /vector/i, 'MAINTAIN must say the report also catches paraphrases');
  assert.match(d, /plain condition/i, 'WRITE must not teach a ritual agents do not write');
  assert.match(d, /memory_verify/, 'the discipline must name every tool the model can call');
  assert.match(d, /\bmerge\b/, 'a duplicates report the agent cannot act on is a dead end');
  assert.match(d, /low-confidence/, 'the digest can carry one line that is a guess');
});
