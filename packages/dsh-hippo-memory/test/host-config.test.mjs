/**
 * Host-half contract against the DSH 0.1.7 configuration API.
 *
 * 0.1.7 deleted `settings.register()`. A plugin no longer registers a
 * namespace: it exports a `Config` schema whose editable fields are declared
 * `.volatile()`, the Loader hands `apply()` one live reference per field, the
 * settings page projects the volatile subset by profile entry id, and a
 * write commits in place and emits `loader/volatile-update`.
 *
 * These tests pin that shape — and the property that made the 0.1.7 upgrade a
 * total failure rather than a degraded one: nothing in the configuration layer
 * may abort tool registration.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, Config } from '../lib/index.js';
import { loaderConfig } from './fake-host.mjs';

/**
 * Fake of the DSH host services the adapter consumes.
 * `settings` is the 0.1.7 SettingsForms face: describe/update/configure, and
 * deliberately NO register().
 */
function harness({ config = loaderConfig(), settings = { describe: () => [], configure: () => () => {} }, emitDuringMount = false } = {}) {
  const tools = new Map();
  const sections = [];
  const contexts = [];
  const warnings = [];
  const listeners = new Map();
  const disposers = [];
  const surface = {
    section: (s) => { sections.push(s); return () => {}; },
    context: (c) => { contexts.push(c); return () => {}; },
    register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name); }
  };
  const ctx = {
    tools: surface,
    systemPrompt: surface,
    ...(settings === null ? {} : { settings }),
    logger: { warn: (...a) => warnings.push(a.join(' ')), info: () => {}, error: () => {} },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    on: (event, cb) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
      // cordis delivers emits synchronously, so a host may move the section
      // while this plugin's apply() is still running.
      if (emitDuringMount && event === 'loader/volatile-update') cb([['enabled']]);
      return () => listeners.get(event)?.delete(cb);
    }
  };
  apply(ctx, config);
  const h = {
    ctx,
    config,
    tools,
    sections,
    contexts,
    warnings,
    emit: (event, ...args) => { for (const cb of listeners.get(event) ?? []) cb(...args); },
    dispose: () => { for (const dispose of disposers.splice(0)) dispose(); }
  };
  mounted.push(h);
  return h;
}

let dir;
const mounted = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'hippo-dsh-config-'));
  process.env.DSH_HOME = dir;
});
after(() => {
  for (const h of mounted.splice(0)) h.dispose();
  delete process.env.DSH_HOME;
  rmSync(dir, { recursive: true, force: true });
});

/* --------------------- the 0.1.7 crash being fixed --------------------- */

test('mounts the memory tools on a host whose settings service has no register()', () => {
  const h = harness();
  for (const n of ['memory_remember', 'memory_recall', 'memory_verify', 'memory_maintain']) {
    assert.ok(h.tools.has(n), `${n} registered`);
  }
  assert.deepEqual(h.warnings, [], 'no degradation reported');
});

test('mounts the memory tools on a host that serves no settings service at all', () => {
  const h = harness({ settings: null });
  assert.equal(h.tools.size, 4, 'the configuration layer cannot take the tools with it');
});

/* ------------------------- the Config schema ------------------------- */

test('every editable field is declared volatile so the settings form projects it', () => {
  for (const field of ['enabled', 'contextLimit', 'sharedStore', 'embedding', 'similarityThreshold']) {
    assert.equal(Config.dict[field]?.meta?.volatile, true, `${field} is live-editable`);
  }
});

test('the schema carries the composition defaults', () => {
  assert.equal(Config.dict.enabled.meta.default, true);
  assert.equal(Config.dict.contextLimit.meta.default, 6);
  assert.equal(Config.dict.sharedStore.meta.default, false);
  assert.equal(Config.dict.embedding.meta.default, 'auto', 'semantic recall is the default (audit #0)');
  assert.equal(Config.dict.similarityThreshold.meta.required, false, 'unset means the engine default');
});

/* --------------------- reading through references --------------------- */

test('enabled is read through its reference, not as a raw value', () => {
  const h = harness({ config: loaderConfig({ enabled: false }) });
  assert.equal(h.tools.size, 0, 'a disabled mount registers nothing');
});

test('a volatile update re-applies the configuration without remounting the plugin', () => {
  const h = harness();
  assert.equal(h.tools.size, 4, 'mounted');
  h.config.enabled.write(false);
  h.emit('loader/volatile-update', [['enabled']]);
  assert.equal(h.tools.size, 0, 'unmounted by the live edit');
  h.config.enabled.write(true);
  h.emit('loader/volatile-update', [['enabled']]);
  assert.equal(h.tools.size, 4, 'remounted by the live edit');
});

/* --------------------- never fail the whole plugin --------------------- */

test('a host config carrying no references degrades to defaults instead of throwing', () => {
  const h = harness({ config: { enabled: false } });
  assert.equal(h.tools.size, 0, 'the plain value is still honoured');
  const plain = harness({ config: {} });
  assert.equal(plain.tools.size, 4, 'missing fields fall back to the schema defaults');
});

test('a volatile update delivered while the plugin is mounting does not abort it', () => {
  const h = harness({ emitDuringMount: true });
  assert.equal(h.tools.size, 4, 'the listener must not read state that apply() has not built yet');
});
