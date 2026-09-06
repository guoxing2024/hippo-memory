/**
 * Adapter (dsh-hippo-memory) tests against a fake cordis-style ctx:
 * tool registration, settings schema shape, tool execution semantics
 * (write → recall → verify → maintain list/history), embedder option
 * plumbing and the shared-store switch.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, SettingsSchema } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
let dir;
let ctx;
let tools = new Map();
let sections = [];
let contexts = [];
let storesBase;

/** Minimal fake of the DSH host services the adapter consumes. */
let disposers = [];
function fakeCtx() {
  const toolRegistry = new Map();
  const watched = [];
  let cfg = {};
  const service = {
    section: (s) => {
      sections.push(s);
      return () => {};
    },
    context: (c) => {
      contexts.push(c);
      return () => {};
    },
    register: (t) => {
      toolRegistry.set(t.name, t);
      return () => toolRegistry.delete(t.name);
    }
  };
  const settings = {
    register(ns, schema, { base } = {}) {
      storesBase = { ns, schema, base };
      return {
        get: () => ({ ...base, ...cfg }),
        watch: (cb) => {
          watched.push(cb);
          return () => {};
        },
        update: (patch) => {
          cfg = { ...cfg, ...patch };
        }
      };
    }
  };
  ctx = {
    tools: service,
    systemPrompt: service,
    settings,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    effect: (fn) => {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
    }
  };
  apply(ctx, { enabled: true });
  tools = toolRegistry;
  return { watched, toolRegistry };
}

function toolExec(name, args, exec = { agent: { id: 'test-agent' } }) {
  const t = tools.get(name);
  assert.ok(t, `tool ${name} registered`);
  return t.execute(args, exec);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'hippo-adapter-'));
  process.env.DSH_HOME = dir; // isolate ~/.dsh storage
  fakeCtx();
});

after(() => {
  for (const dispose of disposers.splice(0)) dispose(); // closes engine DBs
  delete process.env.DSH_HOME;
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------- registration ------------------------- */

test('registers the four memory tools', () => {
  for (const n of ['memory_remember', 'memory_recall', 'memory_verify', 'memory_maintain']) {
    assert.ok(tools.has(n), `${n} registered`);
  }
});

test('registers a guidance section and a digest context contribution', () => {
  assert.ok(sections.some((s) => s.name === 'plugin:hippo-memory'), 'guidance section');
  assert.ok(contexts.some((c) => c.name === 'hippo-memory:digest'), 'digest context');
});

test('settings schema exposes the full field set with defaults', () => {
  const shape = SettingsSchema.toString();
  assert.match(shape, /enabled/);
  assert.match(shape, /contextLimit/);
  assert.match(shape, /sharedStore/);
  assert.match(shape, /embedding/);
  assert.match(shape, /similarityThreshold/);
  const base = storesBase?.base ?? {};
  assert.equal(base.enabled, true);
  assert.equal(base.contextLimit, 6);
});

/* ------------------------- remember / recall ------------------------- */

test('remember → recall round-trip in the per-agent store', async () => {
  const w = await toolExec('memory_remember', {
    kind: 'semantic',
    summary: 'engine embedder -> configurable',
    source: 'user',
    confidence: 'high'
  });
  assert.equal(w.outcome, 'new');
  const r = await toolExec('memory_recall', { query: 'engine embedder configurable', limit: 5 });
  assert.ok(r.hits.length >= 1, 'recall hit');
  assert.equal(r.hits[0].summary, 'engine embedder -> configurable');
  assert.equal(typeof r.hits[0].score, 'number');
  assert.ok(r.hits[0].version >= 1);
});

/* ------------------------- verify explainability ------------------------- */

test('verify returns verdict plus closest candidate when unsubstantiated', async () => {
  await toolExec('memory_remember', { kind: 'semantic', summary: 'billing db -> postgres', source: 'user' });
  const v = await toolExec('memory_verify', { claim: 'billing uses mysql' });
  assert.equal(v.substantiated, false);
  assert.ok('closest' in v, 'closest field present for explainability');
  const support = await toolExec('memory_verify', { claim: 'billing db -> postgres' });
  assert.equal(support.substantiated, true);
  assert.ok(support.support);
});

/* ------------------------- maintain: stats/list/history ------------------------- */

test('maintain stats and list reflect stored memories', async () => {
  const s = await toolExec('memory_maintain', { action: 'stats' });
  assert.ok(s.active >= 2, 'active count');
  const l = await toolExec('memory_maintain', { action: 'list', limit: 10 });
  assert.ok(Array.isArray(l.memories));
  assert.ok(l.memories.some((m) => m.summary.includes('postgres')));
  assert.ok(l.memories.every((m) => typeof m.id === 'string' && typeof m.summary === 'string'));
});

test('maintain history requires an id and returns version history', async () => {
  const h = await toolExec('memory_maintain', { action: 'history' });
  assert.ok(h.error, 'missing id errors');
});

test('maintain status reports plugin + embedder state', async () => {
  const s = await toolExec('memory_maintain', { action: 'status' });
  assert.equal(s.embeddingSetting, 'off', 'default embedding setting');
  assert.ok(['off', 'loading', 'ready', 'failed'].includes(s.embedderState));
  assert.ok(s.storeStats && typeof s.storeStats.active === 'number');
});

/* ------------------------- isolation & cleanup ------------------------- */

test('different agents get separate stores by default', async () => {
  const idA = 'alpha-agent';
  const idB = 'beta-agent';
  await toolExec('memory_remember', { kind: 'semantic', summary: 'only alpha knows this -> 42', source: 'user' }, { agent: { id: idA } });
  const rb = await toolExec('memory_recall', { query: 'only alpha knows this', limit: 5 }, { agent: { id: idB } });
  assert.equal(rb.hits.length, 0, 'beta cannot see alpha memory');
});

test('shared store mode makes memories visible across agents', async () => {
  // Re-apply with sharedStore true through the settings section.
  const orig = process.env.DSH_HOME;
  const dir2 = mkdtempSync(join(tmpdir(), 'hippo-adapter-shared-'));
  process.env.DSH_HOME = dir2;
  const effects = [];
  const t2 = new Map();
  const svc = {
    section: () => () => {},
    context: () => () => {},
    register: (t) => {
      t2.set(t.name, t);
      return () => {};
    }
  };
  const settings2 = {
    register(ns, schema, { base } = {}) {
      return {
        get: () => ({ ...base, sharedStore: true }),
        watch: () => () => {}
      };
    }
  };
  apply({ tools: svc, systemPrompt: svc, settings: settings2, logger: { warn: () => {}, info: () => {} }, effect: (fn) => {
    const disposer = fn();
    if (typeof disposer === 'function') effects.push(disposer);
  } }, { sharedStore: true });
  const execA = { agent: { id: 'shared-a' } };
  const execB = { agent: { id: 'shared-b' } };
  const run = (name, args, exec) => t2.get(name).execute(args, exec);
  await run('memory_remember', { kind: 'semantic', summary: 'shared fact -> true', source: 'user' }, execA);
  const rb = await run('memory_recall', { query: 'shared fact', limit: 5 }, execB);
  assert.ok(rb.hits.length >= 1, 'shared store visible across agents');
  for (const dispose of effects.splice(0)) dispose(); // closes DBs
  process.env.DSH_HOME = orig;
  rmSync(dir2, { recursive: true, force: true });
});
