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
let pruneEmptyStores;
let sanitizeMemoryText;
let looksInjected;
try {
  ({ HippoMemory } = await import('hippo-memory-core'));
  ({ pruneEmptyStores } = await import('hippo-memory-core'));
  ({ sanitizeMemoryText, looksInjected } = await import('hippo-memory-core'));
} catch {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = pathToFileURL(join(here, '..', '..', '..', 'dist', 'index.js')).href;
  ({ HippoMemory } = await import(src));
  ({ pruneEmptyStores } = await import(src));
  ({ sanitizeMemoryText, looksInjected } = await import(src));
}
// Older hoisted core (published 0.1.6) predates the guard module: degrade to
// identity functions so the adapter still works against it.
if (typeof sanitizeMemoryText !== 'function') sanitizeMemoryText = (t) => String(t ?? '');
if (typeof looksInjected !== 'function') looksInjected = () => false;

const name = 'hippo-memory';
const inject = ['systemPrompt', 'tools', 'settings'];

/** Settings namespace owned by this plugin (the key its GUI card edits). */
const SETTINGS_NS = 'hippo-memory';
/** Composition schema of the settings section; the user layer overrides it. */
const SettingsSchema = z.object({
  enabled: z.boolean().default(true),
  contextLimit: z.number().min(1).max(20).default(6),
  sharedStore: z.boolean().default(false),
  /**
   * Embedder choice. Default 'auto': the built-in hashing embedder has no
   * synonym ability (an audit flagged the old 'off' default as the single
   * biggest cause of false "not in my memory" answers — CJK paraphrase recall
   * was near zero), so semantic recall is the default and 'off' is the opt-out
   * for constrained environments. 'auto' lazily loads a local
   * bge-small-zh-v1.5 (~24MB, cached under storages/hippo-memory/models) and
   * falls back to hashing if loading fails.
   */
  embedding: z.union(['off', 'auto']).default('auto'),
  /** recall similarity floor; lower = more lenient recall, higher = stricter. Leave unset for engine default (0.32). */
  similarityThreshold: z.number().min(0.05).max(0.95).required(false)
});
/** Plugin Config (patch-row layer) — same shape; installed as section base. */
const Config = SettingsSchema;

const GUIDANCE = `## Long-term memory (hippocampus-inspired)

You have an explicit long-term memory store. Follow this discipline instead of relying on the raw transcript for old facts:

1. WRITE — after learning a durable fact or finishing a meaningful event, call memory_remember (kind: semantic = rules, episode = events, procedure = skills). Prefer a structured summary "<subject> -> <value>" so later corrections version cleanly instead of conflicting. When a fact holds only under conditions (population, comparator, release, environment, version), pass scope as "key=value; key=value" — the same sentence under a different scope is kept as its own trace instead of overwriting that one. Reach for scope whenever the same claim could be true in one setup and false in another: "latency -> 40ms" with scope "region=us-east; load=peak", "auth flow -> oauth" with scope "env=prod". Only state conditions you actually know — never invent a scope key to look precise; a fact with no real premise takes no scope.
2. RECALL — before answering anything that depends on facts from earlier in this session (or a past session), call memory_recall with the question as the query. If your question is itself premise-bound (a specific environment, region, release, dataset), pass that same scope so a fact stored under a different premise is filtered out instead of misread as the answer.
3. VERIFY — before asserting a remembered fact as current, call memory_verify with the claim and the scope you mean. Pass scope whenever the claim's truth depends on a premise you can name (env, region, version, population) — it makes the check answer OUT_OF_SCOPE instead of blessing a value stored under different conditions. Do not fabricate a scope you are not actually asking about. If it returns substantiated=false, answer "not in my memory / I don't know" — never confabulate. If contradicted, flag the conflict and use the newest revision. If out_of_scope, the stored answer is about different premises: do not carry it over.
4. MAINTAIN — in long sessions call memory_maintain so the store stays readable: status (one-line health, plus which store file actually answered), duplicates (read-only report of restatements; inside a group marked mixedPremises the rows stated under different premises are not restatements of each other), then merge on a group you confirmed — merge folds the extras into the survivor, they stay in the store and undemote restores them, while delete also destroys the version history. consolidate / forget as usual.
5. The [hippo-memory digest] runtime-context block (when present) lists memories retrieved automatically for the current task with provenance — treat them as retrieved evidence, never as license to invent more. A line tagged [low-confidence …] is the closest trace *below* the recall floor: a guess about what you may have meant, not a memory — verify before asserting it and never repeat it as stored fact. They may lag one step behind a memory_remember write; trust memory_verify for authoritative checks.`;

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

/**
 * Extract plain text from a session content value of unknown shape.
 * Real traffic carries block arrays (e.g. content: [text] or
 * [text, text, text]); older shapes carry bare strings or
 * {text|content} objects. Anything else yields '' (depth-capped).
 */
function textOf(v, depth = 0) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (depth > 3) return '';
    return v.map((e) => textOf(e, depth + 1)).filter(Boolean).join('\n');
  }
  if (v && typeof v === 'object' && depth <= 3) {
    return textOf(v.text ?? v.content ?? v.data?.content, depth + 1);
  }
  return '';
}

/**
 * Plugin origins whose nodes are prompt-engineering surface, never the human.
 * A cue drawn from these poisons recall with template boilerplate (field:
 * cue carried template 100% of turns). Matched by substring so versioned
 * package names keep hitting.
 */
const INJECTED_PLUGIN_MARKS = ['system-prompt'];

/** True when the node provably comes from prompt plumbing, not the human. */
function isInjectedNode(node) {
  const p = node?.source?.plugin ?? node?.plugin;
  return typeof p === 'string' && INJECTED_PLUGIN_MARKS.some((m) => p.includes(m));
}

/**
 * Strip our own digest block out of a cue (suggestion 2). Accumulator nodes
 * quote prior turns including [hippo-memory digest] … [/memory data]; feeding
 * that back into recall is a self-loop (field: 72.5% hit, 24.3% closed loop).
 * Belt-and-braces next to the node whitelist: any accumulator can smuggle one.
 */
function stripDigest(text) {
  return String(text ?? '')
    .replace(/\[hippo-memory digest\][\s\S]*?\[\/memory data\]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * Newest user-message text for digest recall. Three passes, newest-first:
 *  1. user node explicitly from the human plugin (or with no source info,
 *     the pre-source shape), not prompt plumbing, not template boilerplate;
 *  2. any user node neither provably injected nor boilerplate;
 *  3. newest user node text regardless (last resort — something beats
 *     nothing), then session title/goal/topic, else '' (caller uses the
 *     recency path).
 * Boilerplate = prompt-plumbing origin, or a long shared prefix with another
 * user node (templates repeat every turn; human messages don't share 64-char
 * prefixes). Text is read via textOf and digest-stripped before return.
 * Exported for unit tests.
 */
function latestUserCue(session) {
  try {
    const nodes = session?.surface?.nodes;
    if (nodes && Array.isArray(nodes)) {
      // Collect user-type nodes newest-first with stripped text.
      const cands = [];
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (node && typeof node === 'object' && node.type && node.type !== 'user/message') continue;
        const text = stripDigest(textOf(node)).trim();
        if (text) cands.push({ node, text });
      }
      // Template repeats across turns: flag long shared prefixes (R29:
      // template-led turns 100%, human-led 2.5%).
      const PREFIX = 64;
      const headed = (t) => t.length >= PREFIX;
      for (const c of cands) {
        c.boiler = headed(c.text) && cands.some((o) => o !== c && headed(o.text) &&
          (o.text.startsWith(c.text.slice(0, PREFIX)) || c.text.startsWith(o.text.slice(0, PREFIX))));
      }
      for (let pass = 1; pass <= 3; pass++) {
        for (const c of cands) {
          const plugin = c.node?.source?.plugin ?? c.node?.plugin;
          if (isInjectedNode(c.node)) continue; // prompt plumbing: never a cue
          if (pass === 1) {
            // Whitelist: explicit human origin, or no origin info at all
            // (pre-source shape) — and not boilerplate.
            if (c.boiler) continue;
            if (plugin != null && plugin !== 'user') continue;
          } else if (pass === 2) {
            if (c.boiler) continue;
          }
          return c.text.slice(0, 800);
        }
      }
    }
    for (const k of ['title', 'goal', 'topic']) {
      const v = session?.[k];
      if (typeof v === 'string' && v.trim()) return stripDigest(v).trim().slice(0, 800) || '';
    }
  } catch {
    /* non-conforming session shape */
  }
  return '';
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
    // Audit #0: semantic recall is the DEFAULT. The hashing embedder has no
    // synonym ability, and defaulting to it turned "I don't remember" into the
    // normal answer for paraphrased (especially CJK) questions. 'off' stays
    // available for constrained environments.
    embedding: config.embedding ?? 'auto',
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
        options: embedderOptions(),
        // Lazy open: a store that does not exist yet is held in memory, so
        // read-only traffic (digest renders, recall, list) cannot litter the
        // storages directory with empty files. The first write materializes it.
        createFile: false
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
      .composeContext(cue || '', { limit: current().contextLimit, includeRecent: true, recentLimit: 2 })
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
      description: 'Write a durable fact / event / skill into long-term memory. Re-stating the same fact strengthens it; a changed value for the same subject becomes a versioned override (old revision archived, never silently lost). The response echoes the nearest existing neighbours so you can see what the store already believed; pass supersedes to explicitly retire wrong ids. scope_only_matches lists same-subject-key rows withheld from overwrite for lack of a shared entity (empty means nothing to report, not a skipped check). outcome merge fires only when an episode restates a semantic rule with nothing new. Numeric assertion-shaped semantic claims (arrow/copula) without passing verify_* evidence are stored as episodes; a freshly VERIFIED incumbent is retired only by passing evidence (else both rows are kept with a shielded: warning). Tag a retraction with tags ["retraction"] plus retracts:<id>; tag prospective trigger/action pairs with tags ["guard"] plus guard_trigger/guard_action.',
      parameters: {
        kind: { type: 'string', required: true, enum: ['episode', 'semantic', 'procedure'], description: 'episode = one event; semantic = durable rule/fact; procedure = skill/workflow.' },
        summary: { type: 'string', required: true, description: 'One-sentence memory. For semantic claims prefer "<subject> -> <value>".' },
        detail: { type: 'string', description: 'Verbatim detail kept for deep recall.' },
        entities: { type: 'array', items: { type: 'string' }, description: 'Entity names (filter + conflict scope).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags. "retraction" marks a do-not-repeat marker (with retracts); "guard" marks a prospective trigger/action pair (with guard_trigger/guard_action).' },
        occurred_at: { type: 'string', description: 'ISO time of the real-world event, if any.' },
        source: { type: 'string', description: "Provenance: 'user' | 'tool' | 'config' | 'inference' | ..." },
        confidence: { type: 'string', enum: ['high', 'medium', 'low', 'speculative'], description: 'Writer confidence (default high).' },
        importance: { type: 'number', description: 'Salience 0..1 — how much this memory should matter for future retrieval/ranking. Omit to derive from confidence (high=0.7, medium=0.5, low=0.35, speculative=0.2). Set explicitly for durable user preferences (0.9+), project-critical facts (0.8+), or minor observations (<0.4).' },
        verify_cmd: { type: 'string', description: 'How to re-run this claim (command). The plugin never executes it; run it yourself and report via verify_result.' },
        verify_expect: { type: 'string', description: 'Expected re-run output.' },
        verify_artifact: { type: 'string', description: 'Artifact the re-run reads.' },
        verify_result: { type: 'string', enum: ['pass', 'fail'], description: 'Outcome of running verify_cmd (never self-assessed). Only passing evidence can retire a VERIFIED row.' },
        verified_at: { type: 'string', description: 'ISO time the evidence was executed.' },
        retracts: { type: 'string', description: 'Id this write retracts (use with tags ["retraction"]).' },
        guard_trigger: { type: 'string', description: 'Future situation this guards (use with tags ["guard"]).' },
        guard_action: { type: 'string', description: 'What to do when guard_trigger matches.' },
        supersedes: { type: 'array', items: { type: 'string' }, description: 'Ids of existing memories this write corrects/retires. Use when you verified a stored claim is wrong and are writing the replacement: the listed rows get superseded (kept for audit, excluded from recall), and verify/recall surface the newer conclusion instead.' },
        scope: { type: 'string', description: 'The conditions this statement holds under, as `key=value` segments separated by "; " — e.g. "population=all records; comparator=instruction start". Use it whenever the same sentence could be true under one setup and false under another: a write whose scope disagrees with an existing row becomes its own trace instead of merging into it, and memory_verify compares scopes and answers OUT_OF_SCOPE rather than blessing the wrong one.' }
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
          confidence: args.confidence ?? 'high',
          importance: typeof args.importance === 'number' && args.importance >= 0 && args.importance <= 1 ? args.importance : undefined,
          verify: args.verify_cmd || args.verify_expect || args.verify_artifact
            ? { cmd: args.verify_cmd, expect: args.verify_expect, artifact: args.verify_artifact }
            : undefined,
          verifyResult: args.verify_result === 'pass' || args.verify_result === 'fail' ? args.verify_result : undefined,
          verifiedAt: args.verified_at,
          retracts: args.retracts,
          guard: args.guard_trigger && args.guard_action ? { trigger: args.guard_trigger, action: args.guard_action } : undefined,
          supersedes: Array.isArray(args.supersedes) ? args.supersedes : undefined,
          scope: typeof args.scope === 'string' ? args.scope : undefined
        });
        invalidateDigest(agentKey);
        return cleanJson({
          ok: true,
          outcome: res.outcome,
          id: res.memory.id,
          version: res.memory.version,
          kind: res.memory.kind,
          summary: res.memory.summary,
          scope: res.memory.scope ?? null,
          // Carried evidence on the stored row: a re-tell that passes fresh
          // verify_result must surface it (field report scenario D: the proof
          // lived in storage but never reached the caller's return object).
          verify_result: res.memory.verifyResult ?? null,
          verified_at: res.memory.verifiedAt ?? null,
          // An override archives the previous revision instead of erasing it.
          // Say so explicitly: silent versioning reads as data loss.
          superseded: res.superseded
            ? {
                id: res.superseded.id,
                version: res.superseded.version,
                summary: res.superseded.summary,
                note: 'previous revision archived (recoverable via memory_maintain history with this id)'
              }
            : undefined,
          // Explicit correction edges applied by this write.
          superseded_traces: res.superseded_traces,
          // P0-2: nearest neighbours echoed back — what the store already
          // believed around this write, so a correction is never blind.
          neighbours: (res.neighbours ?? []).map((n) => ({
            id: n.id,
            kind: n.kind,
            summary: n.summary,
            confidence: n.confidence,
            version: n.version,
            similarity: Number(n.similarity.toFixed(3)),
            suspectedConflict: n.suspectedConflict
          })),
          suspected_conflict: res.suspected_conflict === true ? true : undefined,
          // An override retires an existing trace, so it is never silent
          // (field report BUG-1 (c)).
          warning: res.warning,
          // Same subject key but no shared entity: reported instead of
          // overwritten (field report BUG-1 (a)/(b)).
          scope_only_matches: res.scope_only_matches ?? []
        });
      },presentCall: (args) => present('Remember', 'write', args.summary)
    }));

    reg(defineTool({
      name: 'memory_recall',
      description: 'Retrieve memories matching a question (cue-driven recall). Use before answering anything that depends on facts from earlier in the session or past sessions. Every hit carries provenance (source/confidence/version/time) and conflict warnings flag newer revisions of the same subject.',
      parameters: {
        query: { type: 'string', required: true, description: 'The question / retrieval cue, natural language.' },
        entities: { type: 'array', items: { type: 'string' }, description: 'Restrict to memories about these entities.' },
        kind: { type: 'string', enum: ['episode', 'semantic', 'procedure'], description: 'Restrict to one kind.' },
        limit: { type: 'number', description: 'Max hits (default 8, max 20).' },
        include_demoted: { type: 'boolean', description: 'Also surface compress-folded rows (default false: their invariant covers them).' },
        scope: { type: 'string', description: 'The premise your question is bound to, as `key=value; key=value`. Rows whose stated scope disagrees are excluded entirely, so a fact stored under a different premise (another env/region/release) is filtered out instead of misread as the answer.' }
      },
      output: outputOf(),
      async execute(args, exec) {
        await embedderReadyForQuery();
        const store = storeFor(sanitize(agentIdOf(exec)));
        const res = await store.recall(
          { query: args.query, entities: args.entities, kind: args.kind, includeDemoted: args.include_demoted === true, scope: typeof args.scope === 'string' ? args.scope : undefined },
          Math.min(args.limit ?? 8, 20)
        );
        return cleanJson({
          hits: res.hits.map((h) => ({
            id: h.id,
            version: h.version,
            kind: h.kind,
            summary: h.summary,
            detail: h.detail ?? null,
            scope: h.scope ?? null,
            entities: h.entities ?? [],
            tags: h.tags ?? [],
            confidence: h.confidence,
            source: h.source,
            occurredAt: h.occurredAt,
            verify: h.verify ?? null,
            verify_result: h.verifyResult ?? null,
            verified_at: h.verifiedAt ?? null,
            guard: h.guard ?? null,
            retracts: h.retracts ?? null,
            retracted: h.retracted ?? null,
            recent: h.recent === true ? true : undefined,
            demoted: h.demoted === true ? true : undefined,
            score: Number(h.score.toFixed(3)),
            similarity: Number(h.similarity.toFixed(3)),
            relativeScore: h.relativeScore,
            literalMatch: h.literalMatch,
            consolidated: h.consolidated
          })),
          warnings: res.warnings,
          scanned: res.scanned,
          // Explain an empty result instead of leaving the caller guessing.
          reason: res.reason,
          eligible: res.eligible,
          bestSimilarity: res.bestSimilarity,
          threshold: res.threshold,
          nearMisses: res.nearMisses,
          // How many rows the scope hard-filter dropped (only present when a
          // scope was passed). >0 confirms premise filtering actually ran.
          scopeExcluded: res.scopeExcluded,
          // Non-conflicting overlap with the top hit (newer/older siblings on
          // the same topic). Kept OUT of warnings on purpose: a warning must
          // mean "check before asserting", so temporal neighbours live here.
          nearDuplicates: res.nearDuplicates ?? []
        });
      },
      presentCall: (args) => present('Recall', 'read', args.query)
    }));

    reg(defineTool({
      name: 'memory_verify',
      description: 'Source-monitoring check for a factual claim: SUBSTANTIATED (memory supports it), CONTRADICTED (memory holds the opposite / a newer revision), OUT_OF_SCOPE (the closest trace holds under premises your `scope` argument disagrees with), or UNSUBSTANTIATED (no memory). Call BEFORE asserting remembered facts. Never assert an unsubstantiated claim as fact — answer "not in my memory" instead.',
      parameters: {
        claim: { type: 'string', required: true, description: 'The claim you intend to assert.' },
        scope: { type: 'string', description: 'The conditions you are asking about, in the same `key=value; key=value` form memory_remember takes. Memory stated under a disagreeing scope is reported OUT_OF_SCOPE instead of substantiated, and the trace stated under YOUR premises is chosen as the support even when another row matches the wording more closely.' }
      },
      output: outputOf(),
      async execute(args, exec) {
        await embedderReadyForQuery();
        const store = storeFor(sanitize(agentIdOf(exec)));
        const v = await store.sourceMonitor(args.claim, { scope: typeof args.scope === 'string' ? args.scope : undefined });
        return cleanJson({
          substantiated: v.substantiated,
          contradicted: v.contradicted,
          out_of_scope: v.out_of_scope === true,
          support: v.support ?? null,
          contradiction: v.contradiction ?? null,
          closest: v.closest ?? null,
          contradicting: v.contradicting ?? [],
          newer_related: v.newer_related ?? [],
          superseded_matches: v.superseded_matches ?? [],
          stale_support: v.stale_support ?? false,
          contested: v.contested === true,
          note: v.note
        });
      },
      presentCall: (args) => present('Verify claim', 'check', args.claim)
    }));

    reg(defineTool({
      name: 'memory_maintain',
      description: 'Long-term memory housekeeping. consolidate: abstract well-established episodes into durable semantic rules. compress: fold N same-scope traces into 1 caller-authored invariant + K representatives (dry_run previews groups; apply with plan_json; undemote restores). merge: collapse the near-duplicate restatements a "duplicates" group reports into one live trace (dry_run previews which row survives; the rest stay live but hidden, undemote restores). forget: decay / soft-delete weak traces (preview with dry_run). stats: store summary. list: newest-first inventory of active memories. history: show revision history of one memory id. delete: permanently remove a memory by id. prune: delete store files that hold no memories. status: embedder/plugin state.',
      parameters: {
        action: { type: 'string', required: true, enum: ['consolidate', 'compress', 'undemote', 'forget', 'stats', 'list', 'history', 'delete', 'prune', 'duplicates', 'merge', 'override-audit', 'status'], description: 'Which maintenance action to run. "duplicates" reports near-duplicate restatements (read-only); a group is tagged mixedPremises:true when any two rows in it state incompatible premises. "merge" acts on ONE duplicates group: ids:[group ids] with dry_run (default) previews, dry_run:false retires the extras into the survivor. "override-audit" screens overridden rows whose archived text shares little with the live text — the signature of an unrelated memory retired by an override (read-only). "compress" with dry_run (default) proposes foldable groups; with dry_run:false plus plan_json it folds.' },
        id: { type: 'string', description: 'Memory id (history/delete action).' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Memory ids (undemote action; merge: the ids of ONE duplicates group).' },
        into: { type: 'string', description: 'merge: id to keep instead of the one the engine would pick (must be one of ids).' },
        dry_run: { type: 'boolean', description: 'forget/compress/merge: preview without mutating (default true).' },
        limit: { type: 'number', description: 'list: max entries (default 50).' },
        plan_json: { type: 'string', description: 'compress apply: JSON-encoded {invariant:{summary,detail?,entities?},members:[ids],representatives:[ids]} (engine validates, never authors the invariant).' }
      },
      output: outputOf(),
      async execute(args, exec) {
        const store = storeFor(sanitize(agentIdOf(exec)));
        if (args.action === 'consolidate') {
          const made = await store.consolidate();
          return { consolidated: made.length, rules: made.map((x) => x.summary) };
        }
        if (args.action === 'compress') {
          if (args.dry_run !== false) {
            const groups = store.proposeCompressions();
            return cleanJson({
              groupCount: groups.length,
              groups,
              note: 'preview only — author each invariant and pass dry_run:false plus plan_json to fold (engine validates, never authors)'
            });
          }
          let plan;
          try {
            plan = JSON.parse(String(args.plan_json ?? ''));
          } catch {
            return { ok: false, error: 'compress apply requires plan_json (JSON object or array of objects)' };
          }
          try {
            const plans = Array.isArray(plan) ? plan : [plan];
            const applied = [];
            for (const p of plans) applied.push(await store.compress(p));
            invalidateDigest(sanitize(agentIdOf(exec)));
            return cleanJson({ ok: true, applied });
          } catch (err) {
            return cleanJson({ ok: false, error: err?.message ?? String(err) });
          }
        }
        if (args.action === 'undemote') {
          const res = store.undemote(Array.isArray(args.ids) ? args.ids : []);
          invalidateDigest(sanitize(agentIdOf(exec)));
          return cleanJson({ restored: res.restored });
        }
        if (args.action === 'forget') {
          const preview = args.dry_run !== false;
          const res = store.forget({ dryRun: preview });
          return cleanJson(preview
            ? { wouldForget: res.forgotten.length, decayed: res.decayed.length, note: 'preview only — pass dry_run:false to apply' }
            : { forgotten: res.forgotten, decayed: res.decayed });
        }
        if (args.action === 'stats') return cleanJson(store.stats());
        if (args.action === 'list') {
          const items = store.list(Math.min(args.limit ?? 50, 500));
          const infected = items.filter((m) => looksInjected(m.summary));
          return cleanJson({
            count: items.length,
            memories: items.map((m) => ({
              id: m.id,
              version: m.version,
              kind: m.kind,
              summary: sanitizeMemoryText(m.summary),
              detail: m.detail ? sanitizeMemoryText(m.detail) : null,
              scope: m.scope ? sanitizeMemoryText(m.scope) : null,
              entities: m.entities ?? [],
              tags: m.tags ?? [],
              source: sanitizeMemoryText(m.source),
              confidence: m.confidence,
              verify_result: m.verifyResult ?? null,
              verified_at: m.verifiedAt ?? null,
              retracts: m.retracts ?? null,
              demoted: !!m.demoted,
              updatedAt: m.updatedAt ?? m.occurredAt ?? null,
              consolidated: !!m.consolidated
            })),
            ...(infected.length
              ? { injectionWarnings: [`${infected.length} stored memor${infected.length === 1 ? 'y' : 'ies'} contain instruction-shaped text (${infected.map((m) => m.id).join(', ')}) — review with action "history", consider action "delete"`] }
              : {})
          });
        }
        if (args.action === 'history') {
          if (!args.id) return { error: 'history requires an id' };
          return cleanJson({ history: store.history(args.id).map((h) => ({ ...h, summary: sanitizeMemoryText(h.summary), detail: h.detail ? sanitizeMemoryText(h.detail) : null, scope: h.scope ? sanitizeMemoryText(h.scope) : null, verify_result: h.verifyResult ?? null })) });
        }
        if (args.action === 'prune') {
          // Sweep store files that hold no memories and no history — the
          // residue of read-only agent stores created before lazy opening.
          const dbDir = join(dshHome(), 'storages', 'hippo-memory');
          const live = new Set(stores.keys());
          const removed = pruneEmptyStores
            ? pruneEmptyStores(dbDir, { minAgeMs: 0, skip: live })
            : [];
          return cleanJson({ pruned: removed.length, files: removed });
        }
        if (args.action === 'override-audit') {
          // Read-only screen for the damaging case duplicates() cannot see: an
          // override archives the old row, so no live pair remains to compare.
          const res = store.overrideAudit({ limit: args.limit ?? 50 });
          return cleanJson({
            scannedOverridden: res.scannedOverridden,
            suspiciousCount: res.suspicious.length,
            suspicious: res.suspicious.map((x) => ({
              ...x,
              liveSummary: sanitizeMemoryText(x.liveSummary),
              archived: { ...x.archived, summary: sanitizeMemoryText(x.archived.summary) }
            })),
            note: res.note
          });
        }
        if (args.action === 'merge') {
          // Act on one group from the `duplicates` report. Default is a preview,
          // like compress: the caller should see which row survives before any
          // of them is retired.
          const ids = Array.isArray(args.ids) ? args.ids : [];
          if (ids.length < 2) return cleanJson({ ok: false, error: 'merge requires ids: the ids of one duplicates group (2 or more)' });
          try {
            const res = await store.mergeDuplicates({
              ids,
              into: typeof args.into === 'string' ? args.into : undefined,
              dryRun: args.dry_run !== false
            });
            if (args.dry_run === false && res.retired.length) invalidateDigest(sanitize(agentIdOf(exec)));
            return cleanJson({
              ok: true,
              dry_run: res.dryRun === true,
              survivor: res.survivor ?? null,
              retired: res.retired,
              carried: res.carried,
              blocked: res.blocked,
              note: res.note
            });
          } catch (err) {
            return cleanJson({ ok: false, error: err?.message ?? String(err) });
          }
        }
        if (args.action === 'duplicates') {
          // Read-only report: near-duplicate restatements (e.g. an episode and
          // the "FACT: …" rule abstracted from it). Nothing is deleted here.
          const res = store.duplicates();
          return cleanJson({
            scanned: res.scanned,
            groupCount: res.groups.length,
            duplicateMemories: res.groups.reduce((n, g) => n + g.memories.length - 1, 0),
            groups: res.groups.map((g) => ({
              ...g,
              memories: g.memories.map((m) => ({
                ...m,
                summary: sanitizeMemoryText(m.summary),
                scope: m.scope ? sanitizeMemoryText(m.scope) : null
              }))
            })),
            note: res.groups.length
              ? 'review, then merge a group with action "merge" (extras stay live but hidden; reversible with "undemote"), ' +
              'or remove ids with action "delete" (history is removed with the row). In a group marked mixedPremises:true ' +
              'the rows that state different premises are not restatements of each other: merge leaves them in blocked[] ' +
              'and still folds the rest of the group.'
              : 'no near-duplicate restatements found'
          });
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
          const diag = store.diagnostics();
          return cleanJson({
            embeddingSetting: current().embedding,
            embedderState: embedState, // off | loading | ready | failed
            dim: embedProvider?.dim ?? null,
            embedderNote: embedderStatusText(),
            storeStats: store.stats(),
            path_rule: current().sharedStore
              ? 'sharedStore is on: every agent id reads and writes one shared store file.'
              : 'one store file per agent id under storages/hippo-memory; a fact remembered by another agent is ' +
                'not visible here (set sharedStore to true to merge them).',
            // P0-3: deep observability — the silent killer is an embedder
            // mismatch (model-vector store queried by the hashing fallback:
            // garbage cosines, zero hits, nothing in the counts looks wrong).
            diagnostics: diag,
            health: diag.suspicious.emptyWhileSiblingsFull
              ? // Per-agent stores make this the most common non-bug: the fact was
                // remembered, just not by this agent. Say so before anything else.
                'WARN: this store is empty while a sibling file in the same directory holds memories — ' +
                'per DSH every agent id has its own store, so the write went to another agent (see diagnostics.sibling_stores)'
              : diag.suspicious.possibleEmbedderMismatch
              ? 'WARN: stored vector dims do not match the active embedder — recall is likely broken for this store (re-migrate or check embedder setting)'
              : diag.suspicious.neverAccessedRatio > 0.8 && diag.activity.totalAccess > 0
                ? 'WARN: most memories were never recalled — check cue phrasing / thresholds'
                : 'ok'
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
          // the current cue's result when stale. composeContext already
          // sanitized each line and wrapped the block in a data frame
          // (memory text is quoted data, never instructions).
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

    // Housekeeping: sweep empty store files left by earlier versions (read-only
    // access used to create one file per agent). Deferred and fully guarded so
    // it can never delay or break boot.
    setTimeout(() => {
      try {
        if (!pruneEmptyStores) return;
        const removed = pruneEmptyStores(join(dshHome(), 'storages', 'hippo-memory'), {
          minAgeMs: 60_000,
          skip: stores.keys()
        });
        if (removed.length) ctx.logger?.info?.(`hippo-memory: pruned ${removed.length} empty store file(s)`);
      } catch {
        /* housekeeping only */
      }
    }, 5000).unref?.();
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

export { Config, GUIDANCE, SETTINGS_NS, SettingsSchema, apply, inject, latestUserCue, name };
