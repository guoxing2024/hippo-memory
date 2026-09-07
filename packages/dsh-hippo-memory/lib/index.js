/**
 * dsh-hippo-memory — DeepSeek runtime (DSH) profile bundle adapter (host half).
 *
 * Wires the hippocampus-inspired long-term memory engine (the framework-
 * agnostic `hippo-memory` package) into a DSH profile:
 *
 *   tools           memory_remember / memory_recall / memory_verify /
 *                   memory_maintain (model-visible, per-session stores)
 *   guidance        a system-prompt section teaching when to write / recall /
 *                   verify / maintain (source-monitoring discipline)
 *   runtime context a [hippo-memory digest] block auto-injected per assembly
 *                   (working-memory gate; synchronous cache + async refresh)
 *   settings        a `hippo-memory` settings namespace (enabled, contextLimit,
 *                   sharedStore) editable from the Web GUI plugin card; the
 *                   card is contributed by the browser half of this package.
 *
 * Resolution notes (DSH profile mechanics):
 *   - The plugin row comes from this package's cordis.patch.yml insert.
 *   - @deepseek-ai/* imports resolve up the ancestor chain to the shared
 *     runtime pool at $DSH_HOME/profiles/node_modules (healed at boot).
 *   - hippo-memory is a file: dependency of this package, so no registry
 *     publish is needed for local development.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// hippo-memory-core may be hoisted (pnpm install of this package) or absent
// (direct link: install of this folder). Try the hoisted name first, then
// resolve the sibling source package relative to this file.
let HippoMemory;
try {
  ({ HippoMemory } = await import('hippo-memory-core'));
} catch {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = pathToFileURL(join(here, '..', '..', '..', 'dist', 'index.js')).href;
  ({ HippoMemory } = await import(src));
}

const name = 'hippo-memory';
const inject = ['systemPrompt', 'tools', 'settings'];

/** Settings namespace owned by this plugin (the key its GUI card edits). */
const SETTINGS_NS = 'hippo-memory';
/** Composition schema of the settings section; the user layer overrides it. */
const SettingsSchema = z.object({
  enabled: z.boolean().default(true),
  contextLimit: z.number().min(1).max(20).default(6),
  sharedStore: z.boolean().default(false),
  /** 'auto' = lazily load a local embedding model for stronger recall (CJK/paraphrase); 'off' = built-in hashing embedder. */
  embedding: z.union(['off', 'auto']).default('off'),
  /** recall similarity floor; lower = more lenient recall, higher = stricter. Leave unset for engine default (0.32). */
  similarityThreshold: z.number().min(0.05).max(0.95).required(false)
});
/** Plugin Config (patch-row layer) — same shape; installed as section base. */
const Config = SettingsSchema;

const GUIDANCE = `## Long-term memory (hippocampus-inspired)

You have an explicit long-term memory store. Follow this discipline instead of relying on the raw transcript for old facts:

1. WRITE — after learning a durable fact or finishing a meaningful event, call memory_remember (kind: semantic = rules, episode = events, procedure = skills). Prefer a structured summary "<subject> -> <value>" so later corrections version cleanly instead of conflicting.
2. RECALL — before answering anything that depends on facts from earlier in this session (or a past session), call memory_recall with the question as the query.
3. VERIFY — before asserting a remembered fact as current, call memory_verify with the claim. If it returns substantiated=false, answer "not in my memory / I don't know" — never confabulate. If contradicted, flag the conflict and use the newest revision.
4. MAINTAIN — call memory_maintain (consolidate / forget) occasionally in long sessions so the store stays compact.
5. The [hippo-memory digest] runtime-context block (when present) lists memories retrieved automatically for the current task with provenance — treat them as retrieved evidence, never as license to invent more. They may lag one step behind a memory_remember write; trust memory_verify for authoritative checks.`;

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
}

function sanitize(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function agentIdOf(exec) {
  return exec?.agent?.id ?? exec?.sessionId ?? 'shared';
}

/** Text output contract shared by every tool (render is UI-only). */
function outputOf() {
  return {
    schema: { type: 'json', description: 'JSON result payload.' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
  };
}

function present(title, kind, rawInput) {
  return { card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }) };
}

/** Drop undefined leaves so the DSH tool layer (lossless-JSON gate) accepts the
 *  payload. SQLite null columns surface as undefined through the engine's
 *  row mapping; undefined is not JSON, null is. */
function cleanJson(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(cleanJson);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = cleanJson(v);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* plugin entry                                                         */
/* ------------------------------------------------------------------ */

function apply(ctx, config = {}) {
  const t = ctx.tools;
  const sp = ctx.systemPrompt;
  const settings = ctx.settings;
  if (!t || !sp) {
    ctx.logger?.warn?.('hippo-memory: tools/systemPrompt services unavailable; plugin idle');
    return;
  }

  /** Composition default (patch row / Config) — installed as the settings base. */
  const entry = {
    enabled: config.enabled !== false,
    contextLimit: config.contextLimit ?? 6,
    sharedStore: config.sharedStore === true,
    embedding: config.embedding ?? 'off',
    similarityThreshold: config.similarityThreshold ?? undefined
  };

  // Register the settings namespace when the settings service is present so the
  // Web GUI plugin card can read/override this section. The browser half of this
  // package contributes the card under the same key.
  const sectionScope = settings ? settings.register(SETTINGS_NS, SettingsSchema, { base: entry }) : undefined;

  /** Current effective settings: the settings section when served, else the
   *  composition entry (patch row / Config). The settings.register base IS the
   *  composition entry, so sectionScope.get() already folds user overrides. */
  const current = () => (sectionScope ? sectionScope.get() : entry);

  if (sectionScope) {
    sectionScope.watch(() => {
      const next = sectionScope.get();
      setEnabled(next.enabled);
      // embedding / threshold changes require rebuilt engine instances
      // (engine options are fixed at construction; DB files persist).
      const sig = `${next.embedding}:${next.similarityThreshold ?? 'def'}`;
      if (sig !== lastSig) {
        lastSig = sig;
        for (const key of [...stores.keys()]) stores.delete(key);
        digestCache.clear();
        void applyStoreSettings();
      }
    });
  }

  /** Registered-store registry (agent key -> instance) + digest cache. */
  const stores = new Map();
  const digestCache = new Map();
  const REFRESH_MS = 1500;
  let enabled = entry.enabled;
  let disposers = [];
  let lastSig = `${entry.embedding}:${entry.similarityThreshold ?? 'def'}`;

  /** Embedding provider state: 'off' | 'loading' | 'ready' | 'failed' (+ cached provider). */
  let embedState = 'off';
  let embedProvider = null;
  let embedWarned = false;

  const embedderOptions = () => {
    const opts = {};
    const cfg = current();
    if (typeof cfg.similarityThreshold === 'number') opts.similarityThreshold = cfg.similarityThreshold;
    return opts;
  };

  /** Load the local embedding model once (lazy). Never throws: any failure
   *  degrades to the built-in hashing embedder with one log line. */
  const ensureEmbedder = async () => {
    if (embedState === 'ready' || embedState === 'loading') return embedProvider;
    const cfg = current();
    if (cfg.embedding !== 'auto') {
      embedState = 'off';
      return null;
    }
    embedState = 'loading';
    const startedAt = Date.now();
    try {
      const mod = await import('@xenova/transformers');
      const { env, pipeline } = mod;
      try {
        env.cacheDir = join(dshHome(), 'storages', 'hippo-memory', 'models');
        env.allowLocalModels = false;
      } catch { /* env fields are best-effort */ }
      ctx.logger?.info?.('hippo-memory: embedding model requested (auto). First use downloads ~24MB quantized model to storages/hippo-memory/models — this can take a minute depending on your network.');
      const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5');
      // transformers.js returns one Tensor: dims = [batch, hidden]. Split the
      // flat data by batch — never treat the whole buffer as one vector.
      const splitRows = (out) => {
        const data = out?.data;
        const batch = out?.dims?.[0] ?? 1;
        if (!data) return [];
        const rowLen = data.length / batch;
        const rows = [];
        for (let i = 0; i < batch; i++) {
          rows.push(Array.from(data.subarray ? data.subarray(i * rowLen, (i + 1) * rowLen) : data.slice(i * rowLen, (i + 1) * rowLen)));
        }
        return rows;
      };
      const probe = await extractor(['probe'], { pooling: 'mean', normalize: true });
      const probeRows = splitRows(probe);
      const dim = probeRows[0]?.length ?? 512;
      embedProvider = {
        dim,
        embed: async (texts) => {
          const out = await extractor(texts, { pooling: 'mean', normalize: true });
          return splitRows(out);
        }
      };
      embedState = 'ready';
      ctx.logger?.info?.(`hippo-memory: local embedding model ready (bge-small-zh-v1.5, ${dim}-d, ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    } catch (err) {
      embedState = 'failed';
      embedProvider = null;
      if (!embedWarned) {
        embedWarned = true;
        ctx.logger?.warn?.(`hippo-memory: embedding model unavailable (${err?.message ?? err}); falling back to hashing embedder`);
      }
    }
    return embedProvider;
  };

  const storeFor = (id) => {
    const key = sanitize(id || 'shared');
    let got = stores.get(key);
    if (!got) {
      const cfg = current();
      const dbDir = join(dshHome(), 'storages', 'hippo-memory');
      mkdirSync(dbDir, { recursive: true });
      const inst = new HippoMemory({
        dbPath: join(dbDir, `${cfg.sharedStore ? 'shared' : key}.db`),
        options: embedderOptions()
      });
      stores.set(key, { inst });
      if (embedState === 'ready' && embedProvider) {
        inst.setEmbedder(embedProvider);
        // One-shot migration for stores first opened after the model loaded.
        void inst.ensureEmbeddingMigration().then((n) => {
          if (n > 0) ctx.logger?.info?.(`hippo-memory: re-embedded ${n} legacy row(s) in store ${key}`);
        }).catch(() => {});
      }
      return inst;
    }
    return got.inst;
  };

  /** Apply embedding/阈值 settings to every live store: attach the model when
   *  ready and available; one-shot re-embed of legacy hash rows (persisted
   *  marker ensures it runs once); reset the cache so digest picks the new
   *  threshold. */
  const applyStoreSettings = async () => {
    await ensureEmbedder();
    for (const { inst } of stores.values()) {
      if (embedProvider) {
        inst.setEmbedder(embedProvider);
        try {
          const n = await inst.ensureEmbeddingMigration();
          if (n > 0) ctx.logger?.info?.(`hippo-memory: re-embedded ${n} legacy memory row(s) with the embedding model`);
        } catch (err) {
          ctx.logger?.warn?.(`hippo-memory: embedding migration failed (${err?.message ?? err}); old rows stay on hashing vectors`);
        }
      }
    }
    digestCache.clear();
  };

  const latestUserCue = (session) => {
    try {
      const nodes = session?.surface?.nodes;
      if (!nodes || !Array.isArray(nodes)) return '';
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (node?.type !== 'user/message') continue;
        const text = node?.text ?? node?.content ?? node?.data?.content;
        if (typeof text === 'string' && text.trim()) return text.trim();
      }
    } catch {
      /* non-conforming session shape */
    }
    return '';
  };

  const refreshDigest = (agentKey, cue) => {
    const store = stores.get(agentKey);
    if (!store) return;
    const now = Date.now();
    const cached = digestCache.get(agentKey);
    if (cached?.refreshing) return;
    // Same-cue skip only when the cached digest is non-empty: an empty result
    // (e.g. computed while the model was still loading) must be retried on the
    // next render, otherwise repeated identical cues show nothing forever.
    if (cached?.cue === cue && cached?.digest) return;
    if (cached && now - cached.at < REFRESH_MS && cached?.digest) return;
    const ent = cached ?? { digest: '', cue: '', at: 0 };
    ent.cue = cue;
    ent.refreshing = store.inst
      .composeContext(cue || '', { limit: current().contextLimit })
      .then(({ context: digest }) => {
        ent.digest = digest || '';
        ent.at = Date.now();
      })
      .catch(() => {
        ent.at = Date.now();
      })
      .finally(() => {
        ent.refreshing = undefined;
      });
    digestCache.set(agentKey, ent);
  };

  /** Human-readable embedder status line for the digest block / status tool. */
  const embedderStatusText = () => {
    const want = current().embedding;
    if (want !== 'auto') return '';
    if (embedState === 'ready') return '';
    if (embedState === 'loading') return 'note: local embedding model is loading (first use downloads ~24MB to storages/hippo-memory/models). Until ready, recall uses the built-in hashing embedder.';
    if (embedState === 'failed') return 'note: embedding model unavailable — recall uses the built-in hashing embedder.';
    return '';
  };

  /** Lazily start loading the embedding model on first actual need (first
   *  digest render with embedding:auto). Deliberately NOT run at plugin boot:
   *  importing @xenova/transformers pulls sharp/libvips native libs that slow
   *  `dsh web` startup and print GLib warnings. First load logs one info line
   *  and the digest shows a loading note until ready. */
  let embedderKicked = false;
  const kickEmbedder = () => {
    if (embedderKicked) return;
    if (current().embedding !== 'auto') return;
    embedderKicked = true;
    void applyStoreSettings();
  };

  /** Read-path guarantee: when embedding:auto, ensure the model is ready (or
   *  has failed fast) before a query runs, so tools never silently query the
   *  model-vector store with the hashing embedder. Bounded wait: first use may
   *  download ~24MB; after the timeout the query falls back to hashing (older
   *  rows stay reachable only after the model is up — the digest note says so). */
  const embedderReadyForQuery = async () => {
    if (current().embedding !== 'auto') return;
    if (embedState === 'ready' || embedState === 'failed') return;
    kickEmbedder();
    if (embedState === 'ready' || embedState === 'failed') return;
    // Model is loading (possibly downloading). Wait up to ~90s, polling.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if (embedState === 'ready' || embedState === 'failed') return;
    }
  };

  const invalidateDigest = (agentKey) => {
    const cached = digestCache.get(agentKey);
    if (cached) {
      cached.cue = '';
      cached.digest = '';
    }
  };

  const setEnabled = (next) => {
    if (enabled === next) return;
    enabled = next;
    for (const dispose of disposers.splice(0)) dispose();
    if (enabled) installRuntime();
  };

  /* ---------------- runtime surface install/uninstall ---------------- */

  const registerTools = () => {
    const reg = (tool) => {
      const d = t.register(tool);
      if (typeof d === 'function') disposers.push(d);
    };
    reg(defineTool({
      name: 'memory_remember',
      description: 'Write a durable fact / event / skill into long-term memory. Re-stating the same fact strengthens it; a changed value for the same subject becomes a versioned override (old revision archived, never silently lost).',
      parameters: {
        kind: { type: 'string', required: true, enum: ['episode', 'semantic', 'procedure'], description: 'episode = one event; semantic = durable rule/fact; procedure = skill/workflow.' },
        summary: { type: 'string', required: true, description: 'One-sentence memory. For semantic claims prefer "<subject> -> <value>".' },
        detail: { type: 'string', description: 'Verbatim detail kept for deep recall.' },
        entities: { type: 'array', items: { type: 'string' }, description: 'Entity names (filter + conflict scope).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags.' },
        occurred_at: { type: 'string', description: 'ISO time of the real-world event, if any.' },
        source: { type: 'string', description: "Provenance: 'user' | 'tool' | 'config' | 'inference' | ..." },
        confidence: { type: 'string', enum: ['high', 'medium', 'low', 'speculative'], description: 'Writer confidence (default high).' }
      },
      output: outputOf(),
      async execute(args, exec) {
        const agentKey = sanitize(agentIdOf(exec));
        const store = storeFor(agentKey);
        const res = await store.remember({
          kind: args.kind,
          summary: args.summary,
          detail: args.detail,
          entities: (args.entities ?? []).map((e) => ({ name: e })),
          tags: args.tags,
          occurredAt: args.occurred_at,
          source: args.source ?? 'agent',
          confidence: args.confidence ?? 'high'
        });
        invalidateDigest(agentKey);
        return cleanJson({ ok: true, outcome: res.outcome, id: res.memory.id, version: res.memory.version, summary: res.memory.summary });
      },
      presentCall: (args) => present('Remember', 'write', args.summary)
    }));

    reg(defineTool({
      name: 'memory_recall',
      description: 'Retrieve memories matching a question (cue-driven recall). Use before answering anything that depends on facts from earlier in the session or past sessions. Every hit carries provenance (source/confidence/version/time) and conflict warnings flag newer revisions of the same subject.',
      parameters: {
        query: { type: 'string', required: true, description: 'The question / retrieval cue, natural language.' },
        entities: { type: 'array', items: { type: 'string' }, description: 'Restrict to memories about these entities.' },
        kind: { type: 'string', enum: ['episode', 'semantic', 'procedure'], description: 'Restrict to one kind.' },
        limit: { type: 'number', description: 'Max hits (default 5, max 10).' }
      },
      output: outputOf(),
      async execute(args, exec) {
        await embedderReadyForQuery();
        const store = storeFor(sanitize(agentIdOf(exec)));
        const res = await store.recall(
          { query: args.query, entities: args.entities, kind: args.kind },
          Math.min(args.limit ?? 5, 10)
        );
        return cleanJson({
          hits: res.hits.map((h) => ({
            id: h.id,
            version: h.version,
            kind: h.kind,
            summary: h.summary,
            confidence: h.confidence,
            source: h.source,
            occurredAt: h.occurredAt,
            score: Number(h.score.toFixed(3)),
            consolidated: h.consolidated
          })),
          warnings: res.warnings,
          scanned: res.scanned
        });
      },
      presentCall: (args) => present('Recall', 'read', args.query)
    }));

    reg(defineTool({
      name: 'memory_verify',
      description: 'Source-monitoring check for a factual claim: SUBSTANTIATED (memory supports it), CONTRADICTED (memory holds the opposite / a newer revision), or UNSUBSTANTIATED (no memory). Call BEFORE asserting remembered facts. Never assert an unsubstantiated claim as fact — answer "not in my memory" instead.',
      parameters: {
        claim: { type: 'string', required: true, description: 'The claim you intend to assert.' }
      },
      output: outputOf(),
      async execute(args, exec) {
        await embedderReadyForQuery();
        const store = storeFor(sanitize(agentIdOf(exec)));
        const v = await store.sourceMonitor(args.claim);
        return cleanJson({
          substantiated: v.substantiated,
          contradicted: v.contradicted,
          support: v.support ?? null,
          contradiction: v.contradiction ?? null,
          closest: v.closest ?? null,
          note: v.note
        });
      },
      presentCall: (args) => present('Verify claim', 'check', args.claim)
    }));

    reg(defineTool({
      name: 'memory_maintain',
      description: 'Long-term memory housekeeping. consolidate: abstract well-established episodes into durable semantic rules. forget: decay / soft-delete weak traces (preview with dry_run). stats: store summary. list: newest-first inventory of active memories. history: show revision history of one memory id. delete: permanently remove a memory by id. status: embedder/plugin state.',
      parameters: {
        action: { type: 'string', required: true, enum: ['consolidate', 'forget', 'stats', 'list', 'history', 'delete', 'status'], description: 'Which maintenance action to run.' },
        id: { type: 'string', description: 'Memory id (history/delete action).' },
        dry_run: { type: 'boolean', description: 'forget: preview without mutating (default true).' },
        limit: { type: 'number', description: 'list: max entries (default 50).' }
      },
      output: outputOf(),
      async execute(args, exec) {
        const store = storeFor(sanitize(agentIdOf(exec)));
        if (args.action === 'consolidate') {
          const made = await store.consolidate();
          return { consolidated: made.length, rules: made.map((x) => x.summary) };
        }
        if (args.action === 'forget') {
          const res = store.forget({ dryRun: args.dry_run !== false });
          return cleanJson({ wouldForget: res.forgotten.length, decayed: res.decayed.length });
        }
        if (args.action === 'stats') return cleanJson(store.stats());
        if (args.action === 'list') {
          const items = store.list(Math.min(args.limit ?? 50, 500));
          return cleanJson({
            count: items.length,
            memories: items.map((m) => ({
              id: m.id,
              version: m.version,
              kind: m.kind,
              summary: m.summary,
              source: m.source,
              confidence: m.confidence,
              updatedAt: m.updatedAt ?? m.occurredAt ?? null,
              consolidated: !!m.consolidated
            }))
          });
        }
        if (args.action === 'history') {
          if (!args.id) return { error: 'history requires an id' };
          return cleanJson({ history: store.history(args.id) });
        }
        if (args.action === 'delete') {
          if (!args.id) return { error: 'delete requires an id' };
          try {
            store.delete(args.id);
            invalidateDigest(sanitize(agentIdOf(exec)));
            return cleanJson({ ok: true, deleted: args.id });
          } catch (err) {
            return cleanJson({ ok: false, error: err?.message ?? String(err) });
          }
        }
        if (args.action === 'status') {
          return cleanJson({
            embeddingSetting: current().embedding,
            embedderState: embedState, // off | loading | ready | failed
            dim: embedProvider?.dim ?? null,
            embedderNote: embedderStatusText(),
            storeStats: store.stats()
          });
        }
        return { error: `unknown action ${args.action}` };
      },
      presentCall: (args) => present('Maintain memory', 'other', args.action)
    }));
  };

  const installRuntime = () => {
    // guidance section
    disposers.push(sp.section({ name: 'plugin:hippo-memory', order: 2450, text: GUIDANCE }));

    // digest context contribution (sync read of freshest cached digest)
    disposers.push(sp.context({
      name: 'hippo-memory:digest',
      order: 8000,
      text: (context) => {
        const agent = context?.agent;
        if (!agent) return '';
        const key = sanitize(agent.id);
        const inst = storeFor(key);
        // First render with embedding:auto lazily starts the model load (not at
        // plugin boot, so `dsh web` startup stays fast and GLib-clean).
        kickEmbedder();
        const cue = latestUserCue(agent.session);
        refreshDigest(key, cue.slice(0, 800));
        const cached = digestCache.get(key);
        const digest = cached?.digest ?? '';
        const note = embedderStatusText();
        const parts = [];
        if (note) parts.push(note);
        if (digest) {
          // Fresh or stale digest — show it; the refresh above is computing
          // the current cue's result when stale.
          parts.push(digest);
          // B: end-of-turn self-check — attached whenever memory content is
          // shown (fresh or stale), so agents are nudged without nagging.
          parts.push('(if this turn produced a durable conclusion not yet stored, write it with memory_remember)');
        } else {
          // No computed digest yet (async lag on first renders) — never render
          // an empty block: give a stable one-line fallback (cheap, no query).
          const s = inst.stats();
          parts.push(s.active > 0
            ? `(${s.active} memories stored; relevant ones will appear here once recalled)`
            : '(memory store empty — durable conclusions will be written as you work)');
        }
        return parts.length ? `[hippo-memory digest]\n${parts.join('\n')}` : '';
      }
    }));

    // tools
    registerTools();
  };

  const applyRuntime = () => {
    if (enabled && disposers.length === 0) installRuntime();
  };

  if (enabled) {
    installRuntime();
    // Deliberately NO embedding warm-up here: importing @xenova/transformers
    // at boot pulls sharp/libvips native libraries that slow `dsh web` startup
    // and print GLib-GObject warnings. The model loads lazily on first digest
    // render (kickEmbedder) or when the user flips the setting to auto.
  }

  // dispose on unload
  ctx.effect?.(
    () => () => {
      for (const dispose of disposers.splice(0)) dispose();
      for (const e of stores.values()) {
        try {
          e.inst.close();
        } catch {
          /* already closed */
        }
      }
      stores.clear();
      digestCache.clear();
    },
    'hippo-memory: dispose'
  );
}

export { Config, GUIDANCE, SETTINGS_NS, SettingsSchema, apply, inject, name };
