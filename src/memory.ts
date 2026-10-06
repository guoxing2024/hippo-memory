/**
 * Hippocampus-inspired memory store (v2).
 *
 * The class mirrors the hippocampus → cortex division of labor:
 *
 *   remember()        ~ DG sparse binding + CA3 pattern separation:
 *                      near-duplicate → strengthen; near-contradiction on the
 *                      same event/entity scope → versioned override (old
 *                      revision archived, never silently lost); otherwise a
 *                      new sparse trace.
 *   recall()          ~ cue-driven pattern completion with a single scan of
 *                      the store; results annotated with provenance and
 *                      conflict warnings (a "source monitoring" affordance).
 *   consolidate()     ~ systems consolidation: well-established episodic
 *                      traces are abstracted into durable semantic rules.
 *   forget()          ~ adaptive forgetting: Ebbinghaus-style decay of weak
 *                      traces and soft-deletion of long-idle ones.
 *   sourceMonitor()   ~ prefrontal stand-in: substantiated / unsubstantiated /
 *                      contradicted verdicts so the agent can say "I don't
 *                      know" instead of confabulating.
 *   composeContext()  ~ working-memory gate: pick the few traces that matter
 *                      for the current goal, not the whole history.
 *
 * Storage is SQLite (node:sqlite) with an in-process vector tier — zero
 * external services. Embeddings are pluggable; without a provider we fall
 * back to a deterministic feature-hash bag-of-words encoder (enough for
 * tests/demos). All active rows live in one table: episode / semantic /
 * procedure are kinds of the same engram, versioned per id.
 */

import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  DEFAULT_OPTIONS,
  type CompressPlan,
  type CompressResult,
  type ConflictOutcome,
  type ConsolidationCandidate,
  type EmbeddingProvider,
  type MemoryKind,
  type MemoryPayload,
  type RecallBundle,
  type RelatedTrace,
  type RetrievedMemory,
  type RetrievalCue,
  type StoredMemory,
  type StoreOptions,
  type Summarizer,
  type WriteNeighbour,
  nowIso
} from './schema.js';
import { SCOPE_RULE, SqliteStore, surveyStores, vecFromBlob, vecToBlob, type MemoryRow, type StoreSurveyEntry } from './sqlite.js';
import { cosine, embedHashing, tokenize } from './vectors.js';
import { dataFrame, rangeCheck, sanitizeMemoryText } from './guard.js';

function tagList(tagsJson: string): string[] {
  try {
    return (JSON.parse(tagsJson || '[]') as string[]).map((t) => String(t).toLowerCase());
  } catch {
    return [];
  }
}

/** Marker/pattern rows never join compression groups (already condensed). */
function isCondensedRow(r: { tags_json: string }): boolean {
  const tags = tagList(r.tags_json);
  return tags.includes('retraction') || tags.includes('guard') || tags.includes('invariant');
}

function isRetractionRow(r: { tags_json: string }): boolean {
  return tagList(r.tags_json).includes('retraction');
}

/**
 * Evidence freshness (S2保鲜期): passing evidence counts as VERIFIED only
 * inside its TTL. A missing timestamp is stale by definition (unproven
 * freshness); a `fail` never counts. Stale rows render [ASSERTED] and lose
 * the retirement shield — re-run the check to refresh verifiedAt.
 */
function evidenceFresh(
  result: string | null | undefined,
  verifiedAt: string | null | undefined,
  nowMs: number,
  ttlSec: number
): boolean {
  if (result !== 'pass' || !verifiedAt) return false;
  const at = Date.parse(verifiedAt);
  if (!Number.isFinite(at) || at > nowMs) return false;
  return nowMs - at <= Math.max(0, ttlSec) * 1000;
}

/**
 * Evidence standing (audit #5): the engine never executes verify.cmd, so a
 * reported pass has two trust tiers. `attested` = the caller demonstrably ran
 * a reproducible check (full shield + plain [VERIFIED]); `self-reported` =
 * an honest agent assertion (renders [VERIFIED self-reported], shield
 * degraded to a warning). Anything else is not evidence.
 */
function evidenceStanding(row: {
  verify_result: string | null | undefined;
  verified_at: string | null | undefined;
  verify_attested?: number | null;
}, nowMs: number, ttlSec: number): 'attested' | 'self-reported' | 'none' {
  if (!evidenceFresh(row.verify_result, row.verified_at, nowMs, ttlSec)) return 'none';
  return row.verify_attested === 1 ? 'attested' : 'self-reported';
}

/**
 * Fillers that carry no value information when comparing claim values.
 * NOTE: the article "a" is deliberately NOT a filler here. claimParts lowercases
 * values, so an enumerator label ("cluster A" vs "cluster B") arrives as "cluster
 * a" / "cluster b" — dropping "a" made {cluster} a subset of {cluster,b} and the
 * clash read as a refinement (field report: single-letter values never
 * contradicted). Keeping "a" is safe because a genuine article refinement
 * ("a postgres" vs "postgres") is still caught by the containment test, and the
 * copula parser already strips a leading "a/an/the" before this comparison.
 */
const VALUE_FILLER = new Set(['and', 'or', 'with', 'the', 'an', 'of', 'to', 'in', 'on', 'for', 'at', 'by', 'as', 'per']);

/** Terms of a claim value (latin/digit runs whole, CJK per run), fillers dropped. */
function rawTokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9._+-]*|[一-鿿]+/g) ?? []).filter((t) => !VALUE_FILLER.has(t)));
}

/** Terms of a claim value, stemmed for comparison (R9). */
function valueTokens(s: string): Set<string> {
  return new Set([...rawTokens(s)].map(stemToken));
}

/**
 * Inflectional stem for comparison only (field report round 8): `run`/`runs`
 * and `lane`/`lanes` read as two values without it — one lands WEAK_MATCH via
 * the belt, the other CONTRADICTED — although neither moved the value. Only
 * pure-letter tokens longer than three characters are touched, so every
 * three-letter value the R7b floor admitted (`aws`, `red`, `hot`) and every
 * filler is byte-identical before and after. The strip is purely formal, so it
 * also joins pairs that are two values, not two spellings of one
 * (`https`/`http` and kin, field report round 9) — those are suppressed by
 * pair key in `NO_MERGE_PAIRS` below, which restores the clash instead of
 * merging. Deliberately inflectional, not derivational:
 * `app`/`application` (abbreviation) and `deploys`/`deployed` (voice, whose
 * `ed` side is left alone) stay out — the first is synonymy, the second its
 * own open item, and reaching for either reopens the lexicon direction.
 */
function stemToken(t: string): string {
  if (!/^[a-z]+$/.test(t) || t.length <= 3) return t;
  if (/(sses|xes|zzes|ches|shes)$/.test(t)) return t.slice(0, -2);
  if (/ies$/.test(t)) return t.slice(0, -3) + 'y';
  if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

/**
 * Pairs the stemmer must not merge (field report round 9): each pair is two
 * values, not two spellings of one — the trailing-`s` strip joins them, so
 * the merge is suppressed for exactly these pairs. Keyed by pair (sorted,
 * lowercased), consulted only to *restore* a clash the stem would hide: a hit
 * can only ever downgrade (belt) or refute (the parsed-value route, i.e. prev
 * behavior), never certify, and a miss is today's behavior. `ws`/`wss` is
 * deliberately absent — the 3-letter floor owns it, not the stem (ROADMAP).
 */
const NO_MERGE_PAIRS = new Set(
  (
    [
      ['https', 'http'],
      ['ftps', 'ftp'],
      ['smtps', 'smtp'],
      ['imaps', 'imap'],
      ['ldaps', 'ldap'],
      ['amqps', 'amqp'],
      ['news', 'new'],
    ] as [string, string][]
  ).map(([x, y]) => (x < y ? `${x} ${y}` : `${y} ${x}`)),
);

/** A listed collision pair split across the two sides restores the clash. */
function unmergedPair(a: string, b: string): boolean {
  const ra = rawTokens(a);
  const rb = rawTokens(b);
  if (ra.size === 0 || rb.size === 0) return false;
  for (const x of ra) {
    if (rb.has(x)) continue;
    for (const y of rb) {
      if (ra.has(y)) continue;
      if (NO_MERGE_PAIRS.has(x < y ? `${x} ${y}` : `${y} ${x}`)) return true;
    }
  }
  return false;
}

/**
 * Do two claim values actually disagree? (audit #7, refined)
 *
 * The first cut compared raw strings, so a dropped connective ("uses github
 * actions **and** caches node_modules" vs "…uses github actions caches
 * node_modules") read as a value flip and manufactured CONTRADICTED verdicts
 * on ordinary paraphrase (caught by memory.test's supported-claim case).
 * Comparison is now token-based, mirrored on the scope-premise rule: one side
 * containing the other is a refinement (`postgres` vs `postgres 15`), and
 * values sharing half their terms or more are restatements, not disagreements.
 * Only a real clash (postgres vs mysql, slow vs fast) fires.
 */
function valueClash(a: string, b: string): boolean {
  if (a === b) return false;
  if (unmergedPair(a, b)) return true;
  const sa = valueTokens(a);
  const sb = valueTokens(b);
  if (sa.size === 0 || sb.size === 0) return false; // nothing to compare
  const smaller = sa.size <= sb.size ? sa : sb;
  const larger = smaller === sa ? sb : sa;
  if ([...smaller].every((t) => larger.has(t))) return false; // containment = refinement
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union > 0 && inter / union < 0.5;
}

/** Characters two texts agree on before they diverge (both already normalized). */
function sharedPrefix(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/** How much real text a shared prefix carries — spaces prove nothing. */
function contentChars(s: string): number {
  return s.replace(/\s+/g, '').length;
}

/**
 * The connective a one-sided tail inherits from the OTHER side's phrasing —
 * `…副本数 是 99` / `…副本数 配置为 99` against a row written `…副本数 -> 3`.
 * Leaving it in the tail made `是` part of the value, so a claim that dropped a
 * clause ("300 秒" against "300 秒，最多 3 个分片") lost the containment test that
 * marks a refinement and was read as a clash. The stub before the connective is
 * bounded: the value must be what the sentence turns on, not the whole tail.
 */
const TAIL_COPULA_RE = /^\D{0,8}?(?:是|为|等于|系|->|=>|[:=：])\s*/;

/**
 * The value a text binds to an already-parsed subject, for the case where the
 * parser read only ONE side. `claimParts` understands `主体 -> 值` and a table of
 * English copulas; a Chinese claim ("…副本数是 99") against a stored arrow row
 * ("…副本数 -> 3") parsed to null on the claim side, so the value comparison that
 * protects the `主体 -> 值` contract was unreachable and the claim fell through to
 * an anchor that similarity alone can satisfy (field report R1). Reading the
 * subject out of the parse and taking whatever follows it in the other text
 * keeps the comparison alive without teaching every prose path a Chinese
 * copula table — a wrong split here can only ever downgrade a verdict.
 */
function tailForSubject(normalized: string, subject: string): string | null {
  if (subject.length < 3) return null;
  // Start of the text only: `which cluster was the deploy target before` names
  // the subject too, and what follows it there is a question, not a value.
  if (!normalized.startsWith(subject)) return null;
  const tail = normalized.slice(subject.length).replace(TAIL_COPULA_RE, '').trim();
  return tail ? tail : null;
}

/**
 * A quantity stated on its own — `90 秒`, `-> 3`, `4GB` — with the number read as
 * the value, not as a fragment of an identifier (`KAPPA-1`, `beta-2222`,
 * `v1.2.0`). The stub before it stays short because the shape being looked for
 * is "same wording, then the value": a number buried at the end of a long
 * remainder is some other fact in a sentence that merely starts the same way.
 *
 * Sticky, not `^`-anchored: the number is looked for at the point where the two
 * texts diverge, so the lookbehind still sees the character that precedes it
 * there. Matching a slice instead cut `kappa-` off `KAPPA-1 record` and let the
 * ticket number through as a value — the guard could no longer tell a divergence
 * inside an identifier from one after a word (field report R3).
 */
const LEADING_QUANTITY_RE = /\D{0,12}?(?<![-\w.])(\d+(?:\.\d+)*)(?![\d.])/y;

/** The quantity a text states at `at`, where two wordings stopped agreeing. */
function quantityAt(text: string, at: number): string | undefined {
  return quantitySpan(text, at)?.value;
}

/**
 * The quantity a text states at `at`, plus where its digits begin. The veto's
 * quantity exemption needs the span BETWEEN the swap and the number, not just
 * the number — `m.index` is `at` (sticky), so the digits start after the stub.
 */
function quantitySpan(text: string, at: number): { value: string; start: number } | null {
  LEADING_QUANTITY_RE.lastIndex = at;
  const m = LEADING_QUANTITY_RE.exec(text);
  if (!m?.[1]) return null;
  return { value: m[1], start: m.index + m[0].length - m[1].length };
}

/**
 * Words that join a separate constituent — `zone alpha and 30 slots` states
 * a zone name AND a slot count, two parameters in one sentence. A number past
 * one of these is another clause's value, not phrasing of the swapped word, so
 * it must not trigger the quantity exemption (field reports R7a, #64).
 * Checked on the whole span from the swap word to the digits: tokenizing
 * splits on whitespace, so a boundary comma glues itself onto the swap token
 * (`bravo,`), and only a span check sees it — checking past the token missed
 * exactly that (`.hippo/r7-price-hash.txt`, comma row). A match strictly
 * inside the swap word's own letters cannot fire: every entry needs a
 * separator on both sides, and the single-character class names only clause
 * punctuation. The set has two halves: coordinators (R7a) and thirteen
 * prepositions (#64 census: 16/24 false yes → 1/24). `at` / `to` stay out —
 * items 61/63 pin verb-rewordings through them — and so does the ambiguous
 * `with`. The name is historical; the line is constituency, not word class.
 */
const COORDINATOR_RE = /(^|[\s,;])(and|or|for|in|on|by|from|near|per|under|over|of|upon|via|since)(?=[\s,;]|$)|[,;，、和与或]/;

/** Whether the span from `from` to `to` crosses a clause boundary. A span that
 * ends before it begins — the digits sit inside the swap word itself — crosses
 * nothing and keeps the old reading. */
function crossesCoordinator(text: string, from: number, to: number): boolean {
  return to > from && COORDINATOR_RE.test(text.slice(from, to));
}

/**
 * A value flip neither parser can see: two texts that agree word for word up to
 * a number that differs — `probeC-gateway 超时设定为 30 秒` vs `…设定为 90 秒`. This
 * needs no grammar and no language, only enough shared wording (4 content
 * characters) to be about the same subject, and both sides stating a number.
 */
function numberFlip(claimNorm: string, storedNorm: string): { subject: string; stored: string; claimed: string } | null {
  const prefix = sharedPrefix(claimNorm, storedNorm);
  if (contentChars(prefix) < 4) return null;
  const claimed = quantityAt(claimNorm, prefix.length);
  const stored = quantityAt(storedNorm, prefix.length);
  if (!claimed || !stored || claimed === stored) return null;
  return { subject: prefix.trim(), stored, claimed };
}

const CJK_CHAR_RE = /[一-鿿]/;

/**
 * What can stand in front of a swap without being anything the sentence is about:
 * the connectives, plus the article `a` that `VALUE_FILLER` deliberately leaves out.
 * That set compares VALUES, and dropping `a` from it is what lets a single-letter
 * enumerator value (`cluster a` vs `cluster b`) clash at all; a lone article in
 * FRONT of a divergence cannot be the subject, so the slot test needs it.
 */
const NO_SUBJECT_HEAD = new Set([...VALUE_FILLER, 'a']);

/** A run that can carry a value on its own, as opposed to a connective between words. */
function isValueWord(t: string): boolean {
  if (!t || VALUE_FILLER.has(t)) return false;
  // Two CJK characters say as much as three Latin ones. The Latin floor used to
  // be four, which made every three-letter value (`aws`, `red`, `hot`) invisible
  // to the belt while the similarities certifying them kept climbing (field
  // report R7b: `aws`→`gcp` certified in both spaces). At three, every one- and
  // two-letter word is still out along with every filler; what the newly admitted
  // three-letter verbs cost in over-blocking is measured on the short-word panel
  // (.hippo/probe-r7-price.mjs, 24 rows: R7a/R7b wants plus price watches), not assumed.
  return CJK_CHAR_RE.test(t) ? t.length >= 2 : t.length >= 3;
}

/**
 * The reading `numberFlip` makes, for values that are not numbers: two texts built
 * identically — same number of whitespace-separated runs, agreeing word for word
 * except at ONE position — where what differs is a value, not a connective.
 * Position is the entire test, which is what lets it see `staging` / `production`
 * (field report V1) that the eight-word copula table in `claimParts` cannot: no
 * verb list survives contact with real prose, and no wordlist of environment names
 * would either, because the same shape with a nonsense word in the slot was
 * certified just the same (.hippo/probe-position.mjs).
 *
 * Deliberately NOT wired into `valueFlip`, which hands out CONTRADICTED. A
 * predicate can hold of several values at once — `commit A fixes the leak` does not
 * refute `commit B fixes the leak` — so all this can honestly say is "not
 * evidence", which is the verdict the anchor gate's belt produces.
 *
 * The first cut of this required 4 content characters before the swap, and field
 * report V2a found the hole in it: `the primary handles writes` against `the
 * standby handles writes` was sailed through by a 3-character prefix. That bar
 * measured how far the divergence sat from the start of the sentence, which is not
 * a property of the divergence at all — dropping it low enough to catch that shape
 * would also newly over-block the `gto 内存上限设定为 4GB` rewrites, which today
 * escape only because their prefix happens to be three characters long. What
 * decides whether the trace still speaks to the claim is WHICH SLOT moved. Stripped
 * of connectives, the words before the swap are a subject, and `nginx proxies every
 * inbound request` against `haproxy proxies every inbound request` is two sentences
 * about different things rather than one thing carrying a new value. Both readings
 * veto the anchor; `subjectSwap` exists only so the note can say honestly what
 * moved instead of asserting a shared subject that isn't there.
 *
 * `tokenize` keeps a CJK run whole, so a reworded Chinese predicate arrives as one
 * differing token against an otherwise identical rest — which is exactly the shape
 * of a value swap (field report V2b). The exemption is not a language rule: when
 * both sides then state the SAME quantity at the divergence, the quantity is the
 * shared content and the words around it are phrasing. A differing quantity belongs
 * to `numberFlip`, not here. The boundary is `LEADING_QUANTITY_RE`'s forward budget of
 * 12 non-digits, counted FROM THE SWAP WORD ITSELF and required on both sides, so a
 * long value word spends the budget it is being read with: `capped near 30` (12) is
 * exempt, `capped since 30` (13) and `configured at 30` (14) keep their veto.
 *
 * The number must also sit in the swap's own clause: a coordinator (`and`, `or`,
 * a comma) between the swap word and the digits means the digits head another
 * conjunct — `zone alpha and 30 slots` is a zone name AND a slot count — so the
 * exemption does not fire however equal the numbers are (field report R7a).
 */
function wordFlip(
  claim: string,
  stored: string
): { stored: string; claimed: string; subjectSwap: boolean } | null {
  const claimNorm = normalizeText(stripAbstractPrefix(claim));
  const storedNorm = normalizeText(stripAbstractPrefix(stored));
  const a = claimNorm.split(' ');
  const b = storedNorm.split(' ');
  if (a.length !== b.length || a.length < 2) return null;
  const at = a.findIndex((t, i) => t !== b[i]);
  if (at < 0 || a.some((t, i) => i !== at && t !== b[i])) return null;
  const claimed = a[at]!;
  const storedWord = b[at]!;
  if (!isValueWord(claimed) || !isValueWord(storedWord)) return null;
  if (!valueClash(claimed, storedWord)) return null;
  // `normalizeText` collapsed every run to a single space, so the offset of the
  // swap is just the tokens before it, plus one space each.
  const claimFrom = offsetOfToken(a, at);
  const storedFrom = offsetOfToken(b, at);
  const statedClaim = quantitySpan(claimNorm, claimFrom);
  const statedStored = quantitySpan(storedNorm, storedFrom);
  // Same number, same clause: the quantity is the shared content and the swap is
  // phrasing. Past a coordinator the number belongs to another parameter, and in
  // doubt the veto stands — the belt can only ever downgrade.
  if (
    statedClaim && statedStored && statedClaim.value === statedStored.value &&
    !crossesCoordinator(claimNorm, claimFrom, statedClaim.start) &&
    !crossesCoordinator(storedNorm, storedFrom, statedStored.start)
  ) return null;
  // An empty prefix and an article-only one say the same thing: nothing that a
  // sentence could be ABOUT stands before the swap, so the slot that moved is the
  // subject. `a` counts as an article here even though it is not a VALUE filler.
  return { stored: storedWord, claimed, subjectSwap: b.slice(0, at).every((t) => NO_SUBJECT_HEAD.has(t)) };
}

/**
 * The swap `wordFlip` cannot see (field report #65): both sides parse to the
 * same subject with different value strings, but the values share no comparable
 * terms — one side is a connective filler (`flag is on`: `on` is in
 * `VALUE_FILLER`, so its token set is empty and `valueClash` stays silent).
 * That silence is correct on the refutation path, but the anchor gate must not
 * certify the pair on similarity either: the wording matches up to that one
 * word, so what it shares is the shape of the sentence, not the value.
 *
 * The round-12 widening: the shipped belt only covered the gap where comparison
 * is impossible (one side with nothing to compare). But a combination value
 * (`currently on` vs `currently off`, `on duty` vs `off duty`,
 * `with telemetry` vs `without telemetry`) keeps a comparable term on both
 * sides, so the belt bailed and `valueClash` read containment as refinement —
 * while the single differing slot is filler-vs-value, which is the swap, not
 * agreement. The belt therefore reads the full token sequence, not the
 * filtered set: one differing position where a connective stands against a
 * value word (or a lone filler against a lone filler) is the same slot the
 * shipped belt covered, with context around it.
 *
 * Two boundaries keep this from over-blocking. A refinement is not a swap: one
 * side saying more about the same state in the same words in a row (`on` vs
 * `on duty`, `a postgres` vs `postgres`) leaves by the subsequence exit — and
 * that exit is token-ordered on purpose, so `with` vs `without` is a swap, not
 * a prefix: raw-string containment is not token-safe. And when the swap joins
 * two connectives inside a longer value (`red and blue` vs `red or blue`) no
 * value moved, so the comparison routes keep it. Like every belt it can only
 * ever downgrade, never certify or refute.
 */
function fillerSwap(
  claim: string,
  stored: string
): { stored: string; claimed: string; positional: boolean } | null {
  const a = claimParts(normalizeText(stripAbstractPrefix(claim)));
  const b = claimParts(normalizeText(stripAbstractPrefix(stored)));
  if (!a || !b || a.subject !== b.subject || a.value === b.value) return null;
  const ta = seqTokens(a.value);
  const tb = seqTokens(b.value);
  if (ta.length === 0 || tb.length === 0) return null;
  if (isStrictSubseq(ta, tb) || isStrictSubseq(tb, ta)) return null;
  const at = ta.length === tb.length ? ta.findIndex((t, i) => t !== tb[i]) : -1;
  if (at >= 0 && ta.every((t, i) => i === at || t === tb[i])) {
    const xv = isValueWord(ta[at]!);
    const yv = isValueWord(tb[at]!);
    if (xv && yv) return null;
    if (!xv && !yv && ta.length > 1) return null;
    return { stored: b.value, claimed: a.value, positional: true };
  }
  // Different lengths or several swaps: comparison decides when it can (both
  // sides have comparable terms); the belt covers only the gap where one side
  // — or both — has nothing to compare.
  if (valueTokens(a.value).size > 0 && valueTokens(b.value).size > 0) return null;
  return { stored: b.value, claimed: a.value, positional: false };
}

/** Word runs of a value in order, fillers kept (cf. `rawTokens`, which drops them). */
function seqTokens(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9][a-z0-9._+-]*|[一-鿿]+/g) ?? [];
}

/**
 * Is `sub` a strict contiguous run inside `full`? A refinement says more about
 * the same state by adding words, never by swapping them — and contiguity is
 * load-bearing: without it a dropped middle word would read as agreement.
 */
function isStrictSubseq(sub: string[], full: string[]): boolean {
  if (sub.length === 0 || sub.length >= full.length) return false;
  outer: for (let i = 0; i + sub.length <= full.length; i++) {
    for (let j = 0; j < sub.length; j++) if (full[i + j] !== sub[j]) continue outer;
    return true;
  }
  return false;
}

/** Where token `at` begins in a text whose tokens came from splitting on single spaces. */
function offsetOfToken(tokens: string[], at: number): number {
  let n = 0;
  for (let i = 0; i < at; i++) n += tokens[i]!.length + 1;
  return n;
}

/**
 * Which value the claim and the closest trace disagree on, or null when they
 * agree, refine each other, or cannot be lined up at all. Three routes, in
 * descending confidence: both sides parse, one side parses and its subject is
 * found in the other, and neither parses but the wording matches up to a number.
 */
function valueFlip(
  claim: string,
  stored: string
): { subject: string; stored: string; claimed: string } | null {
  const claimNorm = normalizeText(stripAbstractPrefix(claim));
  const storedNorm = normalizeText(stripAbstractPrefix(stored));
  const a = claimParts(claim);
  const b = claimParts(stored);
  if (a && b) {
    if (a.subject === b.subject && valueClash(a.value, b.value)) return { subject: a.subject, stored: b.value, claimed: a.value };
    return null;
  }
  if (!a && b) {
    const tail = tailForSubject(claimNorm, b.subject);
    if (tail && valueClash(tail, b.value)) return { subject: b.subject, stored: b.value, claimed: tail };
    return null;
  }
  if (a && !b) {
    const tail = tailForSubject(storedNorm, a.subject);
    if (tail && valueClash(a.value, tail)) return { subject: a.subject, stored: tail, claimed: a.value };
    return null;
  }
  return numberFlip(claimNorm, storedNorm);
}

/**
 * Do these two texts talk about the same thing? Polarity is a statement ABOUT a
 * subject, so a contradiction verdict needs one (field report R2): the negation
 * branch used to compare polarities alone, and `NEGATION_RE`'s CJK arm matches
 * a single character, so any stored row containing 不 refuted every unrelated
 * negated claim that cleared the recall floor — `python is not a compiled
 * language` came back CONTRADICTED against a row about service restarts.
 * Structural evidence only, never prose similarity: an identifier, the same
 * wording up to the flip, a parsed subject named by the other side, or the
 * trace's own entity tag appearing in the claim.
 */
function polarityAnchored(claim: string, stored: string, entities: string[]): boolean {
  if (literalOverlap(claim, stored) > 0) return true;
  const claimNorm = normalizeText(stripAbstractPrefix(claim));
  const storedNorm = normalizeText(stripAbstractPrefix(stored));
  if (contentChars(sharedPrefix(claimNorm, storedNorm)) >= 4) return true;
  const a = claimParts(claim);
  const b = claimParts(stored);
  if (a && storedNorm.includes(a.subject)) return true;
  if (b && claimNorm.includes(b.subject)) return true;
  return entities.some((e) => typeof e === 'string' && e.length >= 3 && claimNorm.includes(e.toLowerCase()));
}

function rowToMemory(row: MemoryRow, withEmbedding: boolean): StoredMemory {
  const tags = JSON.parse(row.tags_json) as string[];
  return {
    id: row.id,
    version: row.version,
    kind: row.kind,
    summary: row.summary,
    detail: row.detail ?? undefined,
    episode:
      row.episode_place || row.episode_time || row.participants_json
        ? {
            time: row.episode_time ?? undefined,
            place: row.episode_place ?? undefined,
            participants: row.participants_json ? (JSON.parse(row.participants_json) as string[]) : undefined
          }
        : undefined,
    semantic: row.rule ? { rule: row.rule } : undefined,
    entities: JSON.parse(row.entities_json) as string[],
    tags,
    // F4: one meaning for `consolidated` — the tag consolidate() wrote, read
    // back at the source so get/recall/list/digest/stats cannot disagree.
    consolidated: tags.includes('consolidated'),
    occurredAt: row.occurred_at ?? undefined,
    source: row.source ?? undefined,
    verify: row.verify_json ? (JSON.parse(row.verify_json) as { cmd?: string; expect?: string; artifact?: string }) : undefined,
    verifyResult: row.verify_result === 'pass' || row.verify_result === 'fail' ? row.verify_result : undefined,
    verifyAttested: row.verify_attested === 1 ? true : undefined,
    verifiedAt: row.verified_at ?? undefined,
    scope: row.scope ?? undefined,
    retracts: row.retracts ?? undefined,
    guard: row.guard_json ? (JSON.parse(row.guard_json) as { trigger: string; action: string }) : undefined,
    demoted: row.demoted === 1,
    demotedTo: row.demoted_to ?? undefined,
    confidence: row.confidence,
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessAt: row.last_access_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    superseded: row.superseded === 1,
    supersededBy: row.superseded_by ?? undefined,
    embedding: withEmbedding ? (vecFromBlob(row.vec) ?? undefined) : undefined
  };
}

// `no(?!-)` so hyphenated compounds ("no-code", "no-op") are not read as a
// negation. `错误\d+` requires a digit: a bare "错误处理" (error handling) is a
// topic, not a correction — only markers like "错误1" / "错误2" count.
const NEGATION_RE = /\b(not|never|no longer|doesn'?t|isn'?t|aren'?t|no(?!-)|none|dislike|reject|deny|stopped|quit)\b|[不没未非](?![a-z0-9])|((?:与|和|跟|同)[^，。,]{0,12}(?:无关|无涉|独立|不同))|(?:推翻|否证|改口)(?:了|为)?|(?:否定|排除|更正)(?:了|为|:|：)|(错误\d+)/i;

export class HippoMemory {
  readonly db: SqliteStore;
  readonly options: Required<StoreOptions>;
  private embedder: EmbeddingProvider | null = null;
  /** Store file path (exposed via diagnostics for observability). */
  private readonly dbPath: string;
  /**
   * How often the working-memory gate stayed quiet. Counted in memory, per
   * process: a persisted counter would read like history, and the question it
   * answers ("did recall fire on this session?") is about the live process.
   */
  private readonly digestCoverage = { turns: 0, misses: 0, guesses: 0 };
  /** LLM consolidation hook (audit #4); template path is the fallback. */
  private summarizer: Summarizer | null = null;

  /**
   * @param opts.createFile  false = open lazily: a store whose file does not
   *                         exist yet is held in memory until the first write
   *                         (default true, the historical eager behaviour).
   * @param opts.summarizer  LLM abstraction hook used by consolidate()
   *                         (falls back to the FACT:-template on absence or
   *                         error — consolidation never fails the store).
   */
  constructor(opts: { dbPath: string; options?: StoreOptions; createFile?: boolean; summarizer?: Summarizer }) {
    this.db = new SqliteStore(opts.dbPath, { create: opts.createFile !== false });
    this.options = { ...DEFAULT_OPTIONS, ...opts.options };
    this.dbPath = opts.dbPath;
    this.summarizer = opts.summarizer ?? null;
  }

  /** Attach (or replace) a real embedding provider. */
  setEmbedder(e: EmbeddingProvider): void {
    this.embedder = e;
  }

  /** Attach (or replace) the LLM consolidation hook. */
  setSummarizer(s: Summarizer | null): void {
    this.summarizer = s;
  }

  /**
   * One-shot migration to the attached embedder. Uses a persisted marker
   * (PRAGMA user_version) so it runs at most once per store: re-embeds every
   * active row with the current embedder and records the migration.
   * @returns number of rows re-embedded (0 = nothing to do / already done).
   */
  async ensureEmbeddingMigration(): Promise<number> {
    if (!this.embedder) return 0;
    if (this.db.marker() >= 1) return 0;
    const rows = this.db.allActive();
    if (rows.length === 0) {
      // Nothing to migrate. Skip the marker write for a store that has not
      // materialized yet — writing it would create an empty file on disk,
      // which is exactly what lazy opening exists to avoid. A later real
      // write re-runs this check and records the marker then.
      if (!this.db.isLazy()) this.db.setMarker(1);
      return 0;
    }
    const texts = rows.map((r) => {
      const entities = JSON.parse(r.entities_json || '[]') as string[];
      const guardBits: string[] = [];
      try {
        const g = r.guard_json ? (JSON.parse(r.guard_json) as { trigger?: string; action?: string }) : null;
        if (g?.trigger) guardBits.push(g.trigger);
        if (g?.action) guardBits.push(g.action);
      } catch {
        /* malformed guard JSON embeds as empty */
      }
      return [r.summary, r.detail ?? '', r.episode_place ?? '', r.rule ?? '', ...guardBits, r.scope ?? '', ...entities].join('\n');
    });
    const vecs = await this.embedder.embed(texts);
    const now = nowIso();
    let n = 0;
    for (let i = 0; i < rows.length; i++) {
      const v = vecs[i];
      const row = rows[i];
      if (!v || v.length === 0 || !row) continue;
      this.db.update({
        id: row.id,
        version: row.version,
        kind: row.kind,
        summary: row.summary,
        detail: row.detail,
        episode_time: row.episode_time,
        episode_place: row.episode_place,
        participants_json: row.participants_json,
        rule: row.rule,
        entities_json: row.entities_json,
        tags_json: row.tags_json,
        occurred_at: row.occurred_at,
        source: row.source,
        verify_json: row.verify_json,
        verify_result: row.verify_result,
        verified_at: row.verified_at,
        verify_attested: row.verify_attested ?? 0,
        retracts: row.retracts,
        guard_json: row.guard_json,
        scope: row.scope ?? null,
        demoted: row.demoted,
        demoted_to: row.demoted_to,
        demoted_at: row.demoted_at,
        confidence: row.confidence,
        importance: row.importance,
        access_count: row.access_count,
        last_access_at: row.last_access_at,
        created_at: row.created_at,
        updated_at: now,
        superseded: row.superseded,
        superseded_by: row.superseded_by,
        vec: vecToBlob(v)
      });
      n++;
    }
    this.db.setMarker(1);
    return n;
  }

  get embedDim(): number {
    return this.embedder?.dim ?? 512;
  }

  private async embedOne(text: string): Promise<number[]> {
    if (this.embedder) {
      try {
        const [v] = await this.embedder.embed([text]);
        if (v && v.length > 0) return v;
      } catch {
        /* fall through to the local encoder */
      }
    }
    return embedHashing(text);
  }

  /** Same-event test used by conflict resolution (a 1 h window). */
  private sameEventWindowMs(payload: MemoryPayload, row: MemoryRow): boolean {
    const a = payload.occurredAt;
    const b = row.occurred_at;
    if (!a || !b) return true; // unstated time ⇒ assume the current report
    return Math.abs(Date.parse(a) - Date.parse(b)) <= 60 * 60 * 1000;
  }

  private entityNames(p: MemoryPayload): string[] {
    // Tolerant of plain strings (direct-DB callers) as well as EntityRef
    // objects (the documented contract, what the adapter sends) — update()
    // already normalises both shapes, the write path should not TypeError.
    const names = (p.entities ?? [])
      .map((e) => (typeof e === 'string' ? e : e.name).trim())
      .filter(Boolean);
    return Array.from(new Set(names.map((n) => n.toLowerCase())));
  }

  /* ============================ write path ============================ */

  /**
   * Hippocampal write. Resolution order:
   *   1. near-duplicate of the same kind        → strengthen (no new trace)
   *   2. cross-kind verbatim restatement        → merge into the semantic
   *      (ONLY when an episode restates a semantic rule with nothing new:
   *      same normalized body after stripping the consolidation "FACT: "
   *      wrapper, same verbatim detail, same entity set; kind pair
   *      episode→semantic. No cosine gate — exact identity outranks any
   *      similarity score. Same-kind restatements rehearse via branch 1
   *      instead; same-subject value changes override via branch 0/3 — merge
   *      never fires for those shapes.)
   *   3. near-contradiction on the same event/entity scope (same kind)
   *                                            → versioned override (archive old)
   *   4. otherwise                             → new sparse trace
   */
  async remember(payload: MemoryPayload): Promise<{
    outcome: ConflictOutcome;
    memory: StoredMemory;
    superseded?: { id: string; version: number; summary: string };
    /** Explicit supersedes edges applied by this write (id + what it said). */
    superseded_traces?: { id: string; summary: string }[];
    /**
     * Rows that matched this write's structured-claim subject key but share
     * no entity, so they were NOT overwritten. Reported instead of silently
     * retired (field report BUG-1: unrelated memories were being replaced).
     *
     * Scope note (field report BUG-D): this is NOT "all blocked
     * candidates" — only same-subject-key rows stopped by the entity gate.
     * Unstructured summaries have no subject key, so this is empty for them
     * even when neighbours exist. Always present (possibly empty) on every
     * outcome; an empty array means "the gate had nothing to report", not
     * "the gate did not run".
     */
    scope_only_matches?: { id: string; summary: string; similarity: number; reason: string }[];
    /** Human-readable notice when this write retired an existing trace. */
    warning?: string;
    /** Top nearest neighbours of the written content (echoed for the caller). */
    neighbours?: WriteNeighbour[];
    /** True when a neighbour plausibly asserts the opposite of this write. */
    suspected_conflict?: boolean;
  }> {
    const summary = payload.summary.trim();
    if (!summary) throw new Error('remember: summary is required');

    const entities = this.entityNames(payload);
    const tags = Array.from(new Set((payload.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)));
    const isRetraction = tags.includes('retraction');
    // Evidence downgrade (suggestion 1, narrowed per R29): a numeric claim in
    // ASSERTION shape (arrow or copula — "X -> 1.5", "cache is 512 MB")
    // is stored as a semantic rule regardless of verification status. The
    // verification status affects rendering (e.g. [VERIFIED] vs [ASSERTED])
    // and the strength of the retirement shield, but does NOT prevent the
    // row from being corrected by a newer value for the same subject.
    // Bare prose that merely mentions numbers ("release 2.1 shipped
    // Tuesday") is NOT a value assertion and keeps its declared kind.
    let kind = payload.kind;
    let downgraded: string | undefined;
    if (kind === 'semantic' && /\d/.test(summary) && claimParts(summary)) {
      // Keep semantic regardless of verifyResult — do not let self-reported
      // "pass" prevent a later correction from overriding this value.
    }
    const guard = payload.guard && payload.guard.trigger?.trim() && payload.guard.action?.trim()
      ? { trigger: payload.guard.trigger.trim(), action: payload.guard.action.trim() }
      : undefined;
    // Stated premises (see MemoryPayload.scope). Part of the encoding, so a
    // premise-aware query finds the row, and it gates the merge/override
    // branches so a same-sentence write under another premise is not folded
    // into the old one.
    const scope = typeof payload.scope === 'string' && payload.scope.trim() ? payload.scope.trim() : undefined;
    const contentText = [
      summary, payload.detail ?? '', payload.episode?.place ?? '', payload.episode?.time ?? '',
      payload.semantic?.rule ?? '', ...(guard ? [guard.trigger, guard.action] : []), ...(scope ? [scope] : []), ...entities
    ].join('\n');
    const vec = await this.embedOne(contentText);
    // Range priors (suggestion 3): warn-only, never block.
    const rangeNotes = rangeCheck(summary);
    // Advisory notes ride along on every outcome (downgrade, range); an
    // explicit override/blocked warning stays first when present.
    const pendingNotes: string[] = [];
    if (downgraded) pendingNotes.push(downgraded);
    for (const n of rangeNotes) pendingNotes.push(n);
    // Guard/tag consistency (R30 suggestion 6): the [GUARD] rendering and
    // trigger recall both need the guard OBJECT, not just the tag — a bare
    // tag looks configured while doing nothing. Either direction warns.
    if (tags.includes('guard') && !guard) {
      pendingNotes.push('guard-note: tags ["guard"] without guard_trigger/guard_action does nothing — pass both fields or drop the tag');
    }
    if (guard && !tags.includes('guard')) {
      pendingNotes.push('guard-note: guard_trigger/guard_action without tags ["guard"] will not boost or render [GUARD] — add the tag');
    }
    const withNotes = (...explicits: Array<string | undefined>): string | undefined => {
      const all = [...explicits.filter((e): e is string => !!e), ...pendingNotes];
      return all.length ? all.join(' ') : undefined;
    };
    // Evidence shield (suggestion 2): set when an unverified write meets a
    // VERIFIED incumbent — the write is kept as its own trace, never an
    // override. Explicit `supersedes` (fast path above) still states intent.
    let shielded: string | undefined;

    const confidence = payload.confidence ?? 'high';
    const importance = clamp01(payload.importance ?? importanceFromConfidence(confidence));
    const now = nowIso();
    const nowMs = Date.parse(now);
    // Freshness stamp (保鲜期): passing evidence reported without a time is
    // taken as "just run" — the report arrives with the write. An explicit
    // old stamp keeps its age (and goes stale past the TTL).
    const verifiedAt = payload.verifyResult === 'pass' ? (payload.verifiedAt ?? now) : payload.verifiedAt;

    // ---- pattern separation: scan existing traces ----
    // Demoted rows are folded detail: invisible to write-path decisions
    // (no rehearse/merge/override against them) unless explicitly named.
    const candidates = this.db
      .allActive()
      .filter((r) => r.demoted !== 1)
      .map((r) => {
        const b = vecFromBlob(r.vec);
        return { r, sim: b && b.length === vec.length ? cosine(b, vec) : 0 };
      });

    const sameKind = candidates.filter((x) => x.r.kind === kind).sort((a, b) => b.sim - a.sim);
    const closest = sameKind[0];

    // P0-2: echo the top-3 nearest neighbours back to the caller. The scan
    // already computes these similarities; returning them costs nothing and
    // closes the "wrote a correction, never saw the old trace" blind spot.
    const newNegated = this.polarityOf(summary);
    const newClaim = claimParts(summary);
    // Rows that matched the structured-claim subject key but share no entity:
    // reported back, never overwritten (see the scope guard at branch 0).
    const scopeOnlyMatches: { id: string; summary: string; similarity: number; reason: string }[] = [];
    // Premise clash (scope field): rows this write must NOT fold into, because
    // they state a different condition — a shared key holding another value, or
    // an unkeyed premise naming another condition. Keeps the skip visible
    // instead of silent (same rule as the entity gate above).
    const premiseClash = (rowScope: string | null | undefined): string[] => scopeDifferences(scope, rowScope);
    const premiseSkipped: { id: string; summary: string; keys: string[] }[] = [];
    const notePremiseSkip = (r: MemoryRow, keys: string[]): void => {
      // Several write branches can reject the same incumbent in one pass (a
      // structured claim fails the entity gate, then the verbatim scan sees the
      // same row). Naming it twice would read as two blocked rows.
      const seen = premiseSkipped.find((p) => p.id === r.id);
      if (seen) seen.keys = Array.from(new Set([...seen.keys, ...keys]));
      else premiseSkipped.push({ id: r.id, summary: sanitizeMemoryText(r.summary).slice(0, 60), keys });
    };
    // G4 (round 28): a re-tell that SUPPLIES the premise the incumbent never stated is
    // not a missing field to complete — it is a narrowing. `scope` decides whom a row
    // speaks for: a premise-free row answers every caller (premiseFill used to be read as
    // "补注条件", a kindness to the row), a keyed row answers one. Writing the caller's
    // premise onto a premise-free row therefore takes a general statement out of the
    // store, and it did so inside three rehearsal branches while returning `none` (twice)
    // or `merge` — a state change reported as nothing happening. Measured on the installed
    // bytes: 4 of 7 shapes narrowed this way and all 4 lost read coverage
    // (`.hippo/probe-g4b-round28.txt`: verify under an unrelated premise went
    // substantiated → OUT_OF_SCOPE across the write). The only thing that separated the
    // destroyed row from a surviving pair was whether the caller re-typed the sentence
    // verbatim, which is a wording accident, not a semantic rule.
    //
    // So the criterion is refused rather than filled, at ALL FOUR sites, by one
    // predicate: G3's lesson is that a rule wired to one of its sites leaks at the others.
    // The fourth is the similarity-driven override arm (`brink`, path-3): G4 wired the
    // three rehearsal branches, R1 (round 30) hoisted the refusal above the same-value
    // check in path-0, and re-running the reporter's OWN reproduction on that build
    // (`.hippo/repro-r1r2r3-round30b-postfix.txt`) showed the write sliding past the keyed
    // arm into path-3 and retiring the same premise-free row there (content-sim 0.90 +
    // claim-sim 0.95). Three of four doors is the same leak G3 named, one door later.
    // An intentional narrowing stays available — `supersedes:[id]`, or `update(id, {scope})`,
    // which increments the version and archives the premise it replaced.
    const narrowsPremiseFree = (rowScope: string | null | undefined): boolean => !rowScope && !!scope;
    const premiseNarrowed: { id: string; summary: string }[] = [];
    const notePremiseNarrow = (r: MemoryRow): void => {
      if (!premiseNarrowed.some((p) => p.id === r.id)) {
        premiseNarrowed.push({ id: r.id, summary: sanitizeMemoryText(r.summary).slice(0, 60) });
      }
    };

    const neighbours: WriteNeighbour[] = candidates
      .slice()
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 3)
      .map(({ r, sim }) => {
        // Conflict suspicion is deliberately WIDE — three triggers, any one
        // suffices (field feedback: the polarity-only check fired only when
        // entities happened to match AND negation wording was used):
        //   (1) opposite polarity on a similar-enough neighbour
        //   (2) the neighbour shares an entity with this write (same scope)
        //   (3) structured "<subject> -> value" with the SAME subject
        //       (a value flip on a known subject — the strongest signal)
        // A false positive costs one review glance; a false negative costs a
        // stale "fact" being asserted forever. Asymmetry favours flagging.
        // Rehearsal guard: a neighbour that says the SAME thing (identical
        // normalized text, or same structured claim with the same value) is
        // not a conflict. Without this the entity channel would flag every
        // benign re-tell of a fact that shares an entity.
        const rClaim = claimParts(r.summary);
        const isRehearsal =
          isVerbatimRestatement(r.summary, summary) ||
          !!(newClaim && rClaim && rClaim.subject === newClaim.subject && rClaim.value === newClaim.value);
        const sameSubject = !!(newClaim && rClaim && rClaim.subject === newClaim.subject && rClaim.value !== newClaim.value);
        const sharedEntity = entities.length > 0 && this.entitiesOverlap(entities, JSON.parse(r.entities_json || '[]') as string[]);
        return {
          id: r.id,
          kind: r.kind,
          summary: sanitizeMemoryText(r.summary),
          confidence: r.confidence,
          version: r.version,
          updatedAt: r.updated_at,
          similarity: sim,
          suspectedConflict:
            !isRehearsal &&
            ((sim >= this.options.similarityThreshold && this.polarityOf(r.summary) !== newNegated) ||
              (sim >= this.options.similarityThreshold && sharedEntity) ||
              sameSubject)
        };
      });
    const suspectedConflict = neighbours.some((n) => n.suspectedConflict);

    // Explicit supersedes edges come FIRST: when the caller names the rows this
    // write retires, we never route into override/merge — the new trace is the
    // point, and the named rows get superseded_by pointers to it. (Otherwise a
    // same-subject arrow claim would be eaten by the override branch before
    // the explicit edges were ever applied — observed in the P0-1 test.)
    const supersedesIds = (payload.supersedes ?? []).map((x) => x.trim()).filter(Boolean);
    if (supersedesIds.length > 0) {
      const id = randomUUID();
      const row = this.buildRow({
        id,
        version: 1,
        kind,
        summary,
        detail: payload.detail,
        episode: payload.episode,
        semantic: payload.semantic,
        entities,
        tags,
        occurredAt: payload.occurredAt ?? (kind === 'episode' ? now : undefined),
        source: payload.source,
        verify: payload.verify,
        verifyResult: payload.verifyResult,
        verifyAttested: payload.verifyAttested,
        verifiedAt: verifiedAt,
        retracts: payload.retracts,
        guard,
        scope,
        confidence,
        importance,
        createdAt: now,
        updatedAt: now,
        vec
      });
      this.db.transaction(() => {
        this.db.insert(row);
        for (const sid of supersedesIds) {
          const t = this.db.getById(sid);
          if (!t || t.superseded === 1) continue;
          this.db.setSuperseded(sid, id);
        }
      });
      const supersededTraces = supersedesIds
        .map((sid) => this.db.getById(sid))
        .filter((t): t is MemoryRow => !!t && t.superseded === 1)
        .map((t) => ({ id: t.id, summary: sanitizeMemoryText(t.summary) }));
      return {
        outcome: 'supersede',
        memory: rowToMemory(row, false),
        superseded_traces: supersededTraces,
        neighbours,
        scope_only_matches: scopeOnlyMatches,
        ...(withNotes() ? { warning: withNotes() as string } : {}),
        ...(suspectedConflict ? { suspected_conflict: true } : {})
      };
    }

    // 0. structured claim ("<subject> -> <value>") → attribute binding.
    //    The same subject is ONE engram: same value = rehearsal; a different
    //    value = correction (reconsolidation → versioned override).
    //
    //    Scope guard (field report BUG-1): a subject match alone MUST NOT
    //    authorise an overwrite. `claimParts` derives a "subject" from ordinary
    //    prose too ("the meeting room booking is handled two days ahead" →
    //    subject "the meeting room booking"), so two unrelated sentences that
    //    share a noun phrase produce the same key. Without a scope check this
    //    branch silently retired unrelated memories at ANY cosine — including
    //    pairs the 0.86 contradiction bar would have rejected (reported at
    //    0.783/0.843) — and the only trace was the returned `superseded` field.
    //    Now an overwrite additionally requires shared entities, or an explicit
    //    `supersedes` list (handled in the fast path above, which states intent
    //    outright). Otherwise the write is a NEW trace and the overlap is
    //    reported as a near-duplicate instead of destroying anything.
    //
    //    Known ceiling: rows that declare no entities cannot match on scope, so
    //    a value flip between two entity-less rows stays a new trace (with a
    //    `not-overridden:` warning, field report STAR — the silence was the
    //    bug, not the gate). The gate itself is deliberate (BUG-1 (b)): "no
    //    entities declared" must never count as shared scope.
    if (newClaim && !isRetraction) {
      for (const { r } of sameKind) {
        // Retraction rows are markers, never override incumbents.
        if (isRetractionRow(r)) continue;
        const oldClaim = claimParts(r.summary);
        if (!oldClaim || oldClaim.subject !== newClaim.subject) continue;
        const clash = premiseClash(r.scope);
        if (clash.length) {
          notePremiseSkip(r, clash);
          continue;
        }
        const rowEntities = JSON.parse(r.entities_json || '[]') as string[];
        const scopeOk = entities.length > 0 && rowEntities.length > 0 && this.entitiesOverlap(entities, rowEntities);
        const rowSim = candidates.find((c) => c.r.id === r.id)?.sim ?? 0;
        if (!scopeOk) {
          // Same key, no shared scope: surface it, never overwrite it.
          scopeOnlyMatches.push({
            id: r.id,
            summary: sanitizeMemoryText(r.summary).slice(0, 80),
            similarity: Number(rowSim.toFixed(3)),
            reason: 'same-subject-key, no shared entity'
          });
          continue;
        }
        // G4 (round 28) refused the narrowing of a premise-free incumbent, and R1
        // (round 30) found the site it was missing: the refusal sat INSIDE the
        // same-value branch below, so a keyed write whose value DIFFERS reached the
        // `override` return without ever asking the question that protects the data.
        // The question is "does the row already on file declare a premise?" — not "are
        // the two writes verbatim identical". Measured on the installed bytes
        // (`.hippo/repro-r1r2r3-round30b.txt`, R1a, identical in both embedding spaces):
        // a premise-free "rate limit -> 1000 req/min" was retired by a `tenant=acme`
        // write of "rate limit -> 100 req/min" with no `premise-narrowing:` note, one
        // active row carrying a premise it never stated, and the general sentence
        // unreachable to every caller afterwards (OUT_OF_SCOPE under another tenant,
        // WEAK_MATCH under none). A value flip is the case that MOST needs both
        // readings kept: the general one and the conditioned one.
        //
        // An incumbent that DOES state a premise is not narrowed by anything, so the
        // version chain and the evidence shield below stay reachable for it — that is
        // the guard test "a premise-free row is the only incumbent a narrowing refuses".
        if (narrowsPremiseFree(r.scope)) {
          notePremiseNarrow(r);
          continue;
        }
        let trigger: string | null = 'path-0 identical structured subject with shared entities';
        if (oldClaim.value === newClaim.value) {
          // Same value, but a DIFFERENT verbatim detail is new information,
          // not a rehearsal (field report BUG-B: identical summaries with
          // different details collapsed to `none` and the second detail was
          // silently dropped). Fall through so the write becomes its own
          // trace instead of discarding the caller's detail.
          if ((payload.detail ?? '').trim() !== (r.detail ?? '').trim()) continue;
          // Spaced rehearsal: the boost scales with the time since the last
          // access (massed repetition earns little; spaced re-telling more).
          const imp = Math.min(1, r.importance + rehearsalBoost(r.last_access_at, Date.parse(now)));
          // A rehearsal may carry fresh evidence the incumbent lacked ("that
          // value I logged — I just re-ran the check, it passes"). Keep the row
          // but land the evidence, or a later verify reads it as unverified.
          // Upgrade only: a bare re-tell never erases a result already on file.
          const carryVerify =
            payload.verifyResult !== undefined
              ? {
                  verify_result: payload.verifyResult,
                  verified_at: payload.verifiedAt ?? (payload.verifyResult === 'pass' ? now : r.verified_at),
                  verify_json: payload.verify !== undefined ? JSON.stringify(payload.verify) : r.verify_json,
                  verify_attested:
                    payload.verifyAttested !== undefined ? (payload.verifyAttested ? 1 : 0) : (r.verify_attested ?? 0)
                }
              : {};
          this.db.update({ ...r, ...carryVerify, importance: imp, updated_at: now });
          return {
            outcome: 'none',
            memory: rowToMemory(this.db.getById(r.id)!, false),
            neighbours,
            scope_only_matches: scopeOnlyMatches,
            ...(suspectedConflict ? { suspected_conflict: true } : {})
          };
        }
        // Distinct real-world events on the same subject (e.g. a key rotated
        // on two different days) stay separate — only semantic/procedure
        // claims and same-event episodes get overridden.
        const windowOk = r.kind === 'semantic' || r.kind === 'procedure' || this.sameEventWindowMs(payload, r);
        if (!windowOk) continue;
        // Evidence shield (suggestion 2 + 保鲜期 + audit #5): a freshly
        // VERIFIED incumbent is retired only by a challenger that also passes
        // evidence — and only ATTESTED evidence earns the full shield. A
        // self-reported pass (agent asserted, never re-runnable) degrades to
        // a visible warning: it must not guard data against a correction.
        // Stale evidence (past TTL or unstamped) no longer shields.
        const standing = evidenceStanding(r, nowMs, this.options.evidenceTtlSec);
        if (standing !== 'none' && payload.verifyResult !== 'pass') {
          if (standing === 'attested') {
            shielded =
              `shielded: existing VERIFIED row ${r.id.slice(0, 8)} (v${r.version}) — "` +
              `${sanitizeMemoryText(r.summary).slice(0, 60)}" was NOT retired by this unverified write; both rows are kept. ` +
              `To replace it, re-run its evidence and pass verifyResult:'pass' (or supersedes:[id] to force).`;
            break;
          }
          // self-reported: keep the write, warn that the badge is hearsay.
          pendingNotes.push(
            `shield-note: incumbent ${r.id.slice(0, 8)} (v${r.version}) carries SELF-REPORTED evidence (never re-run by the engine) — ` +
            `its retirement shield is degraded; the override proceeds, and the old revision stays in history. ` +
            `Pass verifyAttested:true only when the check was actually executed in a reproducible environment.`
          );
        }
        const prior = { id: r.id, version: r.version, summary: r.summary };
        const res = await this.update(r.id, {
          summary,
          detail: payload.detail,
          episode: payload.episode,
          semantic: payload.semantic,
          entities: payload.entities,
          tags: payload.tags,
          occurredAt: payload.occurredAt,
          source: payload.source,
          verify: payload.verify,
          verifyResult: payload.verifyResult,
          verifiedAt: verifiedAt,
          retracts: payload.retracts,
          guard,
          scope,
          confidence
        });
        return {
          outcome: 'override',
          memory: res.memory,
          superseded: prior,
          neighbours,
          scope_only_matches: scopeOnlyMatches,
          warning: withNotes(
            `override: this write retired ${prior.id.slice(0, 8)} (v${prior.version}) — "` +
            `${sanitizeMemoryText(prior.summary).slice(0, 70)}". Trigger: ${trigger}. ` +
            `Recover it via memory_maintain history ${prior.id}, or pass supersedes next time to make the intent explicit.`
          ) as string,
          ...(suspectedConflict ? { suspected_conflict: true } : {})
        };
      }
    }

    // 1. verbatim re-tell of the same claim → rehearsal, strengthen only
    //    (compare with the wrapper stripped so "FACT: X" counts as a re-tell of X)
    //    The detail is part of the claim: an identical summary carrying a
    //    different verbatim detail is NOT a re-tell (field report BUG-B) —
    //    collapsing it to `none` silently discards the new detail.
    const isRetell =
      closest !== undefined &&
      isVerbatimRestatement(closest.r.summary, summary) &&
      (payload.detail ?? '').trim() === (closest.r.detail ?? '').trim();
    const closestClash = premiseClash(closest?.r.scope);
    if (closest && isRetell && closestClash.length > 0) {
      notePremiseSkip(closest.r, closestClash);
    }
    if (closest && isRetell && closestClash.length === 0) {
      // G4: the verbatim case is where the silent narrowing was cheapest — the incumbent
      // matched character for character, so `none` looked obviously right, while the scope
      // the row answers UNDER had just changed. Refuse it here and let the write land as
      // its own trace; a premise-free re-tell (`scope` absent) still rehearses normally.
      if (narrowsPremiseFree(closest.r.scope)) {
        notePremiseNarrow(closest.r);
      } else {
        const imp = Math.min(1, closest.r.importance + rehearsalBoost(closest.r.last_access_at, Date.parse(now)));
        // A re-tell may carry fresh evidence the incumbent lacked ("this fact I
        // logged earlier — I just ran the check and it passes"). Rehearsal keeps
        // the row, but the evidence must land, or a later verify reads the row as
        // unverified. Only upgrade: never let a bare re-tell erase a passing
        // result already on the row.
        const carryVerify =
          payload.verifyResult !== undefined
            ? {
                verify_result: payload.verifyResult,
                verified_at: payload.verifiedAt ?? (payload.verifyResult === 'pass' ? now : closest.r.verified_at),
                verify_json: payload.verify !== undefined ? JSON.stringify(payload.verify) : closest.r.verify_json,
                verify_attested:
                  payload.verifyAttested !== undefined ? (payload.verifyAttested ? 1 : 0) : (closest.r.verify_attested ?? 0)
              }
            : {};
        this.db.update({ ...closest.r, ...carryVerify, importance: imp, updated_at: now });
        return {
          outcome: 'none',
          memory: rowToMemory(this.db.getById(closest.r.id)!, false),
          neighbours,
          scope_only_matches: scopeOnlyMatches,
          ...(withNotes() ? { warning: withNotes() as string } : {}),
          ...(suspectedConflict ? { suspected_conflict: true } : {})
        };
      }
    }

    // 2. cross-kind merge: an episodic re-tell of an existing semantic rule.
    //    Compare with the consolidation wrapper stripped: consolidation writes
    //    the episode as "FACT: <same text>", so a raw comparison would miss the
    //    twin and let a duplicate accumulate (observed: 17 such pairs).
    //
    //    Identity gate (field probe G5b): body + verbatim detail + entity set
    //    must ALL match — and deliberately NO cosine gate. An exact identity
    //    match is stronger evidence than any cosine; the old sim >= 0.92 gate
    //    made this branch embedder-fragile (metadata such as a differing
    //    detail/FACT: wrapper drags contentText cosine below the bar, so
    //    identical twins merged or not depending on the embedder). A differing
    //    detail or entity set means the episode carries its own information
    //    and must survive as its own trace (same lesson as BUG-B).
    //
    //    Retractions never merge (markers stay addressable on their own).
    if (kind === 'episode' && !isRetraction) {
      const newDetail = (payload.detail ?? '').trim();
      const newEnts = new Set(entities.map((e) => e.toLowerCase()));
      const nearSemantic = candidates.find((x) => {
        if (x.r.kind !== 'semantic') return false;
        if (premiseClash(x.r.scope).length > 0) return false;
        if (!isVerbatimRestatement(x.r.summary, summary)) return false;
        if (((x.r.detail ?? '') as string).trim() !== newDetail) return false;
        const rowEnts = JSON.parse(x.r.entities_json || '[]') as string[];
        return rowEnts.length === entities.length && rowEnts.every((e) => newEnts.has(e.toLowerCase()));
      });
      if (nearSemantic && narrowsPremiseFree(nearSemantic.r.scope)) {
        // G4: the third door. This branch returns `merge` rather than `none`, so an
        // assertion about the no-op label alone would leave it open — the rule is about
        // the premise changing, not about which outcome word was attached to it.
        notePremiseNarrow(nearSemantic.r);
      } else if (nearSemantic) {
        const imp = Math.min(1, nearSemantic.r.importance + 0.01 + rehearsalBoost(nearSemantic.r.last_access_at, Date.parse(now)));
        this.db.update({ ...nearSemantic.r, importance: imp, updated_at: now });
        return {
          outcome: 'merge',
          memory: rowToMemory(this.db.getById(nearSemantic.r.id)!, false),
          neighbours,
          scope_only_matches: scopeOnlyMatches,
          ...(withNotes() ? { warning: withNotes() as string } : {}),
          ...(suspectedConflict ? { suspected_conflict: true } : {})
        };
      }
    }

    // 3. near-contradiction on the same event/scope → versioned override.
    //    (Human analog: reconsolidation — the old trace is archived, not erased.)
    //
    //    Scope must be an actual INTERSECTION (field report BUG-1 (b)): the
    //    previous form was `entities.length === 0 || closest.r.entities_json
    //    === '[]' || overlap`, i.e. "no entities declared" counted as "shares
    //    scope", so two entity-less rows could overwrite each other purely on
    //    cosine. Cosine alone cannot establish shared scope — a high-frequency
    //    domain term inflates similarity between unrelated rows.
    const closestEntities = closest ? (JSON.parse(closest.r.entities_json || '[]') as string[]) : [];
    const sharesScope =
      closest !== undefined && entities.length > 0 && closestEntities.length > 0 && this.entitiesOverlap(entities, closestEntities);
    // Disagreement evidence (field report, BUG-1 recurrence): cosine +
    // shared-entity alone still fires on unrelated rows that share domain
    // jargon ("byte 0 = X" vs "bytes 2-5 = AD" measured 0.88 under bge).
    // Require the same structured-claim subject (a value flip on one
    // attribute) or opposite polarity. Otherwise the write becomes a new
    // trace with visible neighbours, and the caller supersedes explicitly.
    const closestClaim = closest ? claimParts(closest.r.summary) : null;
    const sameSubject = !!(newClaim && closestClaim && closestClaim.subject === newClaim.subject);
    const oppositePolarity = closest ? this.polarityOf(closest.r.summary) !== newNegated : false;
    // R1 (round 30) — the SECOND retirement site, found by re-running the reporter's own
    // reproduction against the build that fixed path-0 (`.hippo/repro-r1r2r3-round30b-postfix.txt`):
    // the write no longer overrode through the keyed loop, fell through to here, and retired
    // the same premise-free row on similarity alone (content-sim 0.90 + claim-sim 0.95, same
    // structured subject, shared entities). `narrowsPremiseFree` asks the question that
    // protects the data — "does the incumbent state no premise?" — and this arm never asked
    // it. G3's lesson, restated: a rule wired to three of its four doors is not a rule.
    //
    // The evidence shield below is deliberately NOT given a turn to speak for this row. That
    // is a placement decision, not a measurement: in the reproduction above the incumbent
    // carries no standing evidence, so `shielded` is false and the shield never speaks. When
    // a premise-free row DOES hold attested evidence, the two gates would both apply, and the
    // shield's copy would explain the right outcome by the wrong reason ("not retired: its
    // VERIFIED evidence stands") while pointing the caller at `supersedes` / a re-run — the
    // wrong lever for a premise. Refusing first makes the premise note the one that speaks.
    let narrowsIncumbent = false;
    if (closest && narrowsPremiseFree(closest.r.scope)) {
      narrowsIncumbent = true;
      notePremiseNarrow(closest.r);
    }
    // Path-3 side of the evidence shield (same rule as path-0, audit #5):
    // only ATTESTED fresh evidence blocks; a self-reported pass warns.
    const closestStanding = closest
      ? evidenceStanding(closest.r, nowMs, this.options.evidenceTtlSec)
      : ('none' as const);
    if (
      closest &&
      !narrowsIncumbent &&
      !isRetell &&
      !isRetraction &&
      !isRetractionRow(closest.r) &&
      !shielded &&
      closestClash.length === 0 &&
      closest.sim >= this.options.contradictionThreshold &&
      sharesScope &&
      (sameSubject || oppositePolarity) &&
      this.sameEventWindowMs(payload, closest.r) &&
      closestStanding !== 'none' &&
      payload.verifyResult !== 'pass'
    ) {
      if (closestStanding === 'attested') {
        shielded =
          `shielded: existing VERIFIED row ${closest.r.id.slice(0, 8)} (v${closest.r.version}) — "` +
          `${sanitizeMemoryText(closest.r.summary).slice(0, 60)}" was NOT retired by this unverified write; both rows are kept. ` +
          `To replace it, re-run its evidence and pass verifyResult:'pass' (or supersedes:[id] to force).`;
      } else {
        pendingNotes.push(
          `shield-note: incumbent ${closest.r.id.slice(0, 8)} (v${closest.r.version}) carries SELF-REPORTED evidence (never re-run by the engine) — ` +
          `its retirement shield is degraded; the override proceeds, and the old revision stays in history. ` +
          `Pass verifyAttested:true only when the check was actually executed in a reproducible environment.`
        );
      }
    }
    // Brink of firing: every structural condition holds. Before retiring,
    // re-measure similarity CLAIM-to-CLAIM (field report R31): the firing
    // sim above is contentText cosine — summary PLUS verbatim detail PLUS
    // entities — and a long shared detail dominates it ("the more detailed
    // the write, the easier a false override": measured 0.8658 content vs
    // 0.6995 summary-only on the same pair). The claims themselves must also
    // clear the bar, or the write is kept as its own trace with a note.
    const brink =
      closest &&
      !narrowsIncumbent &&
      !isRetell &&
      !isRetraction &&
      !isRetractionRow(closest.r) &&
      !shielded &&
      closestClash.length === 0 &&
      closest.sim >= this.options.contradictionThreshold &&
      sharesScope &&
      (sameSubject || oppositePolarity) &&
      this.sameEventWindowMs(payload, closest.r);
    let claimSim: number | null = null;
    let withheldContradiction: string | undefined;
    if (brink && closest) {
      const qv = await this.embedOne(summary);
      const rv = await this.embedOne(closest.r.summary);
      claimSim = qv.length > 0 && qv.length === rv.length ? cosine(qv, rv) : 0;
      if (claimSim < this.options.claimThreshold) {
        withheldContradiction =
          `withheld-contradiction: content-sim ${closest.sim.toFixed(2)} clears ${this.options.contradictionThreshold.toFixed(2)} but claim-sim ` +
          `${claimSim.toFixed(2)} does not clear ${this.options.claimThreshold.toFixed(2)} — shared detail is dominating the match, so this was kept as a new trace. ` +
          `Pass supersedes:[${closest.r.id.slice(0, 8)}…] to force, or restate the claim.`;
      }
    }
    if (brink && closest && claimSim !== null && claimSim >= this.options.claimThreshold) {
      const prior = { id: closest.r.id, version: closest.r.version, summary: closest.r.summary };
      const res = await this.update(closest.r.id, {
        summary,
        detail: payload.detail,
        episode: payload.episode,
        semantic: payload.semantic,
        entities: payload.entities,
        tags: payload.tags,
        occurredAt: payload.occurredAt,
        source: payload.source,
        verify: payload.verify,
        verifyResult: payload.verifyResult,
        verifiedAt: verifiedAt,
        retracts: payload.retracts,
        guard,
        scope,
        confidence
      });
      return {
        outcome: 'override',
        memory: res.memory,
        superseded: prior,
        neighbours,
        scope_only_matches: scopeOnlyMatches,
        // Overwriting is destructive to the caller's intent when unrequested, so
        // it is never silent: name what was retired (field report BUG-1 (c)),
        // and print BOTH similarity calibres (R31 suggestion 8) so a reader
        // can see whether shared detail carried the match over the bar.
        warning: withNotes(
          `override: this write retired ${prior.id.slice(0, 8)} (v${prior.version}) — "` +
          `${sanitizeMemoryText(prior.summary).slice(0, 70)}". Trigger: path-3 content-sim ${closest.sim.toFixed(2)} + claim-sim ${(claimSim as number).toFixed(2)} with shared entities and ${sameSubject ? 'identical structured subject' : 'opposite polarity'}. ` +
          `Recover it via memory_maintain history ${prior.id}, or pass supersedes next time to make the intent explicit.`
        ) as string,
        ...(suspectedConflict ? { suspected_conflict: true } : {})
      };
    }

    // 4. new trace (explicit supersedes edges were applied in the fast path above;
    //    an evidence-shielded write also lands here, next to its VERIFIED incumbent)
    const id = randomUUID();
    const row = this.buildRow({
      id,
      version: 1,
      kind,
      summary,
      detail: payload.detail,
      episode: payload.episode,
      semantic: payload.semantic,
      entities,
      tags,
      occurredAt: payload.occurredAt ?? (kind === 'episode' ? now : undefined),
      source: payload.source,
      verify: payload.verify,
      verifyResult: payload.verifyResult,
      verifyAttested: payload.verifyAttested,
      verifiedAt: verifiedAt,
      retracts: payload.retracts,
      guard,
      scope,
      confidence,
      importance,
      createdAt: now,
      updatedAt: now,
      vec
    });
    this.db.insert(row);
    // A withheld update is never silent either (field report STAR): when the
    // entity gate stopped an overwrite, say so and how to authorise it.
    const blockedWarning =
      scopeOnlyMatches.length > 0
        ? `not-overridden: ${scopeOnlyMatches.length} same-subject row(s) share no entity with this write, so nothing was retired ` +
          `(${scopeOnlyMatches.map((m) => `${m.id.slice(0, 8)} "${m.summary.slice(0, 50)}"`).join('; ')}). ` +
          `To update one, declare its entities on your next write or pass supersedes:[id].`
        : undefined;
    // Premise clash: two statements that hold under different conditions are
    // two traces. Say why the near-identical incumbent was not reused, or the
    // caller reads a separate row as a failed update.
    const premiseWarning =
      premiseSkipped.length > 0
        ? `different-scope: kept as its own trace — ${premiseSkipped.length} row(s) state another premise under ` +
          `the key(s) ${Array.from(new Set(premiseSkipped.flatMap((p) => p.keys))).join(', ')} ` +
          `(${premiseSkipped.map((p) => `${p.id.slice(0, 8)} "${p.summary}"`).join('; ')}). ` +
          `The same sentence under a different condition is not a re-tell; pass the same scope to rehearse, or supersedes:[id] to retire it.`
        : undefined;
    // G4: the caller supplied a condition a premise-free row never carried. Refusing it
    // means two rows where the old build kept one, so the pair has to explain itself —
    // otherwise it reads as a failed update, which is exactly what `different-scope`
    // above exists to prevent for the keyed case.
    const narrowWarning =
      premiseNarrowed.length > 0
        ? `premise-narrowing: kept as its own trace — ${premiseNarrowed.length} row(s) state NO premise, and the scope of this write ` +
          `(${JSON.stringify(scope)}) would replace that general statement rather than add to it ` +
          `(${premiseNarrowed.map((p) => `${p.id.slice(0, 8)} "${p.summary}"`).join('; ')}). ` +
          `The general row keeps answering callers outside that premise; to narrow one on purpose pass supersedes:[id], or update its ` +
          `scope — both raise the version and archive what the row held before.`
        : undefined;
    const notesWarning = withNotes(shielded, blockedWarning, withheldContradiction, premiseWarning, narrowWarning);
    return {
      outcome: 'new',
      memory: rowToMemory(row, false),
      neighbours,
      scope_only_matches: scopeOnlyMatches,
      ...(notesWarning ? { warning: notesWarning } : {}),
      ...(suspectedConflict ? { suspected_conflict: true } : {})
    };
  }

  /** Update a memory in place (reconsolidation): archives the old revision. */
  async update(id: string, payload: Partial<MemoryPayload>): Promise<{ memory: StoredMemory; history: number }> {
    const row = this.db.getById(id);
    if (!row) throw new Error(`update: no memory with id ${id}`);
    const existing = rowToMemory(row, false);
    const summary = payload.summary?.trim() ?? existing.summary;
    const contentText = [
      summary,
      payload.detail ?? existing.detail ?? '',
      payload.episode?.place ?? existing.episode?.place ?? '',
      payload.episode?.time ?? existing.episode?.time ?? '',
      payload.semantic?.rule ?? existing.semantic?.rule ?? '',
      payload.scope ?? existing.scope ?? '',
      ...(payload.entities ?? []).map((e) => (typeof e === 'string' ? e : e.name)),
      ...existing.entities
    ].join('\n');
    const vec = await this.embedOne(contentText);

    const now = nowIso();
    return this.db.transaction(() => {
      this.db.archiveCurrent(id, now);
      const nextVersion = existing.version + 1;
      const mergedEntities = Array.from(
        new Set([
          ...(payload.entities ?? []).map((e) => (typeof e === 'string' ? e : e.name).trim().toLowerCase()).filter(Boolean),
          ...existing.entities
        ])
      );
      const mergedTags = Array.from(new Set([...(payload.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean), ...existing.tags]));
      const next: MemoryRow = {
        ...row,
        version: nextVersion,
        kind: payload.kind ?? existing.kind,
        summary,
        detail: payload.detail !== undefined ? payload.detail : row.detail,
        episode_time: payload.episode?.time ?? row.episode_time,
        episode_place: payload.episode?.place ?? row.episode_place,
        participants_json:
          payload.episode?.participants !== undefined ? JSON.stringify(payload.episode.participants) : row.participants_json,
        rule: payload.semantic?.rule ?? row.rule,
        entities_json: JSON.stringify(mergedEntities),
        tags_json: JSON.stringify(mergedTags),
        occurred_at: payload.occurredAt ?? row.occurred_at,
        source: payload.source ?? row.source,
        verify_json: payload.verify !== undefined ? JSON.stringify(payload.verify) : row.verify_json,
        verify_result: payload.verifyResult !== undefined ? payload.verifyResult : row.verify_result,
        verified_at: payload.verifiedAt !== undefined ? payload.verifiedAt : row.verified_at,
        verify_attested: payload.verifyAttested !== undefined ? (payload.verifyAttested ? 1 : 0) : (row.verify_attested ?? 0),
        retracts: payload.retracts !== undefined ? payload.retracts : row.retracts,
        guard_json: payload.guard !== undefined ? JSON.stringify(payload.guard) : row.guard_json,
        scope: payload.scope !== undefined ? (payload.scope?.trim() || null) : row.scope,
        confidence: payload.confidence ?? row.confidence,
        importance: payload.importance !== undefined ? clamp01(payload.importance) : row.importance,
        updated_at: now,
        vec: vecToBlob(vec)
      };
      this.db.update(next);
      this.db.pruneHistory(id, this.options.maxVersionsPerId);
      return { memory: rowToMemory(next, false), history: nextVersion };
    });
  }

  private buildRow(a: {
    id: string;
    version: number;
    kind: MemoryPayload['kind'];
    summary: string;
    detail?: string;
    episode?: MemoryPayload['episode'];
    semantic?: MemoryPayload['semantic'];
    entities: string[];
    tags: string[];
    occurredAt?: string;
    source?: string;
    verify?: MemoryPayload['verify'];
    verifyResult?: MemoryPayload['verifyResult'];
    verifyAttested?: boolean;
    verifiedAt?: string;
    retracts?: string;
    guard?: MemoryPayload['guard'];
    scope?: string;
    confidence: 'high' | 'medium' | 'low' | 'speculative';
    importance: number;
    createdAt: string;
    updatedAt: string;
    vec: number[];
  }): MemoryRow {
    return {
      id: a.id,
      version: a.version,
      kind: a.kind,
      summary: a.summary,
      detail: a.detail ?? null,
      episode_time: a.episode?.time ?? null,
      episode_place: a.episode?.place ?? null,
      participants_json: a.episode?.participants ? JSON.stringify(a.episode.participants) : null,
      rule: a.semantic?.rule ?? null,
      entities_json: JSON.stringify(a.entities),
      tags_json: JSON.stringify(a.tags),
      occurred_at: a.occurredAt ?? null,
      source: a.source ?? null,
      verify_json: a.verify ? JSON.stringify(a.verify) : null,
      verify_result: a.verifyResult ?? null,
      verified_at: a.verifiedAt ?? null,
      verify_attested: a.verifyAttested ? 1 : 0,
      retracts: a.retracts ?? null,
      guard_json: a.guard ? JSON.stringify(a.guard) : null,
      scope: a.scope ?? null,
      demoted: 0,
      demoted_to: null,
      demoted_at: null,
      confidence: a.confidence,
      importance: a.importance,
      access_count: 0,
      last_access_at: null,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
      superseded: 0,
      superseded_by: null,
      vec: vecToBlob(a.vec)
    };
  }

  /* ============================ recall path ============================ */

  /**
   * Cue-driven retrieval (pattern completion). One scan over the active
   * engrams; candidates are ranked by similarity weighted by importance.
   * Every hit keeps its provenance; conflict warnings surface newer revisions
   * of the same scope so the caller does not blindly trust a stale trace.
   */
  async recall(cue: RetrievalCue, limit = 8): Promise<RecallBundle> {
    const q = cue.query.trim();
    // Empty cue (e.g. no user message surfaced yet): pattern completion has
    // nothing to complete — surface the most recently updated traces instead,
    // so auto-digest contexts never render empty during warm-up renders.
    if (!q) {
      const recent = this.db
        .allActive()
        .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
        .slice(0, Math.min(limit, 5));
      return {
        hits: recent.map((r) => {
          const mem = rowToMemory(r, false);
          return {
            ...mem,
            score: 0.5,
            similarity: 0.5,
            relativeScore: 1,
            // No cue to anchor on: recency is the stated basis, not relevance.
            anchors: ['recency'],
            anchored: true,
            consolidated: mem.consolidated === true
          };
        }),
        warnings: ['empty cue: showing recently updated memories'],
        scanned: 0,
        eligible: recent.length,
        bestSimilarity: null,
        threshold: this.options.similarityThreshold,
        reason: 'empty-cue',
        nearMisses: [],
        nearDuplicates: []
      };
    }

    const cueVec = await this.embedOne(q);
    const minImportance = cue.minImportance ?? this.options.minImportance;
    const minSim = this.options.similarityThreshold;
    const sinceMs = cue.since ? Date.parse(cue.since) : 0;
    const occurredSinceMs = cue.occurredSince ? Date.parse(cue.occurredSince) : 0;
    const exclude = new Set(cue.excludeIds ?? []);
    const entityFilter = (cue.entities ?? []).map((e) => e.toLowerCase());
    const warnings: string[] = [];
    // Hard premise filter (audit #7/#8): rows whose stated scope disagrees
    // with the asked one leave the candidate pool entirely — "conditional on
    // another setup" must not surface as an answer to this question. Rows
    // with no scope pass (absence of a premise is not a contradiction).
    const cueScope = typeof cue.scope === 'string' && cue.scope.trim() ? cue.scope.trim() : undefined;
    let scopeExcluded = 0;

    const rows = this.db.allActive();
    const hits: RetrievedMemory[] = [];
    // Live retraction index (suggestion 4): target id → {by, criterion}, so
    // hits on retracted rows carry the do-not-repeat flag at recall time.
    const retractions = new Map<string, { by: string; criterion: string }>();
    for (const r of rows) {
      if (!isRetractionRow(r) || r.superseded === 1) continue;
      const target = (r.retracts ?? '').trim();
      if (target && !retractions.has(target)) {
        retractions.set(target, { by: r.id, criterion: sanitizeMemoryText(r.detail || r.summary).slice(0, 160) });
      }
    }
    // Candidates that are relevant but fall under the threshold. Kept so an
    // empty result can be explained ("nothing stored" vs "close but too weak")
    // and so weak-but-useful traces can still be surfaced as near misses.
    const below: { mem: StoredMemory; sim: number }[] = [];
    let scanned = 0; // rows whose vector was comparable (dimension match)
    let eligible = 0; // rows passing the cheap structural filters
    let bestSim = -1;

    for (const r of rows) {
      const b = vecFromBlob(r.vec);
      if (!b || b.length !== cueVec.length) continue;
      scanned++;
      const mem = rowToMemory(r, false);
      // Folded detail stays out unless explicitly expanded (S5).
      if (mem.demoted && !cue.includeDemoted) continue;
      if (exclude.has(mem.id)) continue;
      if (cue.kind && mem.kind !== cue.kind) continue;
      if (mem.importance < minImportance) continue;
      if (sinceMs && mem.lastAccessAt && Date.parse(mem.lastAccessAt) < sinceMs) continue;
      if (occurredSinceMs && mem.occurredAt && Date.parse(mem.occurredAt) < occurredSinceMs) continue;
      if (entityFilter.length && !entityFilter.every((e) => mem.entities.includes(e))) continue;
      if (cueScope && mem.scope && scopeDifferences(mem.scope, cueScope).length > 0) {
        scopeExcluded++;
        continue;
      }
      eligible++;

      const sim = cosine(b, cueVec);
      if (sim > bestSim) bestSim = sim;
      // Literal-token rescue: an exact identifier match (0x212aa5, D-387, a
      // commit sha) is decisive evidence that cosine underrates, especially for
      // short CJK queries where embeddings are mushy. Such a row is admitted
      // even below the similarity floor, but is marked so the caller can tell.
      const literal = literalOverlap(q, mem.summary);
      if (sim < minSim && !literal) {
        below.push({ mem, sim });
        continue;
      }
      const retr = retractions.get(mem.id);
      const anchors = recallAnchors(q, mem);
      hits.push({
        ...mem,
        score: sim,
        similarity: sim,
        relativeScore: 0,
        literalMatch: literal || undefined,
        // F4b: cosine says "nearby", never "this is the answer". Say which
        // evidence ties the row to the cue, and say so when there is none.
        anchors,
        anchored: anchors.length > 0,
        // The engine's marker, not a kind alias (F4): `hits` may not claim every
        // semantic row is a consolidation product.
        consolidated: mem.consolidated === true,
        ...(retr ? { retracted: retr } : {})
      });
    }

    // Rank: similarity × (0.6 + 0.4·importance), plus a literal-identifier
    // bonus, plus small priority boosts so "do not repeat this mistake"
    // (retraction targets) and prospective guards surface above background
    // chatter on the same cue. `similarity` stays the raw cosine
    // (threshold- and verify-comparable); bonuses only affect ordering.
    // Ordering uses the unbounded value, then `score` is clamped into [0,1] so
    // a boosted hit never reports a nonsensical "1.03".
    // topK caps the candidate set before re-ranking (its documented job:
    // bound the rank on large stores). Only re-sorts when the cap bites.
    const candidates =
      hits.length > this.options.topK
        ? [...hits].sort((a, b) => b.similarity - a.similarity).slice(0, this.options.topK)
        : hits;
    const ranked = candidates
      .map((h) => ({
        ...h,
        // Rendered summary is sanitized; the stored row itself is untouched.
        summary: sanitizeMemoryText(h.summary),
        score:
          h.score * (0.6 + 0.4 * h.importance) +
          (h.literalMatch ? 0.15 * Math.min(h.literalMatch, 2) : 0) +
          (h.retracted ? 0.2 : 0) +
          (h.tags.includes('guard') ? 0.15 : 0)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((h) => ({ ...h, score: Math.min(1, h.score) }));

    // Relative score: this hit's similarity ÷ the best similarity for THIS
    // query. Cosine is compressed and query-dependent (a 0.45 can be the best
    // match in the store), so the raw number alone reads as "bad". The relative
    // score makes "best available" visible without changing ranking.
    const topSim = ranked.length ? Math.max(...ranked.map((h) => h.similarity)) : 0;
    for (const h of ranked) {
      h.relativeScore = topSim > 0 ? Number((h.similarity / topSim).toFixed(3)) : 0;
    }

    // Near misses: sub-threshold rows, best first, so a caller that got no hits
    // can see WHAT was close and how close (never silently empty again).
    const nearMisses = below
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 3)
      .map((x) => ({ id: x.mem.id, summary: sanitizeMemoryText(x.mem.summary), similarity: Number(x.sim.toFixed(3)) }));

    const reason: RecallBundle['reason'] =
      ranked.length > 0
        ? 'ok'
        : eligible === 0
          ? 'no-candidates' // nothing to search (empty / filtered out)
          : below.length > 0
            ? 'below-threshold' // relevant rows exist but none cleared the floor
            : 'no-candidates';

    // Conflict warnings: ONLY for rows that actually DISAGREE with the top
    // hit on an established scope-key.
    //
    // A conflict needs an intersection of two conditions:
    //   (1) scope-key match — shared entity AND the same structured-claim
    //       subject, or an identical entity set; and
    //   (2) disagreement — opposite polarity, or the same subject bound to a
    //       different value (the arrow form needs no negation: "gateway ->
    //       nginx" vs "gateway -> envoy" disagree without either sentence
    //       being negated).
    //
    // A newer timestamp alone is NOT a conflict — it is a sibling. Everything
    // that is not a conflict goes to nearDuplicates: still visible, but not a
    // warning.
    //
    // Regression history (field report, 3rd round): the previous predicate
    // OR-ed in `m.similarity >= similarityThreshold`, which every hit
    // satisfies by construction (hits are admitted at that floor), so it
    // collapsed to "newer than the top hit" and flagged ~25 traces — the
    // entire result set. Warnings that fire on everything carry no signal and
    // train the caller to ignore them, which is worse than the silent
    // under-reporting it replaced. When in doubt: stay quiet.
    const top = ranked[0];
    const conflicts: RetrievedMemory[] = [];
    const nearDuplicates: { id: string; summary: string; similarity: number; reason: string }[] = [];
    if (top) {
      const topEntities = new Set(top.entities.map((e) => e.toLowerCase()));
      const topClaim = claimParts(top.summary);
      const topPolarity = this.polarityOf(top.summary);
      const topRow = this.db.getById(top.id);
      const topVec = topRow ? vecFromBlob(topRow.vec) : null;
      for (const mRec of hits) {
        if (mRec.id === top.id || mRec.summary === top.summary) continue;
        const mClaim = claimParts(mRec.summary);
        const sharedEntity = mRec.entities.some((e) => topEntities.has(e.toLowerCase()));
        const sameSubject = !!(topClaim && mClaim && mClaim.subject === topClaim.subject);
        const sameEntitySet =
          topEntities.size > 0 &&
          mRec.entities.length === top.entities.length &&
          mRec.entities.every((e) => topEntities.has(e.toLowerCase()));
        const sameScopeKey = (sharedEntity && sameSubject) || sameEntitySet;
        const oppositePolarity = this.polarityOf(mRec.summary) !== topPolarity;
        const valueDisagrees =
          !!topClaim && !!mClaim && mClaim.subject === topClaim.subject && mClaim.value !== topClaim.value;
        if (sameScopeKey && (oppositePolarity || valueDisagrees)) {
          conflicts.push(mRec);
        } else {
          // "Near-duplicate" must mean: this row SAYS THE SAME THING as the top
          // hit. So compare the two ROWS to each other — not each row to the
          // cue. `mRec.similarity` is cosine-to-cue, which measures "both are
          // relevant to the query" (true of every hit, and of near-synonyms
          // with opposite meanings alike). Two rows can sit at 0.85 from the
          // cue while being 0.99 from each other, or vice versa.
          const mRow = this.db.getById(mRec.id);
          const mVec = mRow ? vecFromBlob(mRow.vec) : null;
          const rowSim =
            topVec && mVec && topVec.length === mVec.length ? cosine(topVec, mVec) : 0;
          if (rowSim >= this.options.nearDuplicateThreshold) {
            nearDuplicates.push({
              id: mRec.id,
              summary: sanitizeMemoryText(mRec.summary).slice(0, 80),
              similarity: Number(rowSim.toFixed(3)),
              reason: 'near-duplicate'
            });
          }
        }
      }
      if (conflicts.length) {
        warnings.push(
          `conflict: ${conflicts.length} retrieved trace(s) disagree with the top hit — ${conflicts
            .map((o) => `"${sanitizeMemoryText(o.summary).slice(0, 60)}" (${o.id.slice(0, 8)}, ${o.updatedAt})`)
            .join('; ')}`
        );
      }
    }

    // Low-confidence flag (metacognition): hits the writer itself marked
    // low/speculative AND never backed with passing evidence read as
    // "I think" rather than "I know". Evidence excuses the flag — a checked
    // fact outranks its author's modesty. Warn-only, only when present.
    const unbacked = ranked.filter(
      (h) => (h.confidence === 'low' || h.confidence === 'speculative') && h.verifyResult !== 'pass'
    );
    if (unbacked.length) {
      const levels = Array.from(new Set(unbacked.map((o) => o.confidence))).join('/');
      const ids = unbacked.map((o) => o.id.slice(0, 8)).join(', ');
      warnings.push(
        'low-confidence: ' + unbacked.length + ' retrieved trace(s) were written as ' + levels +
        ' without passing evidence — treat as leads, not facts (' + ids + ')'
      );
    }

    // Infection flag: a hit whose stored text looked instruction-shaped and
    // was sanitized. Visible (not silent) so a maintainer can review the row.
    const infected = ranked.filter((h) => h.summary.includes('[sanitized-'));
    if (infected.length) {
      warnings.push(`injection: ${infected.length} retrieved memory(ies) contained instruction-shaped text and were sanitized — review with memory_maintain list/history (ids: ${infected.map((h) => h.id).join(', ')})`);
    }
    if (cueScope && scopeExcluded > 0) {
      warnings.push(`scope: ${scopeExcluded} row(s) excluded — their stated premise disagrees with "${cueScope.slice(0, 80)}"; recall without scope to see them`);
    }

    // Mark retrieved traces as accessed (usage feedback for consolidation) and
    // apply the spaced-retrieval boost: being genuinely RECALLED after a gap
    // strengthens the trace (testing effect) — passive restatement is the
    // remember() path above, retrieval is here. Cap access_count growth per
    // query at the ranked hits only, so a single recall cannot mass-boost.
    const at = nowIso();
    const nowMs = Date.parse(at);
    for (const h of ranked) {
      const row = this.db.getById(h.id);
      if (!row) continue;
      // Single UPDATE carries access bookkeeping AND the importance bump:
      // two writes would let the second clobber the first (stale snapshot).
      const boost = rehearsalBoost(row.last_access_at, nowMs) * 0.5;
      this.db.update({
        ...row,
        access_count: row.access_count + 1,
        last_access_at: at,
        importance: row.importance < 1 ? Math.min(1, row.importance + boost) : row.importance
      });
    }

    return {
      hits: ranked,
      warnings: ranked.length === 0 && reason === 'below-threshold'
        ? [...warnings, `no hit cleared the similarity floor ${minSim}; closest was ${belowFloor(bestSim, minSim)} — see nearMisses`]
        : warnings,
      scanned,
      eligible,
      ...(cueScope ? { scopeExcluded } : {}),
      bestSimilarity: bestSim < 0 ? null : Number(bestSim.toFixed(3)),
      threshold: minSim,
      reason,
      nearMisses,
      nearDuplicates
    };
  }

  /* ============================ consolidation ============================ */

  /** Permanently delete a memory by id (row + full revision history).
   *  Throws when the id does not exist. */
  delete(id: string): void {
    const row = this.db.getById(id);
    if (!row) throw new Error(`delete: no memory with id ${id}`);
    this.db.deleteWithHistory(id);
  }

  /**
   * Systems consolidation (call offline, e.g. after a session or on a timer).
   * Episodic traces that are well established (accessed often and/or important)
   * get abstracted into durable semantic rules. Episodes themselves are kept
   * (multiple-trace stance); the semantic rule then wins retrieval for
   * general-knowledge queries while the episode still answers "when/where".
   */
  async consolidate(opts: { minAccess?: number; minImportance?: number; minAgeMs?: number; now?: string } = {}): Promise<ConsolidationCandidate[]> {
    const minAccess = opts.minAccess ?? 3;
    const minImportance = opts.minImportance ?? 0.6;
    const minAgeMs = opts.minAgeMs ?? 0;
    const nowMs = Date.parse(opts.now ?? nowIso());
    const made: ConsolidationCandidate[] = [];
    // For semantic rows, skip the episode only if it has no durable content.
    for (const row of this.db.allActive().filter((r) => r.kind === 'episode')) {
      const mem = rowToMemory(row, false);
      if (mem.accessCount < minAccess && mem.importance < minImportance) continue;
      if (minAgeMs && mem.createdAt && nowMs - Date.parse(mem.createdAt) < minAgeMs) continue;

      // Real abstraction when an LLM hook is attached (audit #4): the default
      // abstractToRule() only re-wraps the sentence with a FACT: prefix, which
      // is copy-and-rename, not generalization. A summarizer receives the
      // qualifying episode and returns distilled rule(s); a throw or an empty
      // answer falls back to the template so consolidation never fails.
      let rules: string[];
      if (this.summarizer) {
        try {
          const out = await this.summarizer([
            { summary: mem.summary, detail: mem.detail, entities: mem.entities }
          ]);
          rules = (out ?? []).map((s) => String(s).trim()).filter(Boolean);
        } catch {
          rules = [];
        }
        if (rules.length === 0) {
          const fallback = abstractToRule(mem);
          if (!fallback) continue;
          rules = [fallback];
        }
      } else {
        const rule = abstractToRule(mem);
        if (!rule) continue;
        rules = [rule];
      }
      const rowVec = vecFromBlob(row.vec);
      let already = false;
      for (const rule of rules) {
        for (const s of this.db.allActive()) {
          if (s.kind !== 'semantic') continue;
          if (s.summary === rule) {
            already = true;
            break;
          }
          if (rowVec) {
            const sv = vecFromBlob(s.vec);
            if (sv && sv.length === rowVec.length && cosine(sv, rowVec) > this.options.nearDuplicateThreshold) {
              already = true;
              break;
            }
          }
        }
        if (already) break;
      }
      if (already) continue;

      for (const rule of rules) {
        const id = randomUUID();
        const now = nowIso();
        const vec = await this.embedOne(rule);
        const semRow = this.buildRow({
          id,
          version: 1,
          kind: 'semantic',
          summary: rule,
          detail: `consolidated from episode ${mem.id}${this.summarizer ? ' (llm-summarized)' : ''}`,
          semantic: { rule },
          entities: mem.entities,
          tags: [...mem.tags, 'consolidated'],
          source: mem.source,
          confidence: mem.confidence,
          importance: mem.importance,
          createdAt: now,
          updatedAt: now,
          vec
        });
        this.db.insert(semRow);
        made.push({
          id,
          kind: 'semantic',
          summary: rule,
          detail: mem.detail,
          entities: mem.entities,
          importance: mem.importance,
          accessCount: mem.accessCount,
          ageMs: nowMs - Date.parse(mem.createdAt)
        });
      }
    }
    return made;
  }

  /* ==================== schema compression (S5) ==================== */

  /**
   * Propose foldable groups (read-only): live, non-demoted, non-retired
   * episodes sharing a scope key (entity-set signature + structured-claim
   * subject when present). Markers and already-condensed rows
   * (retraction/guard/invariant tags) never join groups.
   *
   * Returns candidate groups with suggested representatives ranked by
   * (importance, accessCount, recency) — the caller authors the invariant
   * text and applies via compress(). Nothing is mutated here.
   */
  proposeCompressions(opts: { minGroup?: number; maxRepresentatives?: number } = {}): {
    key: string;
    memberIds: string[];
    suggestedRepresentatives: string[];
    note: string;
  }[] {
    const minGroup = opts.minGroup ?? 3;
    const maxReps = Math.max(1, opts.maxRepresentatives ?? 3);
    const byKey = new Map<string, MemoryRow[]>();
    for (const row of this.db.allActive()) {
      if (row.demoted === 1 || row.superseded === 1 || row.kind !== 'episode') continue;
      if (isCondensedRow(row)) continue;
      const ents = (JSON.parse(row.entities_json || '[]') as string[])
        .map((e) => e.toLowerCase())
        .sort()
        .join('+');
      const claim = claimParts(row.summary);
      const key = `ent:${ents || '(none)'}|subj:${claim ? claim.subject : '(free)'}`;
      const list = byKey.get(key);
      if (list) list.push(row);
      else byKey.set(key, [row]);
    }
    const groups: { key: string; memberIds: string[]; suggestedRepresentatives: string[]; note: string }[] = [];
    for (const [key, list] of byKey) {
      if (list.length < minGroup) continue;
      const ranked = [...list].sort(
        (a, b) => b.importance - a.importance || b.access_count - a.access_count || (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
      );
      groups.push({
        key,
        memberIds: list.map((r) => r.id),
        suggestedRepresentatives: ranked.slice(0, Math.min(maxReps, list.length - 1)).map((r) => r.id),
        note: `${list.length} traces share scope ${key}; fold into 1 invariant + up to ${maxReps} representatives`
      });
    }
    return groups.sort((a, b) => b.memberIds.length - a.memberIds.length);
  }

  /**
   * Fold members into a caller-authored invariant (S5 apply step).
   * The invariant is inserted as a semantic row tagged `invariant` whose
   * detail names every folded member; non-representative members are
   * demoted (hidden from default recall, still live + expandable).
   * Throws on unknown/retired/demoted members, representatives outside the
   * member set, or condensed (retraction/guard/invariant) members.
   */
  async compress(plan: CompressPlan): Promise<CompressResult> {
    const summary = (plan.invariant?.summary ?? '').trim();
    if (!summary) throw new Error('compress: invariant.summary is required');
    const members = Array.from(new Set((plan.members ?? []).map((x) => String(x).trim()).filter(Boolean)));
    if (members.length === 0) throw new Error('compress: members must list at least one id');
    const reps = new Set((plan.representatives ?? []).map((x) => String(x).trim()).filter(Boolean));
    for (const id of reps) {
      if (!members.includes(id)) throw new Error(`compress: representative ${id} is not in members`);
    }
    const rows = new Map<string, MemoryRow>();
    for (const id of members) {
      const row = this.db.getById(id);
      if (!row || row.superseded === 1) throw new Error(`compress: no live member ${id}`);
      if (row.demoted === 1) throw new Error(`compress: member ${id} already folded`);
      if (isCondensedRow(row)) throw new Error(`compress: member ${id} is a marker/pattern row, not foldable detail`);
      rows.set(id, row);
    }
    const memberEnts = new Set<string>();
    for (const row of rows.values()) {
      for (const e of JSON.parse(row.entities_json || '[]') as string[]) memberEnts.add(e.toLowerCase());
    }
    const invEntities = (plan.invariant.entities ?? []).map((e) => (typeof e === 'string' ? e : e.name).trim()).filter(Boolean);
    const entities = Array.from(new Set([...invEntities.map((e) => e.toLowerCase()), ...memberEnts]));
    const kept = members.filter((id) => reps.has(id));
    const folded = members.filter((id) => !reps.has(id));
    const now = nowIso();
    const invId = randomUUID();
    const memberList = members.map((id) => id.slice(0, 8)).join(', ');
    const invRow = this.buildRow({
      id: invId,
      version: 1,
      kind: 'semantic',
      summary,
      detail: [plan.invariant.detail?.trim() || '', `covers ${members.length} traces: ${memberList}`].filter(Boolean).join('\n'),
      entities,
      tags: Array.from(new Set(['invariant', ...((plan.invariant.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))])),
      source: plan.invariant.source ?? 'compress',
      confidence: 'medium',
      importance: 0.6,
      createdAt: now,
      updatedAt: now,
      vec: await this.embedOne(
        [summary, plan.invariant.detail ?? '', ...entities].join('\n')
      )
    });
    return this.db.transaction(() => {
      this.db.insert(invRow);
      for (const id of folded) this.db.setDemoted(id, invId, now);
      return { invariantId: invId, summary, kept, demoted: folded };
    });
  }

  /** Restore folded rows to default recall (undoes a compress). */
  undemote(ids: string[]): { restored: string[] } {
    const restored: string[] = [];
    this.db.transaction(() => {
      for (const raw of ids ?? []) {
        const id = String(raw).trim();
        if (!id) continue;
        const row = this.db.getById(id);
        if (!row || row.demoted !== 1) continue;
        this.db.setDemoted(id, null);
        restored.push(id);
      }
    });
    return { restored };
  }

  /* ============================ forgetting ============================ */

  /**
   * Adaptive forgetting. Traces below the strength floor are decayed on every
   * call (Ebbinghaus curve); once they have also been idle past
   * `forgetAfterSec` they are soft-deleted (superseded), which keeps the
   * retrieval space clean without destroying the archived revision history.
   */
  forget(opts: { strengthFloor?: number; now?: string; dryRun?: boolean; force?: boolean } = {}): { forgotten: string[]; decayed: string[]; spared: string[] } {
    const strengthFloor = opts.strengthFloor ?? 0.25;
    const nowMs = Date.parse(opts.now ?? nowIso());
    const forgotten: string[] = [];
    const decayed: string[] = [];
    /** Rows protected by the zero-recall guards (audit #7), for observability. */
    const spared: string[] = [];

    for (const row of this.db.allActive()) {
      // Folded detail is already out of recall; deleting it would destroy the
      // expandable detail its invariant points at. Leave it alone.
      if (row.demoted === 1) continue;
      const mem = rowToMemory(row, false);
      const strength = mem.importance * (0.5 + 0.5 * Math.min(1, mem.accessCount / 5));
      if (strength >= strengthFloor) continue;

      // Zero-recall protection (audit #7): break the negative-feedback loop
      // "recall miss → accessCount stays 0 → decay → forgotten". Two guards:
      //   1. grace period — a row younger than forgetGraceSec is simply young,
      //      not useless; it may never have been cued yet.
      //   2. evidence exemption — a row with passing evidence is re-checkable
      //      fact, not noise; forgetting it discards the audit trail.
      // force overrides both (an explicit flush means what it says).
      if (!opts.force) {
        const ageMs = nowMs - Date.parse(mem.createdAt);
        if (ageMs < this.options.forgetGraceSec * 1000) {
          spared.push(mem.id);
          continue;
        }
        if (evidenceStanding(row, nowMs, this.options.evidenceTtlSec) !== 'none') {
          spared.push(mem.id);
          continue;
        }
      }

      const idleMs = mem.lastAccessAt ? nowMs - Date.parse(mem.lastAccessAt) : nowMs - Date.parse(mem.createdAt);
      const idleEnough = idleMs >= this.options.forgetAfterSec * 1000;
      if (idleEnough || opts.force) {
        if (opts.dryRun) {
          forgotten.push(mem.id);
          continue;
        }
        this.db.setSuperseded(mem.id);
        forgotten.push(mem.id);
        continue;
      }
      // Not idle long enough yet: decay importance a notch (unless dry run).
      if (!opts.dryRun) {
        this.db.update({ ...row, importance: mem.importance * 0.9, updated_at: nowIso() });
        decayed.push(mem.id);
      }
    }
    return { forgotten, decayed, spared };
  }

  /** Hard-delete a memory and its archived revision history. Use sparingly. */
  destroy(id: string): void {
    this.db.hardDelete(id);
  }

  /**
   * Report near-duplicate traces (read-only; never deletes).
   *
   * Duplicates accumulate from restatements that slip past the write-path
   * merge, and they arrive through two channels, so the report has two:
   *
   *  - `by: 'text'` — an episode and the semantic rule abstracted from it,
   *    where the rule carries a "FACT: " wrapper. Comparison strips that
   *    wrapper and ignores case and whitespace, so a cross-kind restatement is
   *    recognised. The write path now folds these automatically; this reports
   *    what is already stored.
   *  - `by: 'vector'` (F3, black-box report #1) — DIFFERENT wording of one
   *    statement, at or above `nearDuplicateThreshold`. That bar is the
   *    engine's own definition of "same statement" (recall surfaces such pairs
   *    as `nearDuplicates`, `consolidate` refuses to re-fold them) and until
   *    now the cleanup entry point was the one place that never consulted it:
   *    measured on the report's shape, three paraphrases of one fact gave
   *    `scanned=3 groupCount=0`, and `mergeDuplicates` then refused the ids.
   *    Rows already inside a text group are excluded, so the two channels never
   *    report the same pair twice; a paraphrase of a sentence that is itself
   *    duplicated surfaces after that text group is merged.
   *
   * Cost: the vector channel compares the rows that carry a unique text,
   * pairwise, once per call — O(k²) cosines on k singletons in a store of
   * active, non-demoted rows (measured store in the field report: 58 rows).
   *
   * Grouping by text means a group can also hold two traces that state
   * incompatible premises: `mixedPremises` marks the group when *any pair* in
   * it disagrees, because those two rows are different facts rather than
   * duplicates (the other rows in the same group may still be). `similarity` is
   * the weakest measured link inside a vector group, and `null` for a text
   * group, which asserts no measured score.
   */
  duplicates(): {
    groups: {
      key: string;
      by: 'text' | 'vector';
      similarity: number | null;
      mixedPremises: boolean;
      memories: { id: string; kind: MemoryKind; version: number; summary: string; scope: string | null }[];
    }[];
    scanned: number;
  } {
    const byKey = new Map<string, StoredMemory[]>();
    const vectors = new Map<string, number[] | null>();
    for (const row of this.db.allActive()) {
      if (row.demoted === 1) continue; // folded detail is accounted for, not a stray duplicate
      const mem = rowToMemory(row, false);
      const key = normalizeText(stripAbstractPrefix(mem.summary));
      if (!key) continue;
      const list = byKey.get(key);
      if (list) list.push(mem);
      else byKey.set(key, [mem]);
      vectors.set(mem.id, vecFromBlob(row.vec));
    }
    const view = (m: StoredMemory) => ({
      id: m.id,
      kind: m.kind,
      version: m.version,
      summary: m.summary,
      scope: m.scope ?? null
    });
    // Any pair in the group stating a different premise makes it mixed — the
    // same rule for both channels, since a near-duplicate pair under two
    // conditions is two facts just as much as a verbatim pair is.
    //
    // G2 (round 28) adds the second reading of "different": one side states a condition
    // and the other states none. `scopeDifferences` calls that pair undifferentiated, so
    // the group used to be reported as tidy and a cleanup sweep would walk straight into
    // the fold the merge gate now refuses. Report and refusal consult the same
    // `premiseAgrees`, so they cannot disagree about whether the pair is one statement.
    const anyPremiseClash = (sorted: StoredMemory[]): boolean => {
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i]?.scope ?? null;
          const b = sorted[j]?.scope ?? null;
          if (!premiseAgrees(a, b) || scopeDifferences(a, b).length > 0) return true;
        }
      }
      return false;
    };
    const byCreated = (a: StoredMemory, b: StoredMemory) => a.createdAt.localeCompare(b.createdAt);
    const groups: {
      key: string;
      by: 'text' | 'vector';
      similarity: number | null;
      mixedPremises: boolean;
      memories: { id: string; kind: MemoryKind; version: number; summary: string; scope: string | null }[];
    }[] = [...byKey.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([key, list]) => {
        const sorted = list.sort(byCreated);
        return {
          key: key.slice(0, 120),
          by: 'text' as const,
          similarity: null,
          mixedPremises: anyPremiseClash(sorted),
          memories: sorted.map(view)
        };
      });

    // ---- vector channel ----
    const grouped = new Set(groups.flatMap((g) => g.memories.map((m) => m.id)));
    const singles = [...byKey.values()].flat().filter((m) => !grouped.has(m.id)).sort(byCreated);
    const threshold = this.options.nearDuplicateThreshold;
    const parent = singles.map((_, i) => i);
    const root = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]!]!;
        i = parent[i]!;
      }
      return i;
    };
    const weakest = new Map<number, number>();
    for (let i = 0; i < singles.length; i++) {
      for (let j = i + 1; j < singles.length; j++) {
        const a = vectors.get(singles[i]!.id);
        const b = vectors.get(singles[j]!.id);
        // Incomparable vectors (missing, or a different embedding space after a
        // provider swap) are not a match — and not an error either; the row just
        // cannot be judged by this channel.
        if (!a || !b || a.length !== b.length) continue;
        const sim = cosine(a, b);
        if (sim < threshold) continue;
        const ra = root(i);
        const rb = root(j);
        if (ra !== rb) parent[ra] = rb;
        for (const r of [ra, rb]) {
          const seen = weakest.get(r);
          weakest.set(r, seen === undefined ? sim : Math.min(seen, sim));
        }
      }
    }
    const clusters = new Map<number, number[]>();
    singles.forEach((m, i) => {
      const r = root(i);
      (clusters.get(r) ?? clusters.set(r, []).get(r)!).push(i);
    });
    for (const [rootIndex, members] of clusters) {
      if (members.length < 2) continue;
      const sorted = members.map((i) => singles[i]!).sort(byCreated);
      groups.push({
        key: `vector:${sorted[0]!.id.slice(0, 8)}`,
        by: 'vector',
        similarity: Number((weakest.get(rootIndex) ?? threshold).toFixed(4)),
        mixedPremises: anyPremiseClash(sorted),
        memories: sorted.map(view)
      });
    }
    return { groups, scanned: this.db.countActive() };
  }

  /**
   * Merge one duplicate group reported by `duplicates()` into a single live
   * trace.
   *
   * The extras are demoted INTO the survivor — the same mechanism `compress`
   * uses — so nothing is erased: they stay in the file, stay visible in `list()`
   * (flagged `demoted`), drop out of default recall unless `includeDemoted` is
   * set, and `undemote()` puts any of them back. `dryRun` previews the decision
   * without touching the store.
   */
  async mergeDuplicates(plan: { ids: string[]; into?: string; dryRun?: boolean } = { ids: [] }): Promise<{
    survivor: { id: string; kind: MemoryKind; version: number; summary: string } | null;
    retired: { id: string; kind: MemoryKind; summary: string }[];
    carried: string[];
    blocked: { id: string; reason: string }[];
    dryRun: boolean;
    note: string;
  }> {
    const ids = Array.from(new Set((plan.ids ?? []).map((x) => String(x).trim()).filter(Boolean)));
    if (ids.length < 2) throw new Error('merge: needs the ids of at least two restatements');
    const rows: MemoryRow[] = [];
    for (const id of ids) {
      const row = this.db.getById(id);
      if (!row || row.superseded === 1) throw new Error(`merge: no live memory ${id}`);
      if (isCondensedRow(row)) {
        throw new Error(`merge: ${id} is a marker row (retraction / guard / invariant) — retiring it would drop what it injects`);
      }
      rows.push(row);
    }
    // What makes these rows one statement? Two channels (F3), the same ones
    // `duplicates()` reports: identical text under the wrapper-insensitive
    // normalisation, or vectors at or above `nearDuplicateThreshold` forming ONE
    // connected cluster. The guard's purpose is unchanged — a caller who hands
    // over two unrelated ids would otherwise erase one of them behind a
    // "cleanup" — it just no longer claims text identity is the only way a fact
    // gets restated. Rows with incomparable vectors cannot clear the second
    // channel, so they still need identical text.
    const keys = new Set(rows.map((r) => normalizeText(stripAbstractPrefix(r.summary))));
    if (keys.size > 1) {
      const threshold = this.options.nearDuplicateThreshold;
      const sim = (a: MemoryRow, b: MemoryRow): number => {
        const va = vecFromBlob(a.vec);
        const vb = vecFromBlob(b.vec);
        if (!va || !vb || va.length !== vb.length) return -1;
        return cosine(va, vb);
      };
      // Reachability from the first id over "same statement" edges.
      const reached = new Set([0]);
      const queue = [0];
      while (queue.length) {
        const i = queue.shift()!;
        for (let j = 0; j < rows.length; j++) {
          if (reached.has(j)) continue;
          if (sim(rows[i]!, rows[j]!) >= threshold) {
            reached.add(j);
            queue.push(j);
          }
        }
      }
      if (reached.size < rows.length) {
        const orphans = rows.filter((_, i) => !reached.has(i)).map((r) => r.id.slice(0, 8));
        throw new Error(
          `merge: these ${rows.length} ids are not restatements of one claim — ${orphans.join(', ')} share neither text nor a vector within ` +
          `${threshold.toFixed(2)} of the rest (${[...keys].map((k) => `"${k.slice(0, 40)}"`).join(' vs ')}). Pass a single group from duplicates()`
        );
      }
    }
    // Pick the row that is worth keeping: re-checkable evidence outranks a bare
    // restatement (merging must never retire the only row an agent can re-run),
    // then usage, then salience; creation time only breaks ties.
    const byValue = [...rows].sort(
      (a, b) =>
        Number(b.verify_result === 'pass') - Number(a.verify_result === 'pass') ||
        b.access_count - a.access_count ||
        b.importance - a.importance ||
        b.version - a.version ||
        a.created_at.localeCompare(b.created_at)
    );
    const survivor = plan.into ? rows.find((r) => r.id === plan.into) ?? null : byValue[0] ?? null;
    if (!survivor) throw new Error(`merge: ${plan.into} is not one of the ids`);
    const toView = (r: MemoryRow) => ({ id: r.id, kind: r.kind, summary: r.summary });

    // Premise gate: `duplicates()` groups by text AND by vector, and the same
    // statement under another condition is deliberately its own trace (that is
    // what `scope` is for), so those rows are not restatements of each other and
    // stay apart — whichever channel put them in the same group.
    const clashOf = (r: MemoryRow) => scopeDifferences(survivor.scope, r.scope);
    // G2 (round 28): the other half of "different premises". A premise-free row and a
    // conditioned one produce an EMPTY `clashOf` — there is no shared key to differ on —
    // and read as restatements right up to the fold, where one of the two statements is
    // retired: the general row loses the coverage that motivated keeping the pair apart,
    // or the conditioned row loses the premise someone stated. `premiseAgrees` is the same
    // predicate the write path refuses the narrowing under, so the two doors cannot disagree.
    const premiseOnly = (r: MemoryRow) => !survivor.scope !== !r.scope;
    const others = byValue.filter((r) => r.id !== survivor.id);
    const retired = others.filter((r) => clashOf(r).length === 0 && !premiseOnly(r));
    const blocked = others
      .filter((r) => clashOf(r).length > 0 || premiseOnly(r))
      .map((r) => ({
        id: r.id,
        reason: premiseOnly(r)
          ? `states ${r.scope ? 'a premise where the survivor states none' : 'no premise, while the survivor states one'} (${
              survivor.scope ? `"${survivor.scope}"` : 'none'
            } vs ${r.scope ? `"${r.scope}"` : 'none'}) — a general statement and a conditioned one are not restatements of each other, so neither may be folded into the other`
          : `states different premises (${clashOf(r).join(', ')}) — the same sentence under another condition stays its own trace`
      }));
    if (retired.length === 0) {
      return {
        survivor: null,
        retired: [],
        carried: [],
        blocked,
        dryRun: !!plan.dryRun,
        note:
          'merge: nothing retired — every other row in the group states premises that disagree with, or are absent beside, the one it would be merged into'
      };
    }

    // What the retired rows know that the survivor does not. Merging text is
    // easy; losing the only mention of an entity is how a cleanup turns into a
    // retrieval regression.
    const ownEnts = new Set(JSON.parse(survivor.entities_json || '[]') as string[]);
    const ownTags = new Set(JSON.parse(survivor.tags_json || '[]') as string[]);
    const extraEnts: string[] = [];
    const extraTags: string[] = [];
    let richest = (survivor.detail ?? '').trim();
    let richestFrom = '';
    let topImportance = survivor.importance;
    let importanceFrom = '';
    for (const r of retired) {
      for (const e of JSON.parse(r.entities_json || '[]') as string[]) {
        if (!ownEnts.has(e) && !extraEnts.includes(e)) extraEnts.push(e);
      }
      for (const t of JSON.parse(r.tags_json || '[]') as string[]) {
        if (!ownTags.has(t) && !extraTags.includes(t)) extraTags.push(t);
      }
      const d = (r.detail ?? '').trim();
      if (d.length > richest.length) { richest = d; richestFrom = r.id; }
      if (r.importance > topImportance) { topImportance = r.importance; importanceFrom = r.id; }
    }
    const carried: string[] = [];
    if (extraEnts.length) carried.push(`entities +${extraEnts.length} (${extraEnts.join(', ')})`);
    if (extraTags.length) carried.push(`tags +${extraTags.length} (${extraTags.join(', ')})`);
    if (richestFrom) carried.push(`detail from ${richestFrom.slice(0, 8)} (longer verbatim record)`);
    if (importanceFrom) carried.push(`importance ${survivor.importance} → ${topImportance}`);

    if (plan.dryRun) {
      return {
        survivor: { id: survivor.id, kind: survivor.kind, version: survivor.version, summary: survivor.summary },
        retired: retired.map(toView),
        carried,
        blocked,
        dryRun: true,
        note: `preview only — applying would keep ${survivor.id.slice(0, 8)} and retire ${retired.length} restatement(s) (reversible with undemote)`
      };
    }

    // Carry over BEFORE retiring: if the process dies in between the group is
    // still reported as duplicate (harmless, re-run), whereas the reverse order
    // would drop the survivor's inherited entities with nothing left to restore.
    if (extraEnts.length || extraTags.length || richestFrom || importanceFrom) {
      await this.update(survivor.id, {
        ...(extraEnts.length ? { entities: extraEnts.map((name) => ({ name })) } : {}),
        ...(extraTags.length ? { tags: extraTags } : {}),
        ...(richestFrom ? { detail: richest } : {}),
        ...(importanceFrom ? { importance: topImportance } : {})
      });
    }
    const now = nowIso();
    return this.db.transaction(() => {
      for (const r of retired) this.db.setDemoted(r.id, survivor.id, now);
      // Report the row as it now stands: carrying over bumps its version.
      const after = this.db.getById(survivor.id) ?? survivor;
      return {
        survivor: { id: after.id, kind: after.kind, version: after.version, summary: after.summary },
        retired: retired.map(toView),
        carried,
        blocked,
        dryRun: false,
        note: `kept ${survivor.id.slice(0, 8)} and retired ${retired.length} restatement(s) — still live, hidden from default recall, reversible with undemote`
      };
    });
  }

  /**
   * Audit view for overwritten memories (field report BUG-1 follow-up).
   *
   * `duplicates()` only finds rows that still COEXIST with near-identical text,
   * so it cannot see the damaging case at all: an override ARCHIVES the old row
   * and keeps a live row about a different subject, leaving no live pair to
   * compare. This walks the version history instead and reports overrides whose
   * archived text has poor lexical overlap with the live text — i.e. "the theme
   * did not carry over", the exact signature of an unrelated memory being
   * retired.
   *
   * Read-only. Lexical overlap is a heuristic screen for human review, not a
   * verdict: it deliberately favours recall over precision.
   */
  overrideAudit(opts: { minOverlap?: number; limit?: number } = {}): {
    suspicious: {
      id: string;
      liveSummary: string;
      archived: { version: number; summary: string; archivedAt: string | null };
      overlap: number;
      entitiesLive: string[];
      entitiesArchived: string[];
      sharedEntities: string[];
    }[];
    scannedOverridden: number;
    note: string;
  } {
    const minOverlap = opts.minOverlap ?? 0.34;
    const limit = opts.limit ?? 50;
    const suspicious: {
      id: string;
      liveSummary: string;
      archived: { version: number; summary: string; archivedAt: string | null };
      overlap: number;
      entitiesLive: string[];
      entitiesArchived: string[];
      sharedEntities: string[];
    }[] = [];
    let scannedOverridden = 0;

    for (const row of this.db.allActive()) {
      if (row.version <= 1) continue; // never overridden
      scannedOverridden++;
      const history = this.db.historyOf(row.id);
      const prior = history.find((h) => h.version === row.version - 1) ?? history[0];
      if (!prior) continue;
      // Compare the BOUND VALUES, not the whole sentences. A structured claim
      // keeps its subject across a correction ("deploy target -> X" stays
      // "deploy target -> Y"), so whole-sentence overlap is dominated by the
      // shared prefix and never drops. The value is what actually changed.
      const rowClaim = claimParts(row.summary);
      const priorClaim = claimParts(prior.summary);
      const liveText = rowClaim ? rowClaim.value : row.summary;
      const archText = priorClaim ? priorClaim.value : prior.summary;
      const liveTokens = new Set(normalizeText(liveText).split(/\s+/).filter(Boolean));
      const archTokens = new Set(normalizeText(archText).split(/\s+/).filter(Boolean));
      if (liveTokens.size === 0 || archTokens.size === 0) continue;
      let shared = 0;
      for (const t of liveTokens) if (archTokens.has(t)) shared++;
      const overlap = Number((shared / Math.max(1, Math.min(liveTokens.size, archTokens.size))).toFixed(3));
      if (overlap >= minOverlap) continue;
      const liveEntities = JSON.parse(row.entities_json || '[]') as string[];
      const archEntities = JSON.parse(prior.entities_json || '[]') as string[];
      const lowered = new Set(archEntities.map((e) => e.toLowerCase()));
      suspicious.push({
        id: row.id,
        liveSummary: sanitizeMemoryText(row.summary).slice(0, 100),
        archived: {
          version: prior.version,
          summary: sanitizeMemoryText(prior.summary).slice(0, 100),
          archivedAt: prior.archived_at ?? null
        },
        overlap,
        entitiesLive: liveEntities,
        entitiesArchived: archEntities,
        sharedEntities: liveEntities.filter((e) => lowered.has(e.toLowerCase()))
      });
    }

    suspicious.sort((a, b) => a.overlap - b.overlap);
    return {
      suspicious: suspicious.slice(0, limit),
      scannedOverridden,
      note:
        'Read-only screen. Rows version > 1 whose archived revision shares little wording with the live text — ' +
        'the signature of an unrelated memory being retired by an override. Low overlap is a heuristic prompt for ' +
        'review, not proof. Recover the archived text with memory_maintain history <id>.'
    };
  }


  /* ============================ source monitoring ============================ */

  /** Polarity of a text: does it assert the negative form of its subject? */
  private polarityOf(text: string): boolean {
    return NEGATION_RE.test(text);
  }

  /** Render a RelatedTrace (sanitized — injection guard applies at every exit). */
  private toRelated(r: MemoryRow, sim: number): RelatedTrace {
    return {
      id: r.id,
      summary: sanitizeMemoryText(r.summary),
      detail: r.detail ? sanitizeMemoryText(r.detail) : undefined,
      source: r.source ? sanitizeMemoryText(r.source) : undefined,
      verifyResult: r.verify_result === 'pass' || r.verify_result === 'fail' ? r.verify_result : undefined,
      confidence: r.confidence,
      version: r.version,
      updatedAt: r.updated_at,
      entities: JSON.parse(r.entities_json || "[]") as string[],
      scope: r.scope ?? undefined,
      similarity: sim
    };
  }

  /**
   * Does this row state the SAME THING the claim states — as opposed to merely
   * living near it? Two of the four `recallAnchors` tiers qualify: an
   * identifier both sides carry (a ticket, a version, an address), or the
   * subject of a structured claim the claim repeats. `entity` and `vocabulary`
   * do not.
   *
   * The census that drew this line (`.hippo/panel-g1-scope-round23k.mjs`, 24
   * premise shapes run against both the previous build and this one, in both
   * embedding spaces): the panel case "strong scope-less support, weak
   * anchored conflict" — a verbatim restatement at 0.93 hashing / 0.98 bge with
   * no premise, and a row about `api latency budget` under `region=us-east` at
   * 0.40 / 0.70 — vetoed the exact match when the route accepted the entity
   * tier. `api` is a TOPIC: a store that has ever recorded two facts about one
   * service shares that token across all of them, so an entity is not evidence
   * that the two texts state one claim under two conditions, which is the only
   * thing this veto is for. Anchors are read on the RAW stored text for the
   * same reason D1 reads them raw: sanitizing can hollow a summary out and
   * erase the subject being asked about.
   */
  private sameThingAnchor(claim: string, r: MemoryRow): boolean {
    return recallAnchors(claim, {
      summary: r.summary,
      entities: JSON.parse(r.entities_json || '[]') as string[]
    }).some((a) => a === 'identifier' || a === 'subject');
  }

  /** True when two entity sets share at least one name (case-insensitive). */
  private entitiesOverlap(a: string[], b: string[]): boolean {
    if (a.length === 0 || b.length === 0) return false;
    const sa = new Set(a.map((x) => x.toLowerCase()));
    for (const x of b) if (sa.has(x.toLowerCase())) return true;
    return false;
  }

  /**
   * Prefrontal stand-in for the agent '"should I assert this?"' check.
   * Verdict plus the evidence the old version silently dropped:
   *   - contradicting[]: same-scope rows asserting the opposite polarity
   *   - newer_related[]: newer rows on the same scope (stale-support check)
   *   - superseded_matches[]: rows retired via an explicit supersedes edge
   *   - stale_support: the top support is NOT the newest word on its scope
   *   - out_of_scope: the support holds under premises the claim does not
   *     share (see MemoryPayload.scope) — pass `opts.scope` to have the
   *     engine compare them and prefer the trace stated under your premises.
   *     A conflicting-scope row that matches the claim as well as the support
   *     vetoes even when it did not win the support slot.
   *   - weak_match: something nearby cleared the recall floor but carries no
   *     anchor for THIS claim, so the verdict is not a yes (see `substantiated`).
   */
  async sourceMonitor(claim: string, opts: { scope?: string } = {}): Promise<{
    substantiated: boolean;
    contradicted: boolean;
    /** True when the closest trace is stated under premises that disagree with `opts.scope`. */
    out_of_scope: boolean;
    /**
     * True when a trace cleared the RECALL floor and nothing anchors the claim
     * to it. Not a yes and not an empty store: the closest trace is attached as
     * `support`, labelled, for inspection only (field report D1).
     */
    weak_match: boolean;
    /**
     * Same-subject rows that state a premise conflicting with `opts.scope` and
     * match the claim at least as well as the chosen support. Non-empty is what
     * makes the verdict OUT_OF_SCOPE: these are the traces that would have been
     * the answer had the caller asked under their premises.
     */
    scope_conflicts: RelatedTrace[];
    support?: { id: string; summary: string; detail?: string; verifyResult?: 'pass' | 'fail'; verifiedAt?: string; source?: string; confidence: string; version: number; score: number; scope?: string } | null;
    contradiction?: { id: string; summary: string; detail?: string; verifyResult?: 'pass' | 'fail'; verifiedAt?: string; source?: string; confidence: string; version: number; score: number; scope?: string } | null;
    closest?: { id: string; summary: string; detail?: string; verifyResult?: 'pass' | 'fail'; verifiedAt?: string; source?: string; confidence: string; version: number; score: number; scope?: string } | null;
    /** Rows whose premise agrees with the checked scope (or that state none) and assert the opposite polarity of the claim. */
    contradicting: RelatedTrace[];
    /** Newer premise-agreeing rows sharing the claim's subject (the support may be stale). */
    newer_related: RelatedTrace[];
    /** Retired rows whose superseded_by points at a matched row. */
    superseded_matches: RelatedTrace[];
    /** True when the top support has a newer same-scope sibling. */
    stale_support: boolean;
    /**
     * Three-state upgrade of the argmax contract (audit #3): true when the
     * substantiating argmax row is NOT the newest word on its scope, or when
     * a related row asserts the opposite. The boolean verdict stays (an
     * affirming exact match is still support), but a contested yes must be
     * re-checked against whichever of contradicting[] / newer_related[] /
     * superseded_matches[] actually has rows in it. The note names exactly that set
     * and nothing else (R3, round 30: it used to say "Review newer_related" on a
     * store whose only newer disagreement lived in the archived chain, sending the
     * reader to an empty array — the third time this batch met a note asserting a
     * relation the verdict had not computed).
     */
    contested: boolean;
    note: string;
  }> {
    const cueVec = await this.embedOne(claim);
    const claimNegated = this.polarityOf(claim);
    const queryScope = typeof opts.scope === 'string' && opts.scope.trim() ? opts.scope.trim() : undefined;    // Score every comparable row ONCE: the argmax pass and the related-row scan
    // below need the same cosine against the same cue vector. Keeping the pairs
    // around avoids decoding and re-computing the whole store a second time.
    const scored: { r: MemoryRow; sim: number }[] = [];
    for (const r of this.db.allActive()) {
      const b = vecFromBlob(r.vec);
      if (!b || b.length !== cueVec.length) continue;
      scored.push({ r, sim: cosine(b, cueVec) });
    }

    let best: { id: string; summary: string; detail?: string; verifyResult?: 'pass' | 'fail'; verifiedAt?: string; source?: string; confidence: string; version: number; score: number; scope?: string } | undefined;
    let bestSim = -1;
    for (const { r, sim } of scored) {
      if (sim <= bestSim) continue;
      const mem = rowToMemory(r, false);
      best = { id: mem.id, summary: sanitizeMemoryText(mem.summary), detail: mem.detail ? sanitizeMemoryText(mem.detail) : undefined, verifyResult: mem.verifyResult, verifiedAt: mem.verifiedAt, source: mem.source ? sanitizeMemoryText(mem.source) : undefined, confidence: mem.confidence, version: mem.version, score: sim, scope: mem.scope };
      bestSim = sim;
    }

    // Premise-aware support choice: when the caller states the conditions of
    // the claim, a trace stated under THOSE conditions outranks a closer match
    // stated under others (measured failure: an old-scope conclusion at higher
    // similarity answered a new-scope claim, `substantiated: true`). A row that
    // names no premise ranks below it and above everything else — it cannot be
    // wrong for this scope, because it makes a claim about every scope.
    //
    // Round 23 (arm A) put a row keyed on an axis the caller never named in that
    // same band, reasoning that it "cannot be wrong for this scope" either. Round
    // 24 falsified the half that mattered: a premise-free row IS a general
    // statement and a `tenant=acme` row is not, and giving them one rank let a
    // 0.859 keyed restatement take the support seat away from the general trace
    // that should have answered (test #G3-121), which is how the affirm gate came
    // to be reached by a row about nobody's conditions. A row that disagrees with
    // the caller still ranks above a row that never addresses it, because the
    // disagreeing row is evidence about THIS question (#G3-122). Without a caller
    // scope the ordering is untouched.
    if (queryScope) {
      const rank = (r: MemoryRow): number => {
        // R2 (round 30): "states no premise, so it cannot be wrong for this scope" is
        // true, and it is NOT "therefore it is the best answer to this claim". The band
        // used to be unconditional, so a premise-free row about a different subject took
        // the support seat from a row that IS the caller's claim character for character
        // — measured on the installed bytes (`.hippo/repro-r1r2r3-round30b.txt`, bge R2
        // arms): "database vacuum runs nightly at 03:00" at 0.622 beat a verbatim
        // `api timeout -> 30 seconds` under `service=billing` at 0.862 for a caller
        // asking under `cluster=blue`, and because the hijacker's premise is vacuously
        // admissible the veto scan never ran (`supportMeetsScope` reads true for a row
        // that names nothing), so the trace the caller needed appeared in NONE of
        // support / contradicting / newer_related / scope_conflicts. Deleting the two
        // vacuum rows made it reappear at 0.862 as OUT_OF_SCOPE — seat, not score.
        //
        // The fix keeps the reasoning that put #G3-121 and #G3-122 on opposite sides of
        // this list: the seat goes to evidence about THIS question. A premise-free row is
        // that evidence when it states the claim (same subject/value, a shared
        // identifier, or the sentence itself) — then it keeps its band and answers a
        // caller the keyed twin contradicts. A premise-free row about something else is
        // not evidence at all, and ranks with the other rows that do not address the
        // caller, where similarity decides. Measured predicates for every fixture this
        // touches: `.hippo/probe-r2-anchor-round30.txt`.
        if (!r.scope) return this.sameThingAnchor(claim, r) || isVerbatimRestatement(claim, r.summary) ? 1 : -1;
        if (scopeStatesCallerPremise(r.scope, queryScope)) return 2;
        // G3 (round 24): `no difference` and `nothing to compare` are still two
        // different facts, but they are not the same RANK — an off-axis trace is
        // not evidence about the caller's premise at all, so it sits below the
        // row that at least speaks the caller's language and disagrees.
        return scopesComparable(r.scope, queryScope) ? 0 : -1;
      };
      const chosen = scored
        .filter(({ r, sim }) => sim >= this.options.similarityThreshold)
        .sort((a, b) => rank(b.r) - rank(a.r) || b.sim - a.sim)[0];
      if (chosen) {
        const mem = rowToMemory(chosen.r, false);
        best = { id: mem.id, summary: sanitizeMemoryText(mem.summary), detail: mem.detail ? sanitizeMemoryText(mem.detail) : undefined, verifyResult: mem.verifyResult, verifiedAt: mem.verifiedAt, source: mem.source ? sanitizeMemoryText(mem.source) : undefined, confidence: mem.confidence, version: mem.version, score: chosen.sim, scope: mem.scope };
        bestSim = chosen.sim;
      }
    }

    if (!best || bestSim < this.options.similarityThreshold) {
      return {
        substantiated: false,
        contradicted: false,
        out_of_scope: false,
        weak_match: false,
        scope_conflicts: [],
        closest: best ?? null,
        contradicting: [],
        newer_related: [],
        superseded_matches: [],
        stale_support: false,
        contested: false,
        note: `UNSUBSTANTIATED: no stored trace matches this claim (best similarity ${belowFloor(bestSim, this.options.similarityThreshold)} < ${this.options.similarityThreshold}). Do NOT assert it from memory; answer "I don't know / not in my memory".`
      };
    }

    const supportRow = this.db.getById(best.id);
    const supportEntities = supportRow ? (JSON.parse(supportRow.entities_json || "[]") as string[]) : [];

    // Premise mismatch comes before the negation heuristic: judging the claim
    // TRUE or FALSE against a trace stated under other conditions is exactly
    // the silent contamination this field exists to stop.
    //
    // The comparison must cover every row that cleared the floor, not just the
    // one that won support: the premise-aware ranking above deliberately places
    // a scope-less row ABOVE a row whose scope conflicts, so reading only
    // `best.scope` let a conclusion stored under `env=prod` answer a question
    // asked about `env=dev` as `substantiated: true` — with the conflicting row
    // named nowhere in the answer (field report D2). A conflicting row that
    // matches the claim at least as well as the chosen support vetoes the
    // verdict and is named in `scope_conflicts`; a weaker one used to be
    // dropped entirely, which arm B (round 23) showed is not the same as it
    // not being the caller's answer — a 0.486 row that restates the claim's
    // OWN SUBJECT under a premise the caller contradicts is more relevant to
    // this verdict than a 0.689 row that names no premise at all.
    // Similarity WAS the whole relevance anchor here on purpose — entities are
    // optional, and requiring them made the veto inert for every store that
    // writes entity-less rows (opencode's own adapter test caught it) — so the
    // anchor route is added ALONGSIDE the score route, never in place of it:
    // anything that vetoes today still vetoes, and entity-less stores keep
    // vetoing by score plus the subject/identifier tiers. The scan
    // is skipped when the support already STATES the caller's premises — which
    // is not what an empty `scopeDifferences` means for a row on another axis
    // (arm A) — because a row stated under OTHER conditions must not veto an
    // answer that was found under the caller's own.
    const scopeConflicts: RelatedTrace[] = [];
    const supportMeetsScope = scopeStatesCallerPremise(best.scope, queryScope);
    if (queryScope && !supportMeetsScope) {
      for (const { r, sim } of scored) {
        if (r.id === best.id || !r.scope || sim < this.options.similarityThreshold) continue;
        // An empty difference set covers both "the caller's own premise" and
        // "nothing comparable to disagree with" (a premise on another axis),
        // and neither is a conflict — `scopesComparable` is what separates them
        // in the ranking above, where the two read differently.
        if (scopeDifferences(r.scope, queryScope).length === 0) continue;
        // The score route (D2) OR the same-thing route (arm B): matching the
        // support's score is no longer the only way to be heard, but a row has
        // to state the claim's own subject or carry an identifier with it to be
        // heard that way — `sameThingAnchor` says why an entity is not enough.
        //
        // Round 28 (G4) adds the strongest form of "the same thing": the row IS the claim,
        // character for character after normalization. It is measured rather than assumed —
        // `.hippo/probe-g4d-round28.mjs` arm A, the shape the coexistence ruling now
        // produces on purpose: a premise-free row answering at 0.7746 beside a twin that
        // restates the same sentence under `db=primary` at 0.5906, both anchored only by
        // `vocabulary`. Neither old route reaches it, so the answer printed
        // `substantiated` with `scope_conflicts: []` next to a store holding a direct
        // contradiction of the caller's premise — the exemption's own pair invisible to the
        // exit that exists to name it. Same lesson as the F batch, one door later: a
        // promise reachable at only one exit reads as a broken promise.
        //
        // Alongside, never in place of: anything that vetoed before still vetoes.
        if (sim >= bestSim || this.sameThingAnchor(claim, r) || isVerbatimRestatement(claim, r.summary)) scopeConflicts.push(this.toRelated(r, sim));
      }
    }
    const supportDiffers = queryScope && best.scope ? scopeDifferences(best.scope, queryScope) : [];
    // G3 (round 24), the affirm half of the same misreading. A support whose
    // premise shares NO condition with the caller's is not a conflict —
    // `scopeDifferences` is empty for it, and `scopeConflicts` correctly never
    // collects it — and until now "not a conflict, not a restatement" fell
    // through to `substantiated: true`. That is the field report's shape (a): one
    // trace under `tenant=acme`, a claim checked under `cluster=blue`, a yes at
    // 0.846 hashing / 0.909 bge naming no mismatch anywhere in the answer. The
    // shape (b) companion (a third-premise sibling bought `contradicting`,
    // `newer_related` and `stale_support: true` off the same affirm) needs no
    // separate gate: this return happens before the related scan runs.
    //
    // A ranking consequence to keep in view: an off-premise row can only win the
    // seat when nothing comparable OR premise-free cleared the floor, because
    // rank -1 sits below both. When it does, `scopeConflicts` is necessarily
    // empty (it collects rows that disagree on a shared key, i.e. rank 0), so
    // this branch never hides a conflict that was in reach.
    const supportOffPremise = !!queryScope && !!best.scope && !scopeCanSupport(best.scope, queryScope);
    // G4 read-side companion, and the boundary of the coexistence ruling.
    //
    // Refusing the narrowing on the write path CREATES this shape: a premise-free row
    // that is the claim word for word, standing beside a twin that holds one premise.
    // Without an exemption here the twin vetoes the general row — D2's rule applied to
    // the pair the store just produced on purpose — so the ruling would buy a second
    // row and lose the coverage the first one had, and the veto's own wording ("which
    // states no premise answers this no better") would contradict `scopeCanSupport`'s
    // premise-free branch: a trace that names no condition is a GENERAL statement, and
    // a general statement covers the caller's.
    //
    // The exemption is identity, not proximity, and it is the same predicate the write
    // path refuses under. D2's fixture — a scope-less row that merely shares an entity,
    // a DIFFERENT sentence — fails this test and stays vetoed, which is what makes the
    // carve-out a boundary rather than a widening.
    const generalRestatement = !!queryScope && !best.scope && isVerbatimRestatement(claim, best.summary);
    const blocker = supportDiffers.length > 0 || supportOffPremise ? best : generalRestatement ? undefined : scopeConflicts[0];
    const blockerKeys = blocker && queryScope ? scopeDifferences(blocker.scope ?? '', queryScope) : [];
    const blockerOffPremise = !!blocker && blocker === best && supportOffPremise;
    if (blocker && queryScope) {
      const foreign = blocker.id === best.id
        ? ''
        : ` The row matched instead (${best.id}, ${best.scope ? `under "${sanitizeMemoryText(best.scope)}"` : 'which states no premise'}) answers this no better.`;
      // Say WHAT disagrees in the shape the reader can act on. A keyed pair
      // names a field both sides share; an unkeyed premise has no field to
      // name, and "the key(s) unkeyed-premise hold different values" would be
      // a sentence about an internal bucket rather than about the caller's data.
      const namedKeys = blockerKeys.filter((k) => k !== UNKEYED_SCOPE_LABEL);
      const bareKeys = blockerKeys.length !== namedKeys.length;
      const axes = (s?: string | null): string => {
        const { keys, bare } = scopeAxes(s);
        const parts: string[] = [];
        if (keys.length > 0) parts.push(keys.join(', '));
        if (bare) parts.push('an unkeyed condition');
        return parts.length > 0 ? parts.join(' plus ') : 'no key at all';
      };
      const why = blockerOffPremise
        ? `the trace keys only ${axes(blocker.scope)} and the caller states only ${axes(queryScope)}, with no condition named by both`
        : namedKeys.length === 0
          ? 'neither side keys its premise and the two stated conditions name different things'
          : `the key(s) ${namedKeys.join(', ')} hold different values${bareKeys ? ', and the unkeyed premises differ too' : ''}`;
      return {
        substantiated: false,
        contradicted: false,
        out_of_scope: true,
        weak_match: false,
        scope_conflicts: scopeConflicts,
        support: best,
        contradicting: [],
        newer_related: [],
        superseded_matches: [],
        stale_support: false,
        contested: false,
        note:
          `OUT_OF_SCOPE: ${blocker.id} (v${blocker.version}) is stated under "${sanitizeMemoryText(blocker.scope ?? '')}" ` +
          `and the claim was checked under "${sanitizeMemoryText(queryScope)}" — ${why}, ` +
          `so memory neither supports nor refutes the claim here.${foreign} Re-verify under the trace's own premises, ` +
          `or remember the new-scope conclusion with its own scope so both stand side by side.`
      };
    }

    // Negation heuristic on the global argmax.
    // NOTE: negation is tested on the SANITIZED text, so a payload cannot
    // escape contradiction detection by hiding inside a hijack phrase. The
    // ANCHOR below is read on the RAW row for the same reason D1 reads its
    // anchors raw — sanitizing can hollow the summary out to
    // "[sanitized-conceal]friday" and erase the subject being asked about.
    const storedNegated = this.polarityOf(best.summary);
    const infectedNote = best.summary.includes('[sanitized-') ? ' [injection: stored text contained instruction-shaped content — sanitized]' : '';
    const polarityMismatch = claimNegated !== storedNegated;
    const negAnchored = polarityMismatch && polarityAnchored(claim, supportRow?.summary ?? best.summary, supportEntities);
    // R2: an unanchored mismatch is not a verdict, but it is not nothing either.
    // The opposite-polarity trace stays visible as a lead, and the belt on the
    // anchor gate below keeps it from being read as support instead.
    const oppositePolarityNote = polarityMismatch && !negAnchored
      ? ` NOTE: a nearby trace asserts the OPPOSITE polarity (${best.summary.slice(0, 60)} [v${best.version}]) while nothing anchors the two texts to one subject — a coincidence of negation, not a proven conflict.`
      : '';
    if (polarityMismatch && negAnchored) {
      const bestRow = this.db.getById(best.id);
      return {
        substantiated: false,
        contradicted: true,
        out_of_scope: false,
        weak_match: false,
        scope_conflicts: scopeConflicts,
        contradiction: best,
        contradicting: bestRow ? [this.toRelated(bestRow, bestSim)] : [],
        newer_related: [],
        superseded_matches: [],
        stale_support: false,
        contested: true,
        note: `CONTRADICTED: memory asserts the opposite scope (${best.summary.slice(0, 80)} [v${best.version}]). Do not state the claim without flagging this conflict.${infectedNote}`
      };
    }

    // Value contradiction on the SUPPORT itself: the closest trace binds the
    // same subject to a DIFFERENT value than the claim asks to confirm. argmax
    // alone reads this as support (same subject, high cosine, same polarity) —
    // it is the opposite, and this is the one row the related-scan below skips
    // (it excludes best.id). One value containing the other is a refinement,
    // not a clash (`postgres` vs `postgres 15`), so those still substantiate.
    // Field report R1: this used to demand `claimParts()` on BOTH sides, and
    // that parser only knows `主体 -> 值` plus English copulas, so a Chinese claim
    // silently skipped the check and the wrong value got stamped SUBSTANTIATED.
    // `valueFlip` now keeps the comparison alive when one side or both are
    // unreadable prose.
    const claimClaim = claimParts(claim);
    const flip = valueFlip(claim, best.summary);
    if (flip) {
      const bestRow = this.db.getById(best.id);
      // The claim restates the OLD value of a row that has since moved on:
      // the live row contradicts it, but the archived revision that said
      // exactly this must stay reachable (S2) — a contradiction verdict with
      // an empty history would tell the caller "never held", which is a lie.
      const normClaimHere = normalizeText(stripAbstractPrefix(claim));
      const archMatches: RelatedTrace[] = [];
      if (bestRow) {
        for (const h of this.db.historyOf(best.id)) {
          if (normalizeText(stripAbstractPrefix(h.summary as string)) !== normClaimHere) continue;
          archMatches.push({
            id: best.id,
            summary: sanitizeMemoryText(h.summary as string),
            source: undefined,
            confidence: (best.confidence ?? 'medium') as 'high' | 'medium' | 'low' | 'speculative',
            version: Number(h.version),
            updatedAt: (h.archived_at as string) ?? '',
            entities: [],
            similarity: 1
          });
        }
        // Rows explicitly retired by (or into) the live row: the correction
        // chain must survive the contradiction verdict too, or asking the old
        // wording would report "never held" while the store still holds it.
        for (const r of this.db.supersededBy(best.id)) {
          archMatches.push(this.toRelated(r, 0));
        }
      }
      const archNote = archMatches.length > 0
        ? ` NOTE: this claim matches archived v${archMatches.map((s) => s.version).join(',v')} of ${best.id.slice(0, 8)} (retired revisions included) — the live row says otherwise. See superseded_matches.`
        : '';
      return {
        substantiated: false,
        contradicted: true,
        out_of_scope: false,
        weak_match: false,
        scope_conflicts: scopeConflicts,
        contradiction: best,
        contradicting: bestRow ? [this.toRelated(bestRow, bestSim)] : [],
        newer_related: [],
        superseded_matches: archMatches,
        stale_support: false,
        contested: true,
        note: `CONTRADICTED: memory binds "${flip.subject}" to "${sanitizeMemoryText(flip.stored)}" (v${best.version}), not "${sanitizeMemoryText(flip.claimed)}". The closest trace states a different value — do not assert the claim.${infectedNote}${archNote}`
      };
    }

    // ---- P0-1: the scan the old version never did ----
    // Related active rows: entity-overlapping OR clearing the similarity floor.
    // Reuses the scores computed above — no second decode/cosine pass, and the
    // support row/entities were already resolved for the premise scan above.
    //
    // Premise filter (F2, black-box report #3): a related row is evidence about
    // the scope being asked about, so a row stating a premise that DISAGREES
    // with it is not evidence at all. The anchor is the caller's scope, or the
    // support's own premise when the caller stated none — reaching this point
    // means the two already agree (a disagreeing support was vetoed above).
    // A row that states no premise is never excluded for disagreement: a
    // premise-free correction is still a correction (guard test F2 guard: a
    // newer premise-free row still ages the support). Without the filter an
    // eu-west trace made a us-east verdict "stale", and the note claimed a
    // newer trace existed "on this scope" while naming a row that proved the
    // opposite condition.
    //
    // G3 (round 24) deliberately does NOT extend this keep-test to
    // `scopeCanSupport`, even though it reads the same empty difference set the
    // affirm path did. The two sites ask opposite questions. The affirm gate
    // promotes a row to CERTIFICATION, so a row that shares no condition with the
    // caller must be refused — that is the dangerous side. This filter feeds
    // `contradicting` / `newer_related` / the archive tiers, which are
    // downgrade-only: dropping an off-axis row here would delete a warning that
    // might be real (a premise-free support restated under one axis while a
    // newer row on another says otherwise is the case the reporter's own D-shape
    // census calls a correction), and the batch's standing lesson is that
    // narrowing one exit without a belt converts a false verdict into a false
    // verdict on the dangerous side. Test #G3-125 pins that residual open. The
    // reported false staleness needs no help from here: an off-axis SUPPORT now
    // returns before this scan runs (#G3-119, #G3-120).
    const premiseAnchor = queryScope ?? supportRow?.scope ?? undefined;
    const related = supportRow
      ? scored
          .filter(({ r }) => r.id !== best.id)
          .filter(({ r, sim }) => sim >= this.options.similarityThreshold || this.entitiesOverlap(supportEntities, JSON.parse(r.entities_json || '[]') as string[]))
          .filter(({ r }) => !premiseAnchor || !r.scope || scopeDifferences(r.scope, premiseAnchor).length === 0)
          .sort((a, b) => b.sim - a.sim)
          .slice(0, 8)
      : [];

    // (a) contradictions among related rows — entity-anchored.
    // A contradiction needs a SHARED ENTITY with the support row PLUS a real
    // textual disagreement (opposite polarity or the same subject bound to a
    // different value). Similarity alone is not opposition, and neither is a
    // prose-derived subject match: claimParts extracts subjects from ordinary
    // prose too, so same-subject-without-shared-entity collides between
    // unrelated sentences (field report BUG-1 (a), seen again in round 8:
    // verifying an archived value flagged entity-disjoint rows at 0.6 sim).
    const supportClaim = supportRow ? claimParts(supportRow.summary) : null;
    const contradicting = related
      .filter(({ r }) => {
        const rowEntities = JSON.parse(r.entities_json || '[]') as string[];
        if (!this.entitiesOverlap(supportEntities, rowEntities)) return false;
        const rowClaim = claimParts(r.summary);
        const oppositePolarity = this.polarityOf(r.summary) !== claimNegated;
        const valueDisagrees =
          !!(supportClaim && rowClaim && rowClaim.subject === supportClaim.subject && valueClash(rowClaim.value, supportClaim.value)) ||
          !!(claimClaim && rowClaim && rowClaim.subject === claimClaim.subject && valueClash(rowClaim.value, claimClaim.value));
        return oppositePolarity || valueDisagrees;
      })
      .map(({ r, sim }) => this.toRelated(r, sim));

    // (b) newer same-scope rows — the support may be stale. Being newer and
    // merely clearing the cosine floor is NOT a correction (round 9 field
    // report: 24/38 contested flags were newer-but-unrelated topical siblings,
    // e.g. notif-queue flagged by an unrelated export-worker-queue row). A
    // newer neighbour only makes the support stale when it is about the SAME
    // subject: it must share an entity with the support row (the structural
    // subject anchor), and — when BOTH sides yield a structured claim — bind
    // that subject to a DIFFERENT value. Prose corrections ("X switched to Y")
    // carry no extractable value, so same-entity + newer + different-text is
    // the strongest signal available and is treated as stale.
    const newerRelated = related
      .filter(({ r }) => (supportRow ? r.updated_at > supportRow.updated_at : false))
      .filter(({ r }) => {
        const rowEntities = JSON.parse(r.entities_json || '[]') as string[];
        if (!this.entitiesOverlap(supportEntities, rowEntities)) return false;
        const rowClaim = claimParts(r.summary);
        // Both sides structured on the same subject: require a real value clash
        // so a reworded restatement of the same value is not called stale.
        if (rowClaim && supportClaim && rowClaim.subject === supportClaim.subject) {
          return valueClash(rowClaim.value, supportClaim.value);
        }
        if (rowClaim && claimClaim && rowClaim.subject === claimClaim.subject) {
          return valueClash(rowClaim.value, claimClaim.value);
        }
        // Prose (no structured claim to compare): same-entity newer trace stands.
        return true;
      })
      .map(({ r, sim }) => this.toRelated(r, sim));

    // (c) retired rows whose supersedes edge points at the support
    const supersededMatches = supportRow ? this.db.supersededBy(best.id).map((r) => this.toRelated(r, 0)) : [];

    // (d) archived-revision matches (suggestion 2 + 模糊检索): the claim may
    // restate an OLD version of a row whose live text moved on ("what was it
    // last round?"). Version history is the one place recall never looks, so
    // say so explicitly instead of blessing the old number against the new
    // row. Two tiers: exact restatement (similarity 1), and same-subject
    // value flips found structurally with similarity re-measured against the
    // claim (bounded extra embeds — history has no stored vectors).
    const normClaim = normalizeText(stripAbstractPrefix(claim));
    const archiveRows: { id: string; row: MemoryRow }[] = [];
    if (supportRow) archiveRows.push({ id: supportRow.id, row: supportRow });
    for (const { r } of related) archiveRows.push({ id: r.id, row: r });
    let fuzzyLeft = 8;
    for (const { id, row } of archiveRows) {
      const live = this.db.getById(id);
      const liveNorm = live ? normalizeText(stripAbstractPrefix(live.summary)) : null;
      const liveClaim = live ? claimParts(live.summary) : null;
      // Fuzzy-tier relevance anchor (round-9 field report: a notif-queue verify
      // pulled deploy-target/export-worker archives at ~0.59 sim). The fuzzy
      // branch below re-embeds an archived revision and admits it on cosine
      // alone, so an unrelated subject that merely flipped its own value can
      // clear the floor against this claim. Require the row to share an entity
      // with the support (the structural subject anchor) unless it IS the
      // support row — the exact-restatement tier stays unguarded because a
      // literal text match is decisive on its own.
      const rowEntities = JSON.parse(row.entities_json || '[]') as string[];
      const fuzzyRelevant = id === best.id || this.entitiesOverlap(supportEntities, rowEntities);
      for (const h of this.db.historyOf(id)) {
        const archNorm = normalizeText(stripAbstractPrefix(h.summary as string));
        const archClaim = claimParts(h.summary as string);
        if (archNorm === normClaim) {
          if (liveNorm === normClaim) continue; // live already says it
          supersededMatches.push({
            id,
            summary: sanitizeMemoryText(h.summary as string),
            source: undefined,
            confidence: (live?.confidence ?? 'medium') as 'high' | 'medium' | 'low' | 'speculative',
            version: Number(h.version),
            updatedAt: (h.archived_at as string) ?? '',
            entities: [],
            similarity: 1,
            verifyResult: (h.verify_result as string | null) === 'pass' || (h.verify_result as string | null) === 'fail'
              ? (h.verify_result as 'pass' | 'fail')
              : undefined
          });
          continue;
        }
        // Fuzzy tier: the archived revision binds the same subject to a
        // different value than the live row (or the claim) holds — a reworded
        // "last round" question. Relevance comes from the row already being
        // in the related set AND sharing an entity with the support; the score
        // is re-measured, never invented.
        if (fuzzyLeft <= 0 || !fuzzyRelevant) continue;
        const flipVsLive = !!(liveClaim && archClaim && archClaim.subject === liveClaim.subject && archClaim.value !== liveClaim.value);
        const flipVsClaim = !!(claimClaim && archClaim && archClaim.subject === claimClaim.subject && archClaim.value !== claimClaim.value);
        if (!(flipVsLive || flipVsClaim) || archNorm === liveNorm) continue;
        fuzzyLeft--;
        const avec = await this.embedOne(h.summary as string);
        const asim = avec.length === cueVec.length ? cosine(avec, cueVec) : 0;
        if (asim < this.options.similarityThreshold) continue;
        supersededMatches.push({
          id,
          summary: sanitizeMemoryText(h.summary as string),
          source: undefined,
          confidence: (live?.confidence ?? 'medium') as 'high' | 'medium' | 'low' | 'speculative',
          version: Number(h.version),
          updatedAt: (h.archived_at as string) ?? '',
          entities: [],
          similarity: Number(asim.toFixed(3)),
          verifyResult: (h.verify_result as string | null) === 'pass' || (h.verify_result as string | null) === 'fail'
            ? (h.verify_result as 'pass' | 'fail')
            : undefined
        });
      }
    }

    const staleSupport = newerRelated.length > 0 || supersededMatches.length > 0;
    // R3 (round 30) — the third round the same SHAPE was reported on this gate (G3 fixed a
    // false conflict, F2 a false "assert the OPPOSITE"; this is a REAL flag wearing the
    // wrong label). `staleSupport` has two causes and the note named one of them
    // unconditionally, so an archived revision of the support — the ordinary consequence of
    // an `override`, where nothing is newer than the live row — printed "Review
    // newer_related" over `newer_related: []` while the evidence sat in
    // `superseded_matches`. Measured on the installed bytes in both embedding spaces
    // (`.hippo/repro-r1r2r3-round30b.txt`, R3 arm): `stale=true contested=true
    // newer_related=[] superseded_matches=… 0.684`, note "Review newer_related".
    // A pointer to an empty array is worse than no pointer: the caller checks the array,
    // finds nothing, and concludes the flag was raised in error. Each cause gets its own
    // wording, and only the `newer_related` cause points at `newer_related` — the archived
    // cause is already named twice over below (`archiveNote`/`fuzzyNote` say
    // "see superseded_matches", and `contestedNote` now lists only populated arrays), so
    // repeating the pointer here would be noise rather than information. Both wordings are
    // pinned in `test/scope.test.mjs` so neither cause can be dropped to make a test pass.
    const staleNote = !staleSupport
      ? ''
      : newerRelated.length > 0
        ? ' WARNING: a NEWER trace exists — the support above may be outdated. Review newer_related before asserting.'
        : ' WARNING: an ARCHIVED revision of the support stands behind it — the row above may be outdated.';
    const contradictNote = contradicting.length > 0
      ? ` WARNING: ${contradicting.length} related trace(s) assert the OPPOSITE of this claim — review contradicting[] before asserting.`
      : '';
    const archiveHits = supersededMatches.filter((s) => s.similarity === 1);
    const archiveNote = archiveHits.length > 0 && archiveHits[0]
      ? ` NOTE: this claim matches archived v${archiveHits.map((s) => s.version).join(',v')} of ${archiveHits[0].id.slice(0, 8)} — the live row says otherwise. See superseded_matches.`
      : '';
    const fuzzyHits = supersededMatches.filter((s) => s.similarity !== 1);
    const fuzzyNote = fuzzyHits.length > 0 && fuzzyHits[0]
      ? ` NOTE: ${fuzzyHits.length} archived revision(s) bind the same subject to a different value — see superseded_matches for what it used to say.`
      : '';
    // Stale-evidence flag (保鲜期): the support's proof outlived its TTL —
    // treat the standing as ASSERTED and say when it was last run.
    const staleEvidenceNote =
      supportRow &&
      supportRow.verify_result === 'pass' &&
      !evidenceFresh(supportRow.verify_result, supportRow.verified_at, Date.now(), this.options.evidenceTtlSec)
        ? ` NOTE: support evidence is stale (last run ${supportRow.verified_at ?? 'unstamped'}) — re-run before trusting.`
        : '';

    // Unchecked premise: the support is conditional and the caller never said
    // which condition it is asking about. Substantiating it silently would be
    // the same contamination in the other direction, so name the premise and
    // say it was not compared.
    const premiseNote = supportRow?.scope
      ? queryScope
        ? ''
        : ` NOTE: CONDITIONAL SCOPE — the support holds only under "${sanitizeMemoryText(supportRow.scope)}" and the claim stated no scope, so that premise was not checked. Pass verify's scope argument to compare it.`
      : queryScope
        ? ` NOTE: the support states no scope — its premise could not be checked against "${sanitizeMemoryText(queryScope)}".`
        : '';

    // G4, seen from the affirm side. The general row answers the caller, and the twin that
    // holds a premise the caller contradicts is still named here: an empty `scope_conflicts`
    // next to a yes would read as "nothing in the store disagrees", which is not what the
    // pair holds. The twin is not a refutation either — it says the same sentence, only
    // under a condition the caller did not state.
    const twinPremiseNote =
      generalRestatement && scopeConflicts.length > 0
        ? ` NOTE: ${scopeConflicts.length} sibling trace(s) restate this SAME sentence under a premise the caller contradicts (${scopeConflicts
            .slice(0, 3)
            .map((c) => `"${sanitizeMemoryText(c.scope ?? '')}"`)
            .join(', ')}) — they hold only under their own condition, and the general row is the one that covers the caller's.`
        : '';

    // Audit #3: the argmax contract stays (an affirming match substantiates),
    // but the verdict is no longer a bare boolean — when the support is not
    // the newest word on its scope, or a related row disagrees, the caller
    // must treat the yes as contested and read the neighbourhood evidence.
    const contested = staleSupport || contradicting.length > 0;
    // R3, same attribution rule as `staleNote`: name the arrays that are populated, never a
    // pair of empty ones. `contested` is the field a caller reads to decide whether to
    // re-check, so a pointer to `contradicting[] / newer_related[]` on a store where both
    // are empty and the archived revision holds the evidence teaches the caller to ignore
    // the flag.
    const contestedFields = [
      contradicting.length > 0 ? 'contradicting[]' : null,
      newerRelated.length > 0 ? 'newer_related[]' : null,
      supersededMatches.length > 0 ? 'superseded_matches[]' : null
    ].filter(Boolean);
    const contestedNote = contested
      ? ` CONTESTED: this yes is disputed — weigh ${contestedFields.join(' and ')} before asserting.`
      : '';

    // Field report D1: a bare `substantiated: true` at sim 0.47 certified
    // "Python 是用来煮咖啡的" against a row about which language the backend uses.
    // The verdict asked "did anything clear the RECALL floor?" while the tool
    // promises a claim-level answer, and `claimThreshold` — published by this
    // same store's `diagnostics().thresholds` — was consulted only on the write
    // path. Raising the floor is not the fix: measured claim-to-summary cosine
    // in the hashing space is 0.444 for that hallucination and 0.444 for a
    // legitimate paraphrase of the same fact, so the number cannot tell them
    // apart. An ANCHOR can, so the yes now requires one:
    //   - both sides parse to the same subject with a compatible value,
    //   - an identifier (ticket id, sha, version) appears in both,
    //   - the trace carries the claim verbatim, or nearly all of its distinctive
    //     wording,
    //   - claim-to-summary cosine clears `claimThreshold`.
    // The anchors read the RAW stored text on purpose: sanitizing is a rendering
    // concern, and it can hollow a summary out to "[sanitized-conceal]friday" —
    // erasing the very wording the caller is asking about. Contradiction
    // detection keeps the sanitized text, where a payload must not get to hide.
    // Without an anchor the trace is still shown — as a lead, never as evidence.
    const rawSummary = supportRow?.summary ?? best.summary;
    const rawContent = supportRow
      ? [supportRow.summary, supportRow.detail ?? ''].filter(Boolean).join(' ')
      : best.summary;
    const rawClaim = claimParts(rawSummary);
    const structurallyAgrees =
      !!claimClaim && !!rawClaim && claimClaim.subject === rawClaim.subject && !valueClash(claimClaim.value, rawClaim.value);
    const sharesIdentifier = literalOverlap(claim, rawSummary) > 0 || literalOverlap(claim, supportRow?.detail ?? '') > 0;
    const normRawClaim = normalizeText(stripAbstractPrefix(claim));
    const restatesVerbatim =
      normRawClaim.length >= 12 &&
      (normalizeText(stripAbstractPrefix(rawSummary)) === normRawClaim ||
        normalizeText(stripAbstractPrefix(rawContent)).includes(normRawClaim));
    const distinctive = tokenize(claim).filter((t) => t.length >= 6);
    const traceTokens = new Set(tokenize(rawContent));
    const carriesTheWording =
      distinctive.length > 0 &&
      distinctive.filter((t) => traceTokens.has(t)).length / distinctive.length >= this.options.claimThreshold;
    // Each side naming a label the other does not means the two texts are about
    // different things, no matter how much wording they share — `2024-05-01` vs
    // `2024-05-02` differ in one character and are two releases. Requiring it on
    // BOTH sides is what keeps a trace's extra detail from vetoing a partial
    // restatement, which R1 ruled support. This is the belt that keeps the R3 fix
    // from trading a false CONTRADICTED for a false SUBSTANTIATED: `KAPPA-2
    // record` against a `KAPPA-1 record` row covers the claim's only distinctive
    // token (`record`) and would anchor a yes at sim 0.48.
    const claimIds = identifierTokens(claim);
    const traceIds = identifierTokens(rawContent);
    const claimOnly = [...claimIds].filter((t) => !traceIds.has(t));
    const traceOnly = [...traceIds].filter((t) => !claimIds.has(t));
    const identifierMismatch = claimOnly.length > 0 && traceOnly.length > 0;
    // V1 belt: the value slot itself differs and neither parser could read it, so
    // every anchor below is certifying a value it never looked at. Attribution was
    // measured, not assumed (.hippo/probe-anchor-name.mjs against an instrumented
    // copy of dist): six of the eight census shapes ride claim-to-summary
    // similarity, three ride the trace carrying the claim's wording — that one is
    // reachable because `carriesTheWording` counts only tokens of >= 6 characters,
    // so a value like `9999` or `eu-west` (split past the hyphen) is invisible to
    // it while the context words around it are not.
    const valueSwap = wordFlip(claim, rawSummary);
    const hollowSwap = fillerSwap(claim, rawSummary);
    let claimToSummarySim: number | null = null;
    if (!structurallyAgrees && !sharesIdentifier && !restatesVerbatim && !carriesTheWording) {
      const sv = await this.embedOne(rawSummary);
      claimToSummarySim = sv.length === cueVec.length ? cosine(sv, cueVec) : null;
    }
    const anchoredBy = structurallyAgrees
      ? 'the same subject and value'
      : sharesIdentifier
        ? 'a shared identifier'
        : restatesVerbatim
          ? 'a verbatim restatement of the trace'
          : carriesTheWording
            ? 'the trace carrying the claim wording'
            : claimToSummarySim !== null && claimToSummarySim >= this.options.claimThreshold
              ? `claim-to-summary similarity ${claimToSummarySim.toFixed(2)} ≥ ${this.options.claimThreshold}`
              : null;
    // R2 belt: the anchor gate is the last chance to catch a polarity the
    // negation branch gave up on, and a yes is the one verdict that must never
    // be handed out against the trace the caller is pointing at.
    // R3 adds the other way an anchor can be real and still irrelevant.
    const anchored = anchoredBy !== null && !polarityMismatch && !identifierMismatch && !valueSwap && !hollowSwap;
    const overriddenBy: string[] = [];
    if (polarityMismatch)
      overriddenBy.push('they assert OPPOSITE polarities, so this trace refutes the claim rather than supporting it');
    if (identifierMismatch)
      overriddenBy.push(
        `the trace names ${traceOnly.slice(0, 3).join(', ')} while this claim names ${claimOnly
          .slice(0, 3)
          .join(', ')} — different identifiers, so the shared wording is about another thing`
      );
    if (valueSwap)
      overriddenBy.push(
        valueSwap.subjectSwap
          ? `what this claim puts first — "${valueSwap.claimed}" — the trace puts first "${valueSwap.stored}", and nothing but connectives stands before that slot: the wording matches up to that one word because it is the same sentence shape about a different thing, not because it agrees on a value`
          : `the trace binds this subject to "${valueSwap.stored}" where this claim binds it to "${valueSwap.claimed}" — the wording matches up to that one word, so what it shares is the shape of the sentence, not the value`
      );
    if (hollowSwap)
      overriddenBy.push(
        hollowSwap.positional
          ? `the trace states this subject as "${hollowSwap.stored}" where this claim states it as "${hollowSwap.claimed}" — the two values match word for word except at one connective slot, so what agrees is the shape of the sentence, not the value`
          : `the trace states this subject as "${hollowSwap.stored}" where this claim states it as "${hollowSwap.claimed}", and the two values share no comparable terms — what matches is the shape of the sentence, not the value`
      );
    if (!anchored) {
      return {
        substantiated: false,
        contradicted: false,
        out_of_scope: false,
        weak_match: true,
        scope_conflicts: scopeConflicts,
        support: best,
        contradicting,
        newer_related: newerRelated,
        superseded_matches: supersededMatches,
        stale_support: staleSupport,
        contested,
        note:
          `WEAK_MATCH: ${best.id} (v${best.version}) clears the recall floor (sim ${bestSim.toFixed(2)} ≥ ${this.options.similarityThreshold}) ` +
          (anchoredBy === null
            ? `but nothing anchors it to this claim — no agreeing subject/value, no shared identifier, the trace does not carry the ` +
              `claim's wording, and claim-to-summary similarity ` +
              `${claimToSummarySim === null ? 'not measured' : belowFloor(claimToSummarySim, this.options.claimThreshold)} is below the claim bar ${this.options.claimThreshold}. `
            : `and ${anchoredBy} ties the two texts together, but ${overriddenBy.join('; ')}. `) +
          `NOT substantiated: memory is merely on the same topic. Read support as a lead to re-check, never as evidence for the claim.` +
          `${oppositePolarityNote}${infectedNote}${staleNote}${contradictNote}${archiveNote}${fuzzyNote}${premiseNote}${twinPremiseNote}${contestedNote}`
      };
    }

    return {
      substantiated: true,
      contradicted: false,
      out_of_scope: false,
      weak_match: false,
      scope_conflicts: scopeConflicts,
      support: best,
      contradicting,
      newer_related: newerRelated,
      superseded_matches: supersededMatches,
      stale_support: staleSupport,
      contested,
      note: `SUBSTANTIATED: matches ${best.id} (v${best.version}, sim ${bestSim.toFixed(2)}).${infectedNote}${staleNote}${contradictNote}${archiveNote}${fuzzyNote}${staleEvidenceNote}${premiseNote}${twinPremiseNote}${contestedNote}`
    };
  }
  /* ============================ context gating ============================ */

  /**
   * Working-memory gate: builds the compact memory context for the current
   * goal — goal-relevant traces first, optionally a few recent ones as a
   * recency buffer, each with provenance and confidence tags so the LLM can
   * weigh them (and knows when something is a *guess* of retrieval).
   */
  async composeContext(
    goal: string,
    opts: { limit?: number; includeRecent?: boolean; recentLimit?: number; lowConfidenceTop1?: boolean } = {}
  ): Promise<{ context: string; items: RetrievedMemory[]; warnings: string[] }> {
    const limit = opts.limit ?? 6;
    const rec = await this.recall({ query: goal }, limit);
    const hits = [...rec.hits];
    const warnings = [...rec.warnings];
    const tagNow = Date.now();
    this.digestCoverage.turns += 1;
    if (hits.length === 0) this.digestCoverage.misses += 1;
    // F4b (black-box report #4): a row that shares no identifier, entity, claim
    // subject or word with the cue is close in vector space and nothing more —
    // it must not crowd out the rows that answer the question. The withheld set
    // stays in `recall` (flagged, not deleted) and is named here, so the drop is
    // visible. When NOTHING is anchored the block still renders: an unanchored
    // lead beats silence, which is how this gate has always failed visibly.
    const quiet = hits.filter((h) => !h.anchored);
    const items = hits.length - quiet.length > 0 ? hits.filter((h) => h.anchored) : hits;
    const brief = (h: RetrievedMemory) =>
      `${h.id.slice(0, 8)} "${sanitizeMemoryText(h.summary).slice(0, 60)}" sim ${h.similarity.toFixed(2)}`;
    if (quiet.length > 0 && items.length !== hits.length) {
      warnings.push(
        `unanchored: withheld ${quiet.length} hit(s) that share no identifier, entity, claim subject or word with the cue — vector neighbours, not answers: ${quiet
          .map(brief)
          .join('; ')}`
      );
    } else if (quiet.length > 0) {
      warnings.push(
        `unanchored: all ${quiet.length} injected hit(s) rest on vector proximity alone (no shared identifier, entity, claim subject or word) — leads to verify, not memory: ${quiet
          .map(brief)
          .join('; ')}`
      );
    }

    /** One rendered line per memory; the only place the digest format lives. */
    const renderLine = (m: RetrievedMemory, i: number): string => {
      const prov = m.source ? ` [source: ${sanitizeMemoryText(m.source)}]` : '';
      const conf = m.confidence === 'high' ? '' : ` [conf:${m.confidence}]`;
      // F4: the suffix reported the KIND ("semantic") whenever the row was
      // semantic, which read as "this is a consolidation product". It marks the
      // engine's own provenance tag now, and says so in the reader's words.
      const kind = `[${m.kind}${m.consolidated ? '+consolidated' : ''}]`;
      const occ = m.occurredAt ? ` (at ${m.occurredAt})` : '';
      // A guess carries no standing: it never cleared the floor, so it may not
      // borrow VERIFIED/ASSERTED from the row it happens to be. Audit #5: the
      // engine never executes verify commands, so a reported pass is labelled
      // by its trust tier — attested runs get the bare badge, self-reported
      // passes are marked as such (the write-path shield degrades the same way).
      const standing = m.lowConfidence
        ? ` [low-confidence sim ${belowFloor(m.similarity, rec.threshold)} < floor ${rec.threshold}: the closest trace, not a memory — verify before asserting]`
        : evidenceFresh(m.verifyResult, m.verifiedAt, tagNow, this.options.evidenceTtlSec)
          ? m.verifyAttested
            ? ' [VERIFIED]'
            : ' [VERIFIED self-reported]'
          : m.kind === 'semantic'
            ? ' [ASSERTED]'
            : '';
      const guardTag = m.tags.includes('guard') ? ' [GUARD]' : '';
      // F4b: a row that cleared the floor on cosine alone is rendered with the
      // reason it cannot be trusted, so the reader weighs it as a lead.
      const anchorTag = m.anchored || m.recent || m.lowConfidence ? '' : ' [unanchored: vector proximity only]';
      const scopeTag = m.scope ? ` [scope: ${sanitizeMemoryText(m.scope)}]` : '';
      const recentTag = m.recent ? ' [recent]' : '';
      const retrTag = m.retracted ? ` [retracted: ${sanitizeMemoryText(m.retracted.criterion)}]` : '';
      return `${i + 1}. ${kind}${prov}${conf}${occ}${standing}${guardTag}${anchorTag}${scopeTag}${recentTag}${retrTag} v${m.version} ${sanitizeMemoryText(m.summary)}`;
    };

    // Nothing cleared the floor: still show the single closest trace, marked.
    // "Nothing is stored" and "the best match scored 0.31 against your cue" are
    // different answers, and the second one used to be dropped in silence.
    // A similarity of exactly 0 is no overlap at all, so it stays a real miss.
    const near =
      items.length === 0 && rec.reason === 'below-threshold' && opts.lowConfidenceTop1 !== false
        ? rec.nearMisses[0]
        : undefined;
    const guessRow = near && near.similarity > 0 ? this.db.getById(near.id) : undefined;
    const guessMem = guessRow ? rowToMemory(guessRow, false) : null;
    const guessAnchors = guessMem && near ? recallAnchors(goal, guessMem) : [];
    const guess: RetrievedMemory | null = guessMem && near
      ? {
          ...guessMem,
          score: near.similarity,
          similarity: near.similarity,
          relativeScore: 0,
          anchors: guessAnchors,
          anchored: guessAnchors.length > 0,
          consolidated: guessMem.consolidated === true,
          lowConfidence: true
        }
      : null;
    if (guess) {
      this.digestCoverage.guesses += 1;
      warnings.push('low-confidence: the closest sub-threshold trace is shown in the digest as a guess, not a memory — verify before asserting');
    }

    // Fail-visible (suggestion 3): zero hits must render as a status line,
    // not as filler that looks alive. Backfilling [recent] rows here made
    // the channel read healthy while serving the last writes on every cue.
    if (opts.includeRecent && items.length === 0) {
      const n = this.db.countActive();
      warnings.push('includeRecent: no hits to supplement — recency buffer withheld so failure stays visible');
      warnings.push(`no hit cleared the threshold for this task (${n} stored)`);
      return {
        context: dataFrame(
          [
            `(no memory above threshold for this task; ${n} stored${guess ? ' — the closest trace is shown below, as a guess' : ''})`,
            ...(guess ? [renderLine(guess, 0)] : [])
          ].join('\n')
        ),
        items: guess ? [guess] : [],
        warnings
      };
    }

    if (opts.includeRecent) {
      const recent = this.db
        .allActive()
        .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
        .slice(0, opts.recentLimit ?? 3);
      const seen = new Set(items.map((i) => i.id));
      for (const r of recent) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const mem = rowToMemory(r, false);
        // Flagged at push time (S7 fix): the old index-arithmetic tag
        // (items.slice(limit) vs slice(0,limit)) addressed disjoint ranges,
        // so [recent] could never render.
        items.push({
          ...mem,
          score: 0.5,
          similarity: 0.5,
          relativeScore: 0,
          anchors: ['recency'],
          anchored: true,
          consolidated: mem.consolidated === true,
          recent: true
        });
      }
      warnings.push('includeRecent: appended recent traces not directly goal-relevant');
    }

    // Evidence + marker tags are rendered by renderLine above (standing, guard,
    // scope, recency, retraction). A goal-relevant set wins, so the guess only
    // appears when nothing else did.
    if (items.length === 0 && guess) items.push(guess);
    const shown = items.slice(0, limit);
    // Injection guard: memory text is data the agent (or a page it read) once
    // wrote — never instructions. Sanitized per line, framed as a whole block.
    return { context: dataFrame(shown.map(renderLine).join('\n')), items: shown, warnings };
  }

  /* ============================ introspection ============================ */

  stats(): { active: number; episodes: number; semantics: number; procedures: number; consolidated: number; historyRows: number; demoted: number } {
    const rows = this.db.allActive();
    const count = (k: string) => rows.filter((r) => r.kind === k).length;
    return {
      active: rows.length,
      episodes: count('episode'),
      semantics: count('semantic'),
      procedures: count('procedure'),
      // F4: the marker is not derivable from `kind`, so the count that says how
      // many rows systems consolidation actually produced lives here.
      consolidated: rows.filter((r) => (JSON.parse(r.tags_json || '[]') as string[]).includes('consolidated')).length,
      historyRows: rows.reduce((s, r) => s + r.version - 1, 0),
      demoted: rows.filter((r) => r.demoted === 1).length
    };
  }

  /**
   * P0-3: deep observability. stats() answers "how many rows"; diagnostics()
   * answers "is the memory system actually working". Detects the silent
   * killer: embedder mismatch — a real-model store queried by the hashing
   * fallback yields garbage cosines (measured 0.01–0.11), zero hits, forever,
   * with nothing in stats() looking wrong.
   */
  diagnostics(): {
    store_path: string;
    embedder: {
      /** 'model' when a real provider is attached and healthy, else 'hashing'. */
      kind: 'model' | 'hashing';
      dim: number;
      /** Dimension histogram of stored vectors — a mix means cross-embedder rows. */
      storedDims: { dim: number; rows: number }[];
      /** True when stored vectors disagree with the current embedder's dim. */
      dimMismatch: boolean;
    };
    thresholds: { similarity: number; nearDuplicate: number; contradiction: number; claim: number; minImportance: number };
    activity: {
      /** Rows never read since creation (access_count = 0). */
      neverAccessed: number;
      /** Total reads across all active rows. */
      totalAccess: number;
      /** Mean access_count over active rows (0 when empty). */
      meanAccess: number;
      /** Retired rows carrying an explicit supersedes edge out (superseded_by set). */
      supersededEdges: number;
    };
    /** True when rows exist but none was ever recalled — the dead-store smell. */
    suspicious: {
      neverAccessedRatio: number;
      possibleEmbedderMismatch: boolean;
      /** This store is empty while a sibling in the same directory holds memories. */
      emptyWhileSiblingsFull: boolean;
    };
    /**
     * Working-memory gate usage for this process: turns asked, turns that
     * cleared nothing, turns that ended up showing a labelled guess instead.
     * `misses / turns` is the recall hit-rate; `guesses` says how much of the
     * non-miss output was a hunch. Never persisted — scope is 'process'.
     */
    coverage: { turns: number; misses: number; guesses: number; scope: 'process' };
    /**
     * The other store files next to this one — the memories this process
     * cannot see. An empty recall is otherwise indistinguishable from "this
     * project never wrote anything", which is how a per-directory/per-agent
     * store split reads to both host and user.
     */
    sibling_stores: { dir: string; stores: StoreSurveyEntry[]; unreadable: string[] };
    /** The scoping contract, verbatim from the engine, so no adapter paraphrases it. */
    scope_rule: string;
  } {
    const rows = this.db.allActive();
    const dimHist = new Map<number, number>();
    for (const r of rows) {
      const b = vecFromBlob(r.vec);
      if (!b) continue;
      dimHist.set(b.length, (dimHist.get(b.length) ?? 0) + 1);
    }
    const storedDims = Array.from(dimHist.entries())
      .map(([dim, n]) => ({ dim, rows: n }))
      .sort((a, b) => b.rows - a.rows);
    const currentDim = this.embedder?.dim ?? 512;
    const dimMismatch = rows.length > 0 && storedDims.length > 0 && !storedDims.some((d) => d.dim === currentDim);
    const neverAccessed = rows.filter((r) => r.access_count === 0).length;
    const totalAccess = rows.reduce((s, r) => s + r.access_count, 0);
    // Retired rows only: a row carrying an outbound supersedes edge is always
    // superseded = 1, so counting over allActive() could only ever yield 0.
    const supersededEdges = this.db.countSupersededEdges();
    const neverAccessedRatio = rows.length === 0 ? 0 : neverAccessed / rows.length;
    // ':memory:' has no directory to survey — and dirname() of it is '.', which
    // would hand status a listing of whatever the process happened to start in.
    const siblings =
      this.dbPath === ':memory:'
        ? { dir: ':memory:', stores: [], unreadable: [] }
        : surveyStores(dirname(this.dbPath), { current: this.dbPath });
    // The signature of a store split: this file reads empty while a neighbour
    // in the same directory is full. Everything else in status then looks
    // healthy, which is exactly why it needs its own name.
    const emptyWhileSiblingsFull =
      rows.length === 0 && siblings.stores.some((s) => !s.current && s.rows > 0);
    return {
      store_path: this.dbPath,
      embedder: {
        kind: this.embedder ? 'model' : 'hashing',
        dim: currentDim,
        storedDims,
        dimMismatch
      },
      thresholds: {
        similarity: this.options.similarityThreshold,
        nearDuplicate: this.options.nearDuplicateThreshold,
        contradiction: this.options.contradictionThreshold,
        claim: this.options.claimThreshold,
        minImportance: this.options.minImportance
      },
      activity: { neverAccessed, totalAccess, meanAccess: rows.length === 0 ? 0 : totalAccess / rows.length, supersededEdges },
      suspicious: {
        neverAccessedRatio,
        possibleEmbedderMismatch: dimMismatch,
        emptyWhileSiblingsFull
      },
      coverage: { ...this.digestCoverage, scope: 'process' as const },
      sibling_stores: siblings,
      scope_rule: SCOPE_RULE
    };
  }

  /** Newest-first inventory of active memories (introspection / GUI browsing). */
  list(limit = 50): StoredMemory[] {
    return this.db
      .allActive()
      .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map((r) => rowToMemory(r, false));
  }

  get(id: string): StoredMemory | undefined {
    const row = this.db.getById(id);
    if (!row || row.superseded === 1) return undefined;
    return rowToMemory(row, false);
  }

  history(id: string): { version: number; summary: string; detail?: string; scope?: string; entities?: string[]; verifyResult?: 'pass' | 'fail'; archivedAt: string }[] {
    return this.db.historyOf(id).map((h) => ({
      version: Number(h.version),
      summary: h.summary as string,
      detail: (h.detail as string | null) ?? undefined,
      scope: (h.scope as string | null) ?? undefined,
      entities: h.entities_json ? (JSON.parse(h.entities_json as string) as string[]) : undefined,
      verifyResult: (h.verify_result as string | null) === 'pass' || (h.verify_result as string | null) === 'fail'
        ? (h.verify_result as 'pass' | 'fail')
        : undefined,
      archivedAt: h.archived_at as string
    }));
  }

  close(): void {
    this.db.close();
  }
}

/* ------------------------------------------------------------------ */

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * A score rendered for a "this is below X" sentence. `toFixed` can round the
 * printed value UP onto the bar the real score failed to clear, so the notes
 * that compare a similarity to a threshold end up asserting `0.54 < 0.54` — a
 * self-contradiction the reader cannot tell apart from a broken engine.
 * Truncating to the bar's own decimal count makes the sentence true by
 * construction (`floor(sim) <= sim < threshold`), and a float wobble can only
 * push the truncation further down, never up onto the bar.
 *
 * The input is not always the raw score: the digest renders recall's near-miss
 * field, which is rounded to three decimals where it is built, so that number
 * can arrive already equal to the floor. Stepping one decimal further down is
 * then the only thing left, and it terminates because every step strictly
 * lowers the printed value.
 */
function belowFloor(sim: number, threshold: number): string {
  let dp = Math.max(2, (String(threshold).split('.')[1] ?? '').length);
  for (;;) {
    const scale = 10 ** dp;
    const out = (Math.floor(sim * scale) / scale).toFixed(dp);
    if (Number(out) < threshold || dp === 0) return out;
    dp--;
  }
}

/**
 * Spaced-repetition rehearsal boost (Bjork's desirable-difficulty finding:
 * retrievals spread over time strengthen a trace far more than massed
 * repetition). The gain grows logarithmically with the gap since the last
 * access — restating a fact a week later is worth ~8× an immediate re-tell —
 * and stays bounded so old memories cannot ratchet to 1.0 in a few hits.
 *
 * gapMs <= 0 (never accessed / same instant): minimal +0.01.
 */
function rehearsalBoost(lastAccessAt: string | null | undefined, nowMs: number): number {
  if (!lastAccessAt) return 0.01;
  const gapMs = nowMs - Date.parse(lastAccessAt);
  if (!Number.isFinite(gapMs) || gapMs <= 0) return 0.01;
  const gapDays = gapMs / (24 * 60 * 60 * 1000);
  return Math.min(0.12, 0.01 + 0.03 * Math.log2(1 + gapDays));
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function importanceFromConfidence(c: 'high' | 'medium' | 'low' | 'speculative'): number {
  switch (c) {
    case 'high':
      return 0.7;
    case 'medium':
      return 0.5;
    case 'low':
      return 0.35;
    case 'speculative':
      return 0.2;
  }
}

/**
 * Rule extraction for consolidation. Episodes that already read like rules
 * are kept verbatim; otherwise we wrap the core claim as a semantic fact.
 * (A production build would run this through the LLM itself.)
 */
function abstractToRule(mem: StoredMemory): string | null {
  if (mem.kind !== 'episode') return null;
  const s = mem.summary;
  if (/(always|never|usually|prefers|is |are |uses|requires|depends on|works with|fact:)/i.test(s)) return s;
  return `FACT: ${s}`;
}

/**
 * Split a structured claim of the form "<subject> -> <value>" (or the
 * free-form variant "<subject> is/are/uses ... <value>" as written by
 * `remember` with a semantic payload). Returns null when the summary is not
 * structured, so free-form episodes fall back to cosine logic.
 */
function claimParts(summary: string): { subject: string; value: string } | null {
  const arrow = summary.match(/^\s*(.+?)\s*->\s*(.+?)\s*$/);
  if (arrow) return { subject: arrow[1]!.trim().toLowerCase(), value: arrow[2]!.trim().toLowerCase() };
  const copula = summary.match(/^\s*(.+?)\s+(?:is|are|uses|runs on|backed by|hosted by|stored in|written in)\s+(?:the\s+|an?\s+)?(.+?)\s*$/i);
  if (copula) return { subject: copula[1]!.trim().toLowerCase(), value: copula[2]!.trim().toLowerCase() };
  return null;
}

/** Strip the consolidation wrapper so "FACT: X" compares equal to "X". */
function stripAbstractPrefix(s: string): string {
  return s.replace(/^\s*(?:fact|rule)\s*:\s*/i, '');
}

/** Connectives that carry no premise information inside a scope value. */
const SCOPE_STOP = new Set(['a', 'an', 'the', 'of', 'to', 'is', 'are', 'in', 'at', 'on', 'for', 'by', 'with', 'and', 'or', 'as', 'per']);

/**
 * Scope terms: latin/digit runs kept whole, CJK split per character so a
 * reworded Chinese premise still overlaps (the hashing embedder keeps a CJK
 * run whole, which would make any paraphrase look like a new premise),
 * stopwords dropped.
 */
function scopeTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9._+-]*|[一-鿿]/g) ?? []).filter((t) => !SCOPE_STOP.has(t));
}

/**
 * Two premises stated without a key are compared against each other; the
 * label is what a note prints when such a pair is what blocked an answer.
 */
const UNKEYED_SCOPE = '@premise';
const UNKEYED_SCOPE_LABEL = 'unkeyed-premise';

/**
 * `key=value; key=value` (or `key:value`, comma/newline separated) → key → terms.
 *
 * A segment that states a condition WITHOUT naming a key is not "no premise".
 * It folds into one synthetic `@premise` bucket, so two different bare premises
 * can disagree (black-box report #2: a row stored under `us-east` and a query
 * under `ap-south` used to share no key, `scopeDifferences` returned nothing,
 * and the ranking read the foreign row as "the caller's own premise" — a false
 * SUBSTANTIATED). The bucket keeps the wording of the premise instead of
 * inventing a key for it: `us-east` names the condition, not a "region" field.
 */
function scopePairs(s: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const seg of s.split(/[;,\n]/)) {
    const t = seg.trim();
    if (!t) continue;
    const eq = t.match(/^([^=:]+)[=:](.*)$/);
    if (!eq) {
      const terms = scopeTokens(t);
      if (terms.length) out.set(UNKEYED_SCOPE, [...(out.get(UNKEYED_SCOPE) ?? []), ...terms]);
      continue;
    }
    const key = normalizeText(eq[1] ?? '');
    if (!key) continue;
    const terms = scopeTokens(eq[2] ?? '');
    out.set(key, out.has(key) ? [...out.get(key)!, ...terms] : terms);
  }
  return out;
}

/**
 * Two values of the same premise key. Compatible when one restates the other
 * (subset — "instruction start" vs "instruction start of the lea-rsp site")
 * or they overlap by half; a reworded premise must not read as a new one.
 */
function scopeValuesCompatible(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true; // nothing stated to disagree with
  const sa = new Set(a);
  const sb = new Set(b);
  const smaller = sa.size <= sb.size ? sa : sb;
  const larger = smaller === sa ? sb : sa;
  if ([...smaller].every((t) => larger.has(t))) return true;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union > 0 && inter / union >= 0.5;
}

/**
 * Keys both premises name while holding different values — the disagreement
 * evidence. Empty when either side states no premise: an unstated condition
 * is not a contradiction (it is reported as an unchecked premise instead).
 *
 * Keyed premises disagree only under a key BOTH sides name (naming another
 * axis is not disagreeing). An unkeyed premise is checked against the other
 * side's stated condition — its own unkeyed bucket when it has one, otherwise
 * the union of everything its keyed values say. That is what makes the two
 * forms cross-checkable: a bare `us-east` restates `region=us-east` (compatible)
 * and contradicts `region=eu-west` (a disagreement), instead of sliding past
 * the whole premise machinery as it did before.
 */
function scopeDifferences(a?: string | null, b?: string | null): string[] {
  if (!a || !b) return [];
  const pa = scopePairs(a);
  const pb = scopePairs(b);
  const differing: string[] = [];
  for (const [key, terms] of pa) {
    if (key === UNKEYED_SCOPE) continue;
    const other = pb.get(key);
    if (!other) continue;
    if (!scopeValuesCompatible(terms, other)) differing.push(key);
  }
  const bareA = pa.get(UNKEYED_SCOPE);
  const bareB = pb.get(UNKEYED_SCOPE);
  if (bareA && bareB) {
    if (!scopeValuesCompatible(bareA, bareB)) differing.push(UNKEYED_SCOPE_LABEL);
  } else {
    const bare = bareA ?? bareB;
    if (bare) {
      const stated: string[] = [];
      for (const [key, terms] of (bareA ? pb : pa)) if (key !== UNKEYED_SCOPE) stated.push(...terms);
      if (stated.length > 0 && !scopeValuesCompatible(bare, stated)) differing.push(UNKEYED_SCOPE_LABEL);
    }
  }
  return differing;
}

/**
 * Do these two premises state anything about the SAME condition?
 *
 * `scopeDifferences` answers "where do the two disagree", and by design it
 * returns nothing when the sides share no key — naming another axis is not
 * disagreeing. Every caller that reads that empty set as AGREEMENT therefore
 * inherits a premise nobody stated: the two were comparable. Round 23 (arm A)
 * is what happens when they are not — a trace stored under `release=v2` was
 * read as "the caller's own premise" against a claim checked under
 * `env=staging; region=ap-south`, won the support ranking, and short-circuited
 * the whole scope-veto scan. The black-box report's `out_of_scope` was never
 * unreachable for lack of wiring; it was unreachable because the gate in front
 * of it accepted a non-argument as a proof.
 *
 * Comparability is exactly the three shapes `scopeDifferences` can harvest a
 * difference from: a key both sides name, two unkeyed premises, or one unkeyed
 * premise against the terms the other side does state. Anything else has no
 * shared condition to agree OR disagree about.
 */
function scopesComparable(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const pa = scopePairs(a);
  const pb = scopePairs(b);
  const bareA = pa.get(UNKEYED_SCOPE);
  const bareB = pb.get(UNKEYED_SCOPE);
  if (bareA && bareB) return true;
  if (bareA || bareB) {
    const other = bareA ? pb : pa;
    for (const [key, terms] of other) if (key !== UNKEYED_SCOPE && terms.length > 0) return true;
    return false;
  }
  for (const key of pa.keys()) if (key !== UNKEYED_SCOPE && pb.has(key)) return true;
  return false;
}

/**
 * Does the stored premise RESTATE the caller's, rather than merely failing to
 * contradict it? No for a row that states no premise (there is nothing
 * stated), and no for a row on an axis the caller never named (there is
 * nothing to compare) — `scopeDifferences(...) === 0` alone claims both.
 */
function scopeStatesCallerPremise(rowScope?: string | null, queryScope?: string | null): boolean {
  if (!rowScope || !queryScope) return false;
  if (!scopesComparable(rowScope, queryScope)) return false;
  return scopeDifferences(rowScope, queryScope).length === 0;
}

/**
 * May this row stand as SUPPORT for a claim stated under the caller's premise?
 *
 * The third question in the family, and the one round 24 found unasked. Naming
 * another axis is not disagreeing (`scopeDifferences` says nothing), and it is
 * not restating the caller's condition either (`scopeStatesCallerPremise` says
 * no) — the pair leaves a third state, and both earlier answers read it as the
 * first. A trace keyed on `tenant` says nothing about a claim checked under
 * `cluster`, so it cannot certify it; the field report's shape (a) is exactly
 * that affirm, at 0.846 hashing / 0.909 bge, with nothing in the answer naming
 * the mismatch.
 *
 * Premise-free rows stay admissible on purpose: a trace that states no condition
 * is a GENERAL statement, and a general statement does cover the caller's. The
 * asymmetry is what `scopeStatesCallerPremise` already encodes — "no premise"
 * means "nothing stated", never "nothing to check" — and it is the difference
 * between this gate vetoing a foreign axis and vetoing every conditioned query.
 */
function scopeCanSupport(rowScope?: string | null, queryScope?: string | null): boolean {
  if (!rowScope || !queryScope) return true;
  return scopesComparable(rowScope, queryScope);
}

/**
 * Do these two texts say the SAME SENTENCE?
 *
 * One predicate on purpose, shared by the write path and the read path. The write path
 * refuses to narrow a premise-free row under it (G4: `narrowsPremiseFree` fires only
 * inside a branch that already matched on this test), and the read path exempts such a
 * row from a foreign-premise veto under it too. If the two grew separate grammars, the
 * pair the write path keeps apart and the exemption that lets the general half answer
 * would no longer be about the same sentence, and the store could produce a shape its
 * own verify refuses to read.
 *
 * Wrapper stripped, whitespace collapsed, case folded: a consolidation echo of `X`
 * recorded as "FACT: X" is the same sentence as `X`.
 */
function isVerbatimRestatement(a: string, b: string): boolean {
  return normalizeText(stripAbstractPrefix(a)) === normalizeText(stripAbstractPrefix(b));
}

/**
 * Do these two traces state their condition the SAME way?
 *
 * `scopeDifferences` answers a narrower question — where the two sides share a key, do
 * the values disagree — and a premise-free row shares no key with anything, so it answers
 * "no difference" for the pair `null` / `env=staging`. That reading is right for a veto
 * (nothing stated cannot contradict) and wrong for a fold: retiring either row either
 * drops the general statement's coverage or discards the condition someone stated, and
 * there is no third row that knows both.
 *
 * So the merge side asks the wider question first, and it is the same one the write path
 * refuses under (`narrowsPremiseFree` is this predicate with the caller's scope on one
 * side): a row that states nothing and a row that states something are two statements.
 */
function premiseAgrees(a?: string | null, b?: string | null): boolean {
  if (!a && !b) return true;
  return !!a && !!b && scopeDifferences(a, b).length === 0;
}

/** The axes a premise names, for a note that has to say WHY two share nothing. */
function scopeAxes(scope?: string | null): { keys: string[]; bare: boolean } {
  const pairs = scope ? scopePairs(scope) : new Map<string, string[]>();
  return { keys: [...pairs.keys()].filter((k) => k !== UNKEYED_SCOPE), bare: pairs.has(UNKEYED_SCOPE) };
}

/**
 * The labels — ticket ids, dates, versions, zone codes, addresses, counts — a
 * text names. One rule rather than a grammar per dialect, because a veto read off
 * these has to be monotone. R4 closed `2024z` by adding a branch, and a family
 * sweep then found six shapes still answered SUBSTANTIATED in BOTH the pre-R4 and
 * the R4 build (`.hippo/probe-numeric-family.mjs`). Two of the three reasons were
 * a branch existing but harvesting the wrong extent: an IP pair shared the token
 * `10.20.30` that the dotted branch stopped at, leaving the divergent octet
 * outside anything that was compared, while `probe-k8 2024z` was vetoed only
 * because NO branch named `probe-k8` — under the disjointness test that used to
 * read these sets, harvesting the shared prefix would have UNDONE the fix.
 * Growing the alternation could not close the family; the comparison had to move.
 *
 * So: any run of alphanumerics joined by `- _ . : /`, whole, that contains at
 * least one digit. Taking the run to its full extent is what makes the divergent
 * character land inside the token, and the digit requirement is load-bearing — it
 * keeps ordinary hyphenated words out of the set, since the rule below treats a
 * one-sided label as evidence that two sentences are different facts.
 *
 * One exception, restored after it was measured as a transfer of exactly the R4
 * kind: a run of seven or more hex letters with NO digit is a commit sha
 * (`HEXISH_RUN_RE`), and the retired `[0-9a-f]{7,40}` branch used to name it.
 * `commit deadbeef …` asked back as `commit cafebabe …` was WEAK_MATCH on both
 * pre-R4b builds and SUBSTANTIATED on the first R4b cut (`.hippo/probe-digitless.mjs`).
 * Restoring it is safe in a way the branch table never was: under a both-private
 * comparison, harvesting MORE can only enlarge a side's private set, so a wider
 * harvest can add downgrades and never remove one. The price it does not pay is
 * the word case — `long-tailed` vs `short-tailed` still substantiates, by design.
 *
 * Still deliberately WIDER than the `literalOverlap` grammar above, and used only
 * in the opposite direction: `literalOverlap` may hand out a yes, so it stays
 * strict, while these sets are compared to DECIDE THAT A MATCH IS NOT ABOUT THE
 * SAME THING, which can only ever downgrade a verdict. `KAPPA-1` is the case the
 * strict grammar misses — `[A-Z]{1,3}-\d` caps the prefix at three letters.
 */
const LABEL_RUN_RE = /[0-9a-z]+(?:[-_.:/][0-9a-z]+)*/gi;
const HEXISH_RUN_RE = /^[0-9a-f]{7,}$/i;

function identifierTokens(s: string): Set<string> {
  return new Set(
    (s.match(LABEL_RUN_RE) ?? [])
      .filter((t) => /\d/.test(t) || HEXISH_RUN_RE.test(t))
      .map((t) => t.toLowerCase())
  );
}

/**
 * Literal-token overlap between cue and summary. Identifiers (hex addresses,
 * ticket/decision ids, commit shas, versions) survive verbatim in memory
 * summaries, and an exact match is far stronger evidence than cosine — which
 * underrates them, especially for short CJK queries. Returns the count of
 * distinct identifier tokens shared by both.
 */
function literalOverlap(cue: string, summary: string): number {
  const tokens = (s: string) =>
    new Set(
      (s.match(/\b(?:0x[0-9a-f]{3,}|[A-Z]{1,3}-\d{1,5}\b|[0-9a-f]{7,40}\b|v?\d+\.\d+(?:\.\d+)?)\b/gi) ?? []).map((t) =>
        t.toLowerCase()
      )
    );
  const a = tokens(cue);
  if (a.size === 0) return 0;
  const b = tokens(summary);
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared;
}

/** Distinct CJK ideographs in a string (the per-character idiom `scopeTokens` uses). */
function cjkChars(s: string): Set<string> {
  return new Set(s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []);
}

/** Topic-bearing words: ≥4 characters, connectives excluded (reuses `SCOPE_STOP`, no new lexicon). */
function anchorWords(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9_][a-z0-9_.+-]{3,}/g) ?? []).filter((w) => !SCOPE_STOP.has(w)));
}

/**
 * Anchors: the nameable evidence that a recall hit is about what the cue asked
 * (F4b, black-box report #4).
 *
 * Cosine cannot tell "this row answers the question" from "this row happens to
 * sit nearby", and a real embedding model makes the two indistinguishable — while
 * `relativeScore` (sim ÷ best sim of THIS set) then reads as a confidence the
 * match never earned, and the digest injects the neighbour as if it were memory.
 * An anchor is something a caller can point at: an identifier both sides carry,
 * an entity the cue names, the subject of a structured claim the cue repeats, or
 * at minimum one shared content word.
 *
 * The weakest tier is deliberately generous — one shared word of ≥4 characters
 * (or ≥2 shared CJK ideographs) counts. Under-flagging leaves a real paraphrase
 * in the digest; over-flagging would withhold answers, and a belt that starves
 * the context is worse than the noise it removes. Only rows with NO lexical or
 * structural overlap at all are called unanchored: pure vector drift.
 */
function recallAnchors(cue: string, mem: Pick<StoredMemory, 'summary' | 'entities'>): string[] {
  const q = cue.toLowerCase();
  const qWords = anchorWords(q);
  const out: string[] = [];
  if (literalOverlap(q, mem.summary) > 0) out.push('identifier');
  if (mem.entities.some((e) => e.length > 1 && q.includes(e.toLowerCase()))) out.push('entity');
  // The cue repeating the claim's SUBJECT — as the whole phrase, or as any word
  // of it (a cue is usually shorter than a stored subject, so containment alone
  // would under-report and leave the row looking merely word-adjacent).
  const claim = claimParts(mem.summary);
  if (
    claim &&
    claim.subject.length >= 4 &&
    (q.includes(claim.subject) || [...anchorWords(claim.subject)].some((w) => qWords.has(w)))
  ) {
    out.push('subject');
  }
  if (out.length === 0) {
    // Weakest tier, and deliberately generous: one shared topic word (or two
    // shared CJK ideographs) anywhere in the row counts, even when it is only in
    // the predicate rather than the thing being asked about.
    const shared = [...anchorWords(mem.summary)].some((w) => qWords.has(w));
    const cueHan = cjkChars(q);
    let han = 0;
    for (const ch of cjkChars(mem.summary)) if (cueHan.has(ch)) han++;
    if (shared || han >= 2) out.push('vocabulary');
  }
  return out;
}
