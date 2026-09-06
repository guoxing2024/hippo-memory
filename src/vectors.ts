/**
 * Minimal local dense-vector utilities used by the memory store:
 * cosine similarity, top-k over rows, and a small deterministic hash
 * (FNV-1a 64-bit → float32) that supports the two-tier embedding design
 * (feature-hash bootstrapping until a real model is available, and a
 * lightweight bag-of-words sparse-like code for pattern separation).
 *
 * All math is dependency-free and runs in-process.
 */

export type Vector = number[];

export function dot(a: Vector, b: Vector): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

export function norm(a: Vector): number {
  return Math.sqrt(dot(a, a));
}

export function cosine(a: Vector, b: Vector): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

export function normalize(a: Vector): Vector {
  const n = norm(a);
  if (n === 0) return a.slice();
  return a.map((x) => x / n);
}

/** l2 distance (used by clustering / dedupe). */
export function l2(a: Vector, b: Vector): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return Math.sqrt(s);
}

export function topKByScore<T>(items: T[], score: (t: T) => number, k: number): T[] {
  return items
    .map((t) => ({ t, s: score(t) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.t);
}

export function argmax<T>(items: T[], score: (t: T) => number): T | undefined {
  let best: T | undefined;
  let bestS = -Infinity;
  for (const it of items) {
    const s = score(it);
    if (s > bestS) {
      bestS = s;
      best = it;
    }
  }
  return best;
}

/** Mean vector of a non-empty list (used for centroid logic). */
export function centroid(vectors: Vector[]): Vector {
  const n = vectors.length;
  if (n === 0) return [];
  const dim = vectors[0]!.length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i]! += v[i]!;
  }
  return out.map((x) => x / n);
}

/* ------------------------------------------------------------------ */
/* Deterministic feature hashing (FNV-1a 64-bit)                        */
/* ------------------------------------------------------------------ */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

function fnv1a64(str: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    const code = str.codePointAt(i)!;
    h ^= BigInt(code);
    h = (h * FNV_PRIME) & 0xffffffffffffffffn;
  }
  return h;
}

function hashToFloat(h: bigint): number {
  // Map the 64-bit hash to a float in [-1, 1) deterministically.
  const mask = 0x7fffffffffffffffn;
  const positive = h & mask;
  const sign = (h >> 63n) & 1n;
  const unit = Number(positive) / Number(0x7fffffffffffffffn); // [0,1)
  return sign === 1n ? -unit : unit;
}

/** Tokenize a text into lowercase alphanumeric tokens (unicode aware). */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => t.trim());
}

export interface FeatureHashingOptions {
  /** Vector dimensionality (the "projection width"). */
  dim?: number;
  /** Whether to normalize the output vector to unit length. */
  normalize?: boolean;
}

/**
 * Hashing-trick bag-of-words encoder. Feature = token, and each token is
 * hashed onto a single dimension (signed). Deterministic, fast, no deps.
 *
 * This is the "bootstrapping" tier: a real embedding model (via the
 * EmbeddingProvider hook) is expected to replace it for semantic recall;
 * hash vectors still work, they just have weaker synonym handling.
 */
export function embedHashing(text: string, opts: FeatureHashingOptions = {}): Vector {
  const dim = opts.dim ?? 512;
  const vec = new Array<number>(dim).fill(0);
  for (const tok of tokenize(text)) {
    // Bigram context helps a little with ordering: token and token-pairs.
    const h1 = fnv1a64(tok);
    const idx = Number(h1 % BigInt(dim));
    vec[idx]! += hashToFloat(h1) >= 0 ? 1 : -1;
  }
  const tokens = tokenize(text);
  for (let i = 1; i < tokens.length; i++) {
    const pair = tokens[i - 1] + ' ' + tokens[i]!;
    const h2 = fnv1a64('#' + pair);
    vec[Number(h2 % BigInt(dim))]! += 0.5 * (hashToFloat(h2) >= 0 ? 1 : -1);
  }
  return opts.normalize === false ? vec : normalize(vec);
}
