/**
 * SSN redaction — single source of truth.
 *
 * Guarantees an agent never SEES, STORES, LOGS, or SHARES a Social Security
 * Number, regardless of the source connector (AppFolio `af`, PropertyMeld
 * `pm`, or any future connector). This module is software-agnostic: it
 * operates on plain text and is imported by BOTH defensive layers:
 *
 *   - Layer 1 (inbound): `src/pty/redact.ts` `redactSecrets()` scrubs every
 *     chunk of PTY output before it reaches the in-memory ring buffer or the
 *     persisted stdout.log. This is the central chokepoint all connector
 *     output flows through, mirroring the existing JWT redaction.
 *   - Layer 2 (outbound / persistence): the bus send paths, the knowledge-base
 *     ingest path, and the event log scrub message text in-place before it
 *     leaves the process or is written to disk / the vector store.
 *
 * Design decisions (locked):
 *   1. SCRUB in place, do NOT block. Each SSN is replaced with the literal
 *      `[REDACTED-SSN]`; surrounding text passes through untouched. Blocking
 *      a whole message merely because it sits near an SSN would kill legit
 *      workflows.
 *   2. CONSERVATIVE pattern by default. The aggressive bare-9-digits-anywhere
 *      rule is OFF unless explicitly enabled (opt / `SSN_REDACT_AGGRESSIVE`),
 *      because a bare 9-digit run is far more often an ID/amount than an SSN.
 *   3. Detection is keyed to a verified pattern set (0 false positives across
 *      real af + pm payloads; catches real SSNs). Critically, a 10-digit phone
 *      number `XXX-XXX-XXXX` MUST NOT match the `XXX-XX-XXXX` SSN shape.
 *
 * Regex discipline: every regex used with the global flag is constructed
 * fresh inside the function that uses it (or only ever passed to `.replace()`),
 * so the stateful `lastIndex` of a shared global-flag instance can never leak
 * across calls.
 */

export const SSN_PLACEHOLDER = '[REDACTED-SSN]';

/**
 * Formatted-SSN separator class — the SINGLE source of truth shared by Pass 2,
 * COMPLETE_SSN, the chunk-boundary holdback (PARTIAL_SSN_AT_END), and
 * isPartialSsnMaterial, so a same-chunk match and a split-across-chunks match
 * can never diverge. ASCII dash/dot/tab/space PLUS the Unicode HORIZONTAL space
 * separators (category Zs): NBSP U+00A0, Ogham U+1680, the U+2000–U+200A run
 * (incl. figure U+2007, thin U+2009), narrow-NBSP U+202F, medium-math U+205F,
 * ideographic U+3000. Without these, an SSN typed with a non-ASCII space
 * (`123 45 6789` — the exact 3-2-4 shape) matches neither the bare-9
 * pass (digits not contiguous) nor the formatted pass (ASCII-only separator)
 * and flows raw through Layer 1 AND Layer 2. Line/paragraph separators
 * (U+2028/U+2029) are DELIBERATELY EXCLUDED — like `\n`, they would false-match
 * three unrelated numbers on consecutive lines. Widening the CLASS (vs
 * normalizing the text) preserves byte-identical passthrough: only the SSN span
 * is replaced, so a legit figure-space-aligned numeric table in non-SSN output
 * is untouched. `\d` stays ASCII (JS default); Unicode digit scripts
 * (fullwidth/Arabic-Indic) are an accepted boundary — US SSNs are ASCII digits.
 */
const SSN_SEP = '[-.\\t \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]';

/**
 * Invisible / format chars (Unicode `\p{Cf}` + `\p{Default_Ignorable_Code_Point}`)
 * tolerated BETWEEN an SSN's digits. ZWSP, joiners, BOM, variation selectors,
 * etc. can be interleaved in a digit run (`987<ZWSP>654321`, `12<ZWSP>3-45-6789`)
 * without changing how the number READS, defeating both passes. They are handled
 * IN-PATTERN — matched as part of the SSN span and redacted WITH it — NOT stripped
 * from output, so a legit load-bearing ZWJ/ZWNJ in Indic text or an emoji sequence
 * ELSEWHERE stays byte-identical. INVIS and `\d` ([0-9]) are DISJOINT, so
 * `INVIS\d` is unambiguous = no catastrophic backtracking. Requires the `u` flag.
 * The python mirror (`mmrag.py`) uses the EXACT same codepoint set, generated from
 * this JS class and drift-guarded; the dashboard scrubber mirrors it too.
 */
const INVIS = '[\\p{Cf}\\p{Default_Ignorable_Code_Point}]*';

/** `n` ASCII digits with optional invisibles interleaved between them. */
function ssnDigits(n: number): string {
  return '\\d' + `(?:${INVIS}\\d)`.repeat(n - 1);
}

// Boundary anchors: a negative lookbehind/lookahead on DIGIT-ONLY, NOT `\b`.
// `\b` requires a WORD boundary, so an SSN glued directly to a letter/underscore
// with no delimiter (`applicantId123-45-6789`, `ssn987654321`, `id987...end`)
// was never even found → leaked to every sink (the dashboard aggressive re-scrub
// missed it too — NOT off-host-protected). `(?<![0-9])`/`(?![0-9])` still keeps
// the load-bearing FP guard (a 10+-digit run like `1234567890` has no sub-9; a
// 3-2-4 phone is excluded by SHAPE, not boundary) yet FIRES when glued to a
// letter/underscore. DIGIT-ONLY, NOT digit-or-dash: a dash in the class would
// make a DASH-delimited SSN (`ssn-123-45-6789`, `tax-id-987654321`) survive — a
// worse leak than the only thing the dash bought (`123-45-6789-0123` flipping
// from redact to a cosmetic non-redact). And NOT space: a space legitimately
// precedes an SSN (`SSN: 123-45-6789`). Lookbehind is fixed-width → JS + python
// both support it, parity preserved.
const SSN_LEAD = '(?<![0-9])';
const SSN_TRAIL = '(?![0-9])';

/** Bare 9-digit run, invisibles tolerated between digits (`u` flag for \p{}). */
function bareNineRegex(): RegExp {
  return new RegExp(`${SSN_LEAD}\\d(?:${INVIS}\\d){8}${SSN_TRAIL}`, 'gu');
}

/**
 * Formatted SSN `\d{3}<sep>\d{2}<sep>\d{4}` (global), with invisibles tolerated
 * between digits and around the separators. Each group stays EXACTLY 3/2/4
 * VISIBLE digits (INVIS adds no digit), so the 3-2-4 shape never loosens into a
 * 3-3-4 phone. Built fresh per call.
 */
function formattedSsnRegex(): RegExp {
  return new RegExp(
    `${SSN_LEAD}${ssnDigits(3)}${INVIS}${SSN_SEP}${INVIS}${ssnDigits(2)}${INVIS}${SSN_SEP}${INVIS}${ssnDigits(4)}${SSN_TRAIL}`,
    'gu',
  );
}

/**
 * A label that promotes a bare 9-digit run to an SSN in conservative mode.
 * Case insensitive. No global flag — used only with stateless `.test()`.
 *   - `ssn`
 *   - `social security` / `social_security` (one or more space/underscore)
 *   - `tax id` / `taxid` / `tax_id` (optional space/underscore)
 *
 * Also used to test a `labelHint` (an out-of-band key) — see redactSSN.
 */
// Label-internal separator (`social<SEP>+security`, `tax<SEP>*id`) — a SHARED
// EXPLICIT class, NOT `\s`, because JS `\s` and python `\s` are INCOMPARABLE
// (JS `\s` has U+FEFF, python's has U+0085/NEL + U+1C–1F), so a `\s`-based label
// would redact `social<FEFF>security…` in JS but LEAK it in the python KB sink
// (and vice-versa for NEL). LABEL_SEP is the UNION of JS `\s` ∪ python `\s` plus
// underscore — a superset of both, byte-identical on both runtimes — so the
// label catches every whitespace either runtime would, with ZERO divergence.
// Generated and pinned to tests/fixtures/label-sep-ranges.json (drift-guarded;
// each runtime asserts its live `\s` ⊆ the fixture). The label words are ASCII,
// so case-fold is ASCII-pinned (`/i` here, `re.IGNORECASE|re.ASCII` in mmrag.py)
// — JS `/i` (no `u`) and python ASCII case-fold agree (neither folds ſ→s).
// Exported for the drift-guard test (asserts it matches tests/fixtures/label-sep-ranges.json).
export const LABEL_SEP =
  '[\\u0009-\\u000d\\u001c-\\u0020\\u002d\\u005f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028-\\u2029\\u202f\\u205f\\u3000\\ufeff]';
const LABEL_ALT = `(?:ssn|social${LABEL_SEP}+security|tax${LABEL_SEP}*id)`;
const SSN_LABEL = new RegExp(LABEL_ALT, 'i');

/**
 * In-text label promotion is keyed on the label's END being within
 * SSN_LABEL_GAP chars of the 9-digit run, searched over an
 * SSN_LABEL_LOOKBACK-char window. Anchoring on the label END (not its START)
 * lets a LONG label like `social security number` / `social_security_number`
 * promote even though `social` starts >20 chars from the digits — a 20-char
 * START window leaves those raw (a real SSN leak). The GAP is kept tight (16)
 * so a label that belongs to ANOTHER nearby number does not bleed across:
 * `tax id 111-22-3333, ref 987654321` leaves the unrelated `987654321` alone.
 */
const SSN_LABEL_GAP = 16;
const SSN_LABEL_LOOKBACK = 40; // longest label (~15) + GAP + margin
// `[\s\S]{0,16}` (not `.{0,16}`) so the label↔number gap may span a NEWLINE —
// a label on the adjacent line still promotes (e.g. `SSN:\n987654321`, or
// pretty-printed JSON with the value on the next line). This is the GAP only;
// the formatted-SSN separator stays HORIZONTAL `[-.\t ]`, so three unrelated
// numbers on consecutive lines (`123\n45\n6789`) still do not false-match.
// NOT the `u` flag: `/u` would count `[\s\S]{0,16}` in codepoints (wanted) but
// also switch `/i` to FULL Unicode case-fold (unwanted — JS `/iu` folds ſ→s while
// python `re.ASCII` does not, a fresh divergence). Codepoint-accurate counting is
// achieved instead by collapsing astral codepoints to one BMP char in the gap
// window (see redactSSN Pass 1), so case-fold stays simple/ASCII = python parity.
const SSN_LABEL_BEFORE = new RegExp(`${LABEL_ALT}[\\s\\S]{0,16}$`, 'i');
const SSN_LABEL_AFTER = new RegExp(`^[\\s\\S]{0,16}${LABEL_ALT}`, 'i');

// ---------------------------------------------------------------------------
// PII v2 milestone-2 — EIN, routing number, bank account.
//
// These three label-keyed entries REUSE every SSN primitive (SSN_SEP, INVIS,
// SSN_LEAD/SSN_TRAIL, LABEL_SEP, SSN_LABEL_GAP/LOOKBACK) — zero new regex
// primitives that would require a fresh cross-runtime sync. Placeholders are
// internal (NOT exported): only SSN_PLACEHOLDER is a frozen export.
// ---------------------------------------------------------------------------
const EIN_PLACEHOLDER = '[REDACTED-EIN]';
const ROUTING_PLACEHOLDER = '[REDACTED-ROUTING]';
const BANK_ACCT_PLACEHOLDER = '[REDACTED-BANK-ACCT]';

// EIN label set (design defaults): `ein`, `fein`, `employer identification`,
// `employer id`, `federal tax id`. `tax id` is DELIBERATELY left SSN-only (a
// bare-9 near `tax id` redacts as SSN by registry order), so EIN never claims
// it. LABEL_SEP (shared, explicit, JS∪python \s + underscore) separates the
// multi-word forms — same parity discipline as the SSN label. The bare `ein`/
// `fein` roots cover BOTH the space-separated `ein number` form AND the
// snake_case `ein_number`/`ein_value` keys, because the in-text matchers use
// LETTER-CLASS boundaries (below) which treat `_`/digits as boundaries — no
// explicit `ein<SEP>+number` form is needed (it was redundant once the boundary
// stopped being `\b`).
const EIN_LABEL_ALT =
  `(?:fein|ein|employer${LABEL_SEP}+identification|employer${LABEL_SEP}+id|federal${LABEL_SEP}+tax${LABEL_SEP}*id)`;
const EIN_LABEL = new RegExp(EIN_LABEL_ALT, 'i');
// In-text matchers use LETTER-CLASS boundaries `(?<![a-z])…(?![a-z])`, NOT `\b`.
// `\b` treats `_` AND digits as word chars, so `\bein\b` MISSED snake_case /
// JSON keys (`ein_number`, `ein_value`, `{"ein":…}`) — a real EIN leak.
// Letter-boundaries treat `_`/digits as boundaries (so those keys match) while
// STILL excluding letter-glued substrings (protein/vein/Einstein/caffeine stay
// safe — a letter sits on the boundary). Lookbehind is fixed-width → JS (no `u`
// flag) + python (`re.ASCII`) + the dashboard build all support it (the codebase
// already relies on `(?<![0-9])` for SSN_LEAD). The labelHint predicate
// (EIN_LABEL) stays unanchored — an explicit caller hint like `employer_ein` is
// an intentional signal, not organic text.
const EIN_LABEL_BEFORE = new RegExp(`(?<![a-z])${EIN_LABEL_ALT}(?![a-z])[\\s\\S]{0,16}$`, 'i');
const EIN_LABEL_AFTER = new RegExp(`^[\\s\\S]{0,16}(?<![a-z])${EIN_LABEL_ALT}(?![a-z])`, 'i');

// Routing label set (design defaults): `routing`, `aba`, plus the explicit
// snake_case forms `routing_number` / `aba_routing`. Bare `transit` is EXCLUDED
// (public-transit FP).
//
// BOUNDARY DESIGN (routing is ASYMMETRIC — unlike EIN/bank — see DEVIATION note):
//   leading  `(?<![a-z])`     — letter-only, so a JSON key `{"routing_number"` or
//                               a snake-prefixed `aba_routing` still matches (the
//                               `"`/`_` before the token is a boundary) while a
//                               letter-glued `rerouting`/`database`/`Alibaba` is
//                               excluded (a LETTER sits on the boundary).
//   trailing `(?![a-z0-9_])`  — WORD-CHAR-excluding (= `\b`-trailing), NOT just
//                               letter. KEYSTONE difference from EIN/bank: the
//                               bare `routing` root must match `routing ` /
//                               `routing transit` / `routing number` but NOT
//                               `routing_table` / `routing_protocol` (networking,
//                               NO routing-NUMBER context — a documented FP guard).
//                               A pure letter-boundary `(?![a-z])` would let bare
//                               `routing` match inside `routing_table` (`_` is a
//                               letter-boundary) and false-redact an adjacent
//                               9-digit value. The trailing `_`/digit-exclusion
//                               blocks that. The legit snake_case LABEL
//                               `routing_number` is still caught — by the EXPLICIT
//                               `routing<SEP>+number` alternative (listed first),
//                               whose trailing boundary sits after `number` (a
//                               space/value boundary). The discriminator is the
//                               WORD AFTER `routing`, not the boundary, so a bare
//                               root alone can never separate them.
// EIN/bank do NOT need this asymmetry: `ein`/`fein` ARE the whole label (so
// `ein_number`/`ein_value` SHOULD redact) and bank is multi-word, so they use a
// symmetric letter-boundary. The labelHint predicate (ROUTING_LABEL) stays
// unanchored. JS↔python parity-safe (fixed-width lookbehind, ASCII char classes).
const ROUTING_LABEL_ALT =
  `(?:routing${LABEL_SEP}+number|aba${LABEL_SEP}+routing|routing|aba)`;
const ROUTING_LABEL = new RegExp(ROUTING_LABEL_ALT, 'i');
const ROUTING_LABEL_BEFORE = new RegExp(`(?<![a-z])${ROUTING_LABEL_ALT}(?![a-z0-9_])[\\s\\S]{0,16}$`, 'i');
const ROUTING_LABEL_AFTER = new RegExp(`^[\\s\\S]{0,16}(?<![a-z])${ROUTING_LABEL_ALT}(?![a-z0-9_])`, 'i');

// Bank-account label set (design defaults): `bank account`, `account number`,
// `bank acct`. Bare `acct`, `checking`, `savings` are EXCLUDED (high FP). All
// three are multi-word and need LABEL_SEP between the words.
const BANK_LABEL_ALT =
  `(?:bank${LABEL_SEP}+account|account${LABEL_SEP}+number|bank${LABEL_SEP}+acct)`;
const BANK_LABEL = new RegExp(BANK_LABEL_ALT, 'i');
// LETTER-CLASS boundaries `(?<![a-z])…(?![a-z])` (not `\b`): the multi-word forms
// are already low-FP, but the boundary must treat `_`/digits as boundaries so the
// snake_case key `bank_account_number` matches (the `account_number` form fires
// across the `_`) and `{"bank_account_number":…}` JSON keys promote. `\b` treated
// `_` as a word char and MISSED `bank_account_number`. Letter-boundaries still
// prevent `…bank account…` glued inside a larger LETTER token from promoting
// (`embankment` excluded). JS↔python parity-safe (fixed-width lookbehind).
const BANK_LABEL_BEFORE = new RegExp(`(?<![a-z])${BANK_LABEL_ALT}(?![a-z])[\\s\\S]{0,16}$`, 'i');
const BANK_LABEL_AFTER = new RegExp(`^[\\s\\S]{0,16}(?<![a-z])${BANK_LABEL_ALT}(?![a-z])`, 'i');

/**
 * Formatted EIN `\d{2}<sep>\d{7}` (global), invisibles tolerated between digits
 * and around the separator. The 2-7 group shape is UNAMBIGUOUS vs the SSN 3-2-4
 * shape (different group counts + single separator), so Pass 2 always fires on a
 * formatted EIN without a label — exactly parallel to formattedSsnRegex. Reuses
 * ssnDigits/INVIS/SSN_SEP/SSN_LEAD/SSN_TRAIL — zero new primitives. Fresh per call.
 */
function formattedEinRegex(): RegExp {
  return new RegExp(
    `${SSN_LEAD}${ssnDigits(2)}${INVIS}${SSN_SEP}${INVIS}${ssnDigits(7)}${SSN_TRAIL}`,
    'gu',
  );
}

/** A regex that never matches — used as the formattedMatcher for entries with
 *  no formatted variant (routing, bank-acct). Fresh per call (the `g` flag's
 *  lastIndex is moot on a zero-match pattern, but kept for fresh-instance hygiene). */
function neverRegex(): RegExp {
  return /(?!)/g;
}

/**
 * Bank-account candidate: a 4–17 digit run (3–16 repetitions of the trailing
 * digit = 4–17 total), invisibles tolerated between digits, digit-only
 * lookarounds. This is the bank-acct `aggressiveMatcher` in ALL modes — the
 * conservative callback then label-GATES every candidate (it does NOT
 * short-circuit on aggressive), so bank-acct is label-required even aggressively.
 * Fresh per call. 4-digit floor / 17-digit ceiling reject ZIPs and over-long runs.
 */
function bankAcctRangeRegex(): RegExp {
  return new RegExp(`${SSN_LEAD}\\d(?:${INVIS}\\d){3,16}${SSN_TRAIL}`, 'gu');
}

// ---------------------------------------------------------------------------
// MARKUP primitives + per-entry markup matcher builders (rendered-HTML egress).
//
// Defined ABOVE the registry so each PiiRegistryEntry can store its markup
// matchers, making `redactSSNMarkupAware` a uniform registry iteration (the SSN
// markup logic that used to live inline in that function is MOVED here UNCHANGED
// — byte-identical behavior). `MARKUP` tolerates HTML TAGS (rendered invisibly)
// AND invisibles between digits/separators; `STRIP_MARKUP` removes them so a
// label window is tested on the RENDERED text.
// ---------------------------------------------------------------------------
const MARKUP = '(?:<[^>]*>|[\\p{Cf}\\p{Default_Ignorable_Code_Point}])*';
function markupDigits(n: number): string {
  return '\\d' + `(?:${MARKUP}\\d)`.repeat(n - 1);
}
const STRIP_MARKUP = /<[^>]*>|[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/** Markup-tolerant bare run of EXACTLY `n` visible digits (digit-only
 *  lookarounds), tags/invisibles tolerated between digits. Fresh per call. */
function markupBareRegex(n: number): () => RegExp {
  return () => new RegExp(`${SSN_LEAD}\\d(?:${MARKUP}\\d){${n - 1}}${SSN_TRAIL}`, 'gu');
}

/** Markup-tolerant bank-acct CANDIDATE: a 4–17 visible-digit run (3–16 trailing
 *  reps), tags/invisibles tolerated between digits. Fresh per call. The markup
 *  conservative callback label-GATES every candidate (even in aggressive). */
function markupBankAcctRangeRegex(): RegExp {
  return new RegExp(`${SSN_LEAD}\\d(?:${MARKUP}\\d){3,16}${SSN_TRAIL}`, 'gu');
}

/** Markup-tolerant formatted SSN `\d{3}<sep>\d{2}<sep>\d{4}`. Each group keeps
 *  EXACTLY its visible digit count, so a 3-3-4 phone never matches. Fresh per call. */
function markupFormattedSsnRegex(): RegExp {
  return new RegExp(
    `${SSN_LEAD}${markupDigits(3)}${MARKUP}${SSN_SEP}${MARKUP}${markupDigits(2)}${MARKUP}${SSN_SEP}${MARKUP}${markupDigits(4)}${SSN_TRAIL}`,
    'gu',
  );
}

/** Markup-tolerant formatted EIN `\d{2}<sep>\d{7}`. The 2-7 shape is unambiguous
 *  vs the SSN 3-2-4 shape, so it always fires without a label. Fresh per call. */
function markupFormattedEinRegex(): RegExp {
  return new RegExp(
    `${SSN_LEAD}${markupDigits(2)}${MARKUP}${SSN_SEP}${MARKUP}${markupDigits(7)}${SSN_TRAIL}`,
    'gu',
  );
}

/** Zero-match markup formatted matcher for entries with no formatted variant
 *  (routing, bank-acct). Mirrors `neverRegex`. Fresh per call. */
function markupNeverRegex(): RegExp {
  return /(?!)/g;
}

/**
 * Build a MARKUP-aware Pass-1 conservative callback factory — the rendered-HTML
 * analogue of `makeLabelKeyedConservativeMatcher`. Same per-entry parameters
 * (placeholder, before/after label regexes, shortCircuitOnAggressive); the label
 * window is markup-STRIPPED with a WIDE raw lookback (`SSN_LABEL_LOOKBACK * 12`)
 * so HTML tags that inflate the raw character distance cannot push the label out
 * of the window. Placeholder-neutralized before the test so an emitted placeholder
 * can't act as a promoting label (idempotency). `aggressive` (not labelHinted —
 * the markup egress sink has no out-of-band key) decides the short-circuit. The
 * SSN entry is given exactly the prior inline SSN-markup parameters, so its
 * observable behavior is byte-identical.
 */
function makeMarkupLabelKeyedConservativeMatcher(
  placeholder: string,
  labelBefore: RegExp,
  labelAfter: RegExp,
  shortCircuitOnAggressive: boolean,
): (aggressive: boolean) => (match: string, offset: number, full: string) => string {
  return (aggressive: boolean) =>
    (match: string, offset: number, full: string): string => {
      if (aggressive && shortCircuitOnAggressive) return placeholder;
      const neutral = ' '.repeat(placeholder.length);
      const before = full
        .slice(Math.max(0, offset - SSN_LABEL_LOOKBACK * 12), offset)
        .replace(STRIP_MARKUP, '')
        .split(placeholder)
        .join(neutral);
      const after = full
        .slice(offset + match.length, offset + match.length + SSN_LABEL_LOOKBACK * 12)
        .replace(STRIP_MARKUP, '')
        .split(placeholder)
        .join(neutral);
      return labelBefore.test(before) || labelAfter.test(after) ? placeholder : match;
    };
}

const makeSsnMarkupConservativeMatcher = makeMarkupLabelKeyedConservativeMatcher(
  SSN_PLACEHOLDER,
  SSN_LABEL_BEFORE,
  SSN_LABEL_AFTER,
  true,
);
const makeEinMarkupConservativeMatcher = makeMarkupLabelKeyedConservativeMatcher(
  EIN_PLACEHOLDER,
  EIN_LABEL_BEFORE,
  EIN_LABEL_AFTER,
  true,
);
const makeRoutingMarkupConservativeMatcher = makeMarkupLabelKeyedConservativeMatcher(
  ROUTING_PLACEHOLDER,
  ROUTING_LABEL_BEFORE,
  ROUTING_LABEL_AFTER,
  true,
);
const makeBankAcctMarkupConservativeMatcher = makeMarkupLabelKeyedConservativeMatcher(
  BANK_ACCT_PLACEHOLDER,
  BANK_LABEL_BEFORE,
  BANK_LABEL_AFTER,
  false,
);

/**
 * Build a label-keyed Pass-1 conservative callback for a non-SSN entry. Same
 * label-window machinery as makeSsnConservativeMatcher (astral→BMP collapse,
 * codepoint-accurate slicing, idempotency-neutralize of THIS entry's
 * placeholder), parameterized by the entry's placeholder + before/after label
 * regexes. `shortCircuitOnAggressive` distinguishes the two behaviors:
 *   - EIN / routing (true): aggressive OR labelHinted → redact unconditionally,
 *     mirroring SSN. (In practice SSN-first consumes bare-9 in aggressive mode,
 *     so this path rarely fires for routing/EIN bare-9 — documented.)
 *   - bank-acct (false): label-required in ALL modes — aggressive does NOT
 *     bypass the label test; only labelHinted (an out-of-band bank key) does.
 */
function makeLabelKeyedConservativeMatcher(
  placeholder: string,
  labelBefore: RegExp,
  labelAfter: RegExp,
  shortCircuitOnAggressive: boolean,
): (aggressive: boolean, labelHinted: boolean) => (match: string, offset: number, full: string) => string {
  return (aggressive: boolean, labelHinted: boolean) =>
    (match: string, offset: number, full: string): string => {
      if (labelHinted) return placeholder;
      if (aggressive && shortCircuitOnAggressive) return placeholder;
      const neutral = ' '.repeat(placeholder.length);
      const collapse = (cps: string[]): string =>
        cps.map((cp) => (cp.length > 1 ? '�' : cp)).join('');
      const beforeCps = Array.from(full.slice(0, offset));
      const before = collapse(beforeCps.slice(-SSN_LABEL_LOOKBACK)).split(placeholder).join(neutral);
      const afterCps = Array.from(full.slice(offset + match.length));
      const after = collapse(afterCps.slice(0, SSN_LABEL_LOOKBACK)).split(placeholder).join(neutral);
      return labelBefore.test(before) || labelAfter.test(after) ? placeholder : match;
    };
}

const makeEinConservativeMatcher = makeLabelKeyedConservativeMatcher(
  EIN_PLACEHOLDER,
  EIN_LABEL_BEFORE,
  EIN_LABEL_AFTER,
  true,
);
const makeRoutingConservativeMatcher = makeLabelKeyedConservativeMatcher(
  ROUTING_PLACEHOLDER,
  ROUTING_LABEL_BEFORE,
  ROUTING_LABEL_AFTER,
  true,
);
const makeBankAcctConservativeMatcher = makeLabelKeyedConservativeMatcher(
  BANK_ACCT_PLACEHOLDER,
  BANK_LABEL_BEFORE,
  BANK_LABEL_AFTER,
  false,
);

/**
 * A LIVE PII-pattern registry entry. SSN is the first (PII v2 milestone-1):
 * `redactSSN` ITERATES `PII_REGISTRY` and runs each entry's matchers, so the
 * entry below is the SINGLE source of truth for SSN matching — the prior inline
 * logic was MOVED here, not copied. Adding a future PII type (DOB, bank/routing,
 * card) is a new entry, no change to the iterator.
 *
 * Internal only (NOT exported): the registry is an implementation detail of
 * `redactSSN`; the module's public contract stays the 14 frozen exports.
 *
 * LOAD-BEARING — `formattedMatcher`/`aggressiveMatcher` are `() => RegExp`
 * (fresh-per-call), NOT shared RegExp instances. A global-flag (`g`) RegExp
 * carries a stateful `lastIndex`; reusing one instance across `.replace()` calls
 * (or across two SSNs in one string) leaks `lastIndex` and skips matches. Each
 * call returns a NEW RegExp so `lastIndex` always starts at 0.
 */
interface PiiRegistryEntry {
  /** Human-readable type name (diagnostic only). */
  name: string;
  /** Literal replacement for a matched span. */
  placeholder: string;
  /**
   * Pass-1 conservative bare-run callback FACTORY. The iterator calls it
   * uniformly for EVERY entry with the per-call `aggressive`/`labelHinted`
   * decision; the entry returns the actual `String.prototype.replace` callback
   * (match, offset, full) with that decision curried in. This is exactly the
   * shape `makeSsnConservativeMatcher` already returns, so SSN_ENTRY just stores
   * the function reference. A label-keyed entry (EIN/routing/bank-acct) uses the
   * threaded `aggressive`/`labelHinted` to decide whether to short-circuit or run
   * its own label-window test — the gap the prior `entry === SSN_ENTRY`
   * special-case left for non-SSN entries.
   */
  conservativeMatcher: (
    aggressive: boolean,
    labelHinted: boolean,
  ) => (match: string, offset: number, full: string) => string;
  /** Pass-2 formatted matcher. LOAD-BEARING fresh-per-call (see above). */
  formattedMatcher: () => RegExp;
  /** Pass-1 aggressive/scanning bare-run matcher. LOAD-BEARING fresh-per-call. */
  aggressiveMatcher: () => RegExp;
  /** True if an out-of-band hint (e.g. a metadata KEY) is a promoting label. */
  labelHintPredicate: (hint: string) => boolean;
  /** Whether this entry participates in redaction. */
  enabled: boolean;
  /**
   * MARKUP-aware Pass-1 conservative callback FACTORY — the rendered-HTML
   * analogue of `conservativeMatcher`. The markup iterator (`redactSSNMarkupAware`)
   * calls it with the per-call `aggressive` decision; the entry returns the actual
   * `String.prototype.replace` callback. Label-keyed entries run their label-window
   * test on a markup-STRIPPED window (tags/invisibles carry no label) with a WIDE
   * raw lookback so tag inflation cannot push the label out. `labelHinted` is NOT
   * threaded here: the markup path is the egress sink for already-rendered HTML, so
   * there is no out-of-band key — exactly as the prior SSN-only markup logic had no
   * labelHint. LOAD-BEARING fresh-per-call regexes inside (no shared lastIndex).
   */
  markupConservativeMatcher: (
    aggressive: boolean,
  ) => (match: string, offset: number, full: string) => string;
  /**
   * MARKUP-aware Pass-2 formatted matcher (rendered-HTML analogue of
   * `formattedMatcher`). Tags/invisibles tolerated between digits/separators;
   * always redacts (no label). Zero-match (`markupNeverRegex`) for entries with no
   * formatted variant (routing, bank-acct). LOAD-BEARING fresh-per-call.
   */
  markupFormattedMatcher: () => RegExp;
  /**
   * MARKUP-aware Pass-1 bare/candidate matcher (rendered-HTML analogue of
   * `aggressiveMatcher`): the digit run with tags/invisibles tolerated between
   * digits. The `markupConservativeMatcher` decides whether each hit redacts.
   * LOAD-BEARING fresh-per-call.
   */
  markupBareMatcher: () => RegExp;
}

/**
 * Build the Pass-1 conservative callback for the SSN entry, currying the
 * per-call `aggressive`/`labelHinted` decision the iterator makes. The BODY is
 * the former inline Pass-1 callback, MOVED here UNCHANGED — same label window,
 * same INVIS tolerance, same astral→BMP-sentinel collapse, same codepoint-vs-
 * UTF16 slicing, same SSN_LABEL_BEFORE/_AFTER tests, same idempotency-neutralize.
 */
function makeSsnConservativeMatcher(
  aggressive: boolean,
  labelHinted: boolean,
): (match: string, offset: number, full: string) => string {
  return (match: string, offset: number, full: string): string => {
    if (aggressive || labelHinted) return SSN_PLACEHOLDER;
    // Neutralize any existing [REDACTED-SSN] placeholder in the context window
    // to a SAME-LENGTH run before the label test, so the placeholder's literal
    // "SSN" never acts as a promoting label. This makes redactSSN IDEMPOTENT
    // (redact(redact(x)) === redact(x)) — load-bearing because egress paths
    // double-scrub (caller + primitive). Same-length (not a single space)
    // preserves the label↔number distance so the GAP check stays accurate.
    const neutral = ' '.repeat(SSN_PLACEHOLDER.length);
    // CODEPOINT-consistent gap windows. python's mmrag.py slices the label-gap by
    // CODEPOINT (`m.start()`), but a JS `full.slice(offset, …)` slices by UTF-16
    // code UNIT — so an ASTRAL char (e.g. U+1D173, a surrogate pair) counts as 2
    // in JS but 1 in python. A repeated astral run in the gap then pushes the
    // label past `SSN_LABEL_BEFORE [\s\S]{0,16}` in JS (16 units = 8 astral) while
    // python still matches (8 codepoints), so JS LEAKED a connector SSN python
    // redacts. Fix on BOTH axes: (1) slice the window as a CODEPOINT array
    // (`Array.from`), then (2) collapse every astral codepoint to a single BMP
    // sentinel so `[\s\S]{0,16}` (no `/u` — see SSN_LABEL_BEFORE) counts codepoints
    // not UTF-16 units. Using `/u` instead would also switch `/i` to full Unicode
    // case-fold (a fresh ſ→s divergence), so the collapse is the surgical fix.
    // BMP-only input is unaffected (sentinel never replaces a BMP char).
    const collapse = (cps: string[]): string =>
      cps.map((cp) => (cp.length > 1 ? '\uFFFD' : cp)).join('');
    const beforeCps = Array.from(full.slice(0, offset));
    const before = collapse(beforeCps.slice(-SSN_LABEL_LOOKBACK)).split(SSN_PLACEHOLDER).join(neutral);
    const afterCps = Array.from(full.slice(offset + match.length));
    const after = collapse(afterCps.slice(0, SSN_LABEL_LOOKBACK)).split(SSN_PLACEHOLDER).join(neutral);
    return SSN_LABEL_BEFORE.test(before) || SSN_LABEL_AFTER.test(after) ? SSN_PLACEHOLDER : match;
  };
}

/**
 * The single SSN entry. Built by MOVING the former inline `redactSSN` logic:
 *   - `conservativeMatcher` ← `makeSsnConservativeMatcher` itself (the function
 *     reference, NOT a bound call). The iterator invokes it as a factory with the
 *     per-call aggressive/labelHinted decision — same shape as every other entry.
 *   - `formattedMatcher` ← `formattedSsnRegex` (Pass 2).
 *   - `aggressiveMatcher` ← `bareNineRegex` (Pass 1's scanning regex).
 *   - `labelHintPredicate` ← `SSN_LABEL.test`.
 *   - `placeholder` ← `SSN_PLACEHOLDER`.
 */
const SSN_ENTRY: PiiRegistryEntry = {
  name: 'ssn',
  placeholder: SSN_PLACEHOLDER,
  conservativeMatcher: makeSsnConservativeMatcher,
  formattedMatcher: formattedSsnRegex,
  aggressiveMatcher: bareNineRegex,
  labelHintPredicate: (hint: string) => SSN_LABEL.test(hint),
  enabled: true,
  markupConservativeMatcher: makeSsnMarkupConservativeMatcher,
  markupFormattedMatcher: markupFormattedSsnRegex,
  markupBareMatcher: markupBareRegex(9),
};

/**
 * EIN entry (PII v2 m2). Formatted `XX-XXXXXXX` always fires in Pass 2; bare-9
 * is label-keyed (EIN_LABEL) in conservative mode. aggressiveMatcher = bareNine
 * (an EIN unformatted is a plain 9-digit run). Registry-ordered AFTER SSN so a
 * bare-9 with both an SSN and EIN label redacts as SSN (highest sensitivity).
 */
const EIN_ENTRY: PiiRegistryEntry = {
  name: 'ein',
  placeholder: EIN_PLACEHOLDER,
  conservativeMatcher: makeEinConservativeMatcher,
  formattedMatcher: formattedEinRegex,
  aggressiveMatcher: bareNineRegex,
  labelHintPredicate: (hint: string) => EIN_LABEL.test(hint),
  enabled: true,
  markupConservativeMatcher: makeEinMarkupConservativeMatcher,
  markupFormattedMatcher: markupFormattedEinRegex,
  markupBareMatcher: markupBareRegex(9),
};

/**
 * Routing-number entry (PII v2 m2). No formatted variant (formattedMatcher is a
 * zero-match regex); bare-9 label-keyed (ROUTING_LABEL) in conservative mode.
 * aggressiveMatcher = bareNine. In aggressive mode SSN-first consumes bare-9, so
 * the [REDACTED-ROUTING] placeholder appears only in conservative+labeled output
 * (documented m2 scope — per-type aggressive placeholders deferred).
 */
const ROUTING_ENTRY: PiiRegistryEntry = {
  name: 'routing',
  placeholder: ROUTING_PLACEHOLDER,
  conservativeMatcher: makeRoutingConservativeMatcher,
  formattedMatcher: neverRegex,
  aggressiveMatcher: bareNineRegex,
  labelHintPredicate: (hint: string) => ROUTING_LABEL.test(hint),
  enabled: true,
  markupConservativeMatcher: makeRoutingMarkupConservativeMatcher,
  markupFormattedMatcher: markupNeverRegex,
  markupBareMatcher: markupBareRegex(9),
};

/**
 * Bank-account entry (PII v2 m2). No fixed format → CANDIDATE + label-gate:
 * aggressiveMatcher matches a 4–17 digit candidate in ALL modes, and the
 * conservative callback redacts ONLY with a bank label nearby (it does NOT
 * short-circuit on aggressive — bank-acct is label-required even aggressively,
 * since redacting every 4–17 digit run would catastrophically over-redact ZIPs,
 * phones, invoice IDs, amounts). formattedMatcher is a zero-match regex. LAST in
 * registry order so its broad candidate never pre-empts SSN/EIN/routing.
 */
const BANK_ACCT_ENTRY: PiiRegistryEntry = {
  name: 'bank-account',
  placeholder: BANK_ACCT_PLACEHOLDER,
  conservativeMatcher: makeBankAcctConservativeMatcher,
  formattedMatcher: neverRegex,
  aggressiveMatcher: bankAcctRangeRegex,
  labelHintPredicate: (hint: string) => BANK_LABEL.test(hint),
  enabled: true,
  markupConservativeMatcher: makeBankAcctMarkupConservativeMatcher,
  markupFormattedMatcher: markupNeverRegex,
  markupBareMatcher: markupBankAcctRangeRegex,
};

/**
 * The live PII registry (PII v2 m2). Order is LOAD-BEARING (first-match-wins):
 * SSN > EIN > ROUTING > BANK_ACCT. SSN first (highest sensitivity; aggressive
 * consumes all bare-9 as [REDACTED-SSN]); EIN second (its 2-7 formatted shape is
 * unambiguous); routing third; bank-acct last (broad candidate, label-gated,
 * never pre-empts the others). Once an entry redacts a span it becomes bracketed
 * placeholder text and later entries' digit regexes can't re-match it.
 */
const PII_REGISTRY: readonly PiiRegistryEntry[] = [
  SSN_ENTRY,
  EIN_ENTRY,
  ROUTING_ENTRY,
  BANK_ACCT_ENTRY,
];

/**
 * Replace every Social Security Number in `text` with `[REDACTED-SSN]`.
 *
 * Thin iterator over `PII_REGISTRY`. For each enabled entry it runs the SAME two
 * passes the SSN logic always ran, in the SAME order:
 *   1. Pass 1 — bare-run, scanned against the ORIGINAL text. MUST run before
 *      Pass 2: the [REDACTED-SSN] placeholder contains the literal "SSN", so a
 *      bare-9 label check against the placeholder-rewritten string would treat
 *      that "SSN" as a promoting label and over-redact an unrelated 9-digit ID
 *      in the window (e.g. "Value 123-45-6789 id 987654321"). In conservative
 *      mode only runs with a nearby SSN label redact; in aggressive mode (or
 *      under a matching labelHint) all do. The per-entry conservativeMatcher
 *      carries the label-window logic; aggressive/labelHinted is decided here.
 *   2. Pass 2 — formatted run. Fresh global regex per call (`.replace()` is
 *      stateless); first-match-wins within the entry.
 *
 * For the single SSN entry the observable output is byte-identical to the prior
 * inline implementation.
 *
 * Optional aggressive pass (off by default): any bare run anywhere.
 * Everything else passes through byte-identical.
 */
export function redactSSN(
  text: string,
  opts?: { aggressive?: boolean; labelHint?: string },
): string {
  if (!text) return text;
  // Aggressive default is sourced from the env flag when not passed explicitly,
  // so every call site (PTY / outbound / persist) honors SSN_REDACT_AGGRESSIVE
  // without threading the option through each one.
  const aggressive = opts?.aggressive ?? process.env.SSN_REDACT_AGGRESSIVE === '1';

  let out = text;
  for (const entry of PII_REGISTRY) {
    if (!entry.enabled) continue;
    // labelHint carries an OUT-OF-BAND label (e.g. a JSON/metadata KEY like
    // `ssn` whose value is a bare `987654321`). When the hint is itself a
    // promoting label, every bare run in the value is treated as context-keyed —
    // the value's own surrounding text would otherwise lack the label.
    const labelHinted = !!opts?.labelHint && entry.labelHintPredicate(opts.labelHint);
    // Pass 1 — context-keyed bare run on the ORIGINAL (pre-Pass-2) text. EVERY
    // entry's conservative callback is built per call via its factory, so the
    // aggressive/labelHinted decision (env- and opts-dependent) is curried into
    // the entry's own label-window body uniformly — no per-entry special case.
    const conservative = entry.conservativeMatcher(aggressive, labelHinted);
    out = out.replace(entry.aggressiveMatcher(), conservative);
    // Pass 2 — formatted run. Fresh global regex; `.replace()` is stateless.
    out = out.replace(entry.formattedMatcher(), entry.placeholder);
  }
  return out;
}

/**
 * MARKUP-aware egress redaction — for surfaces that RENDER markdown/HTML, where
 * a markup marker interleaved in an SSN is invisible in the rendered output and
 * reassembles the number. At the Telegram sink redactSSN runs on RAW markdown,
 * then markdownToHtml turns `*bold*`/`_italic_`/`` `code` `` into <b>/<i>/<code>
 * tags Telegram renders away — so `123-45-*6789*` evades the raw matcher then
 * renders as `123-45-6789`. Same for the dashboard `.md` preview (marked → HTML).
 * This runs on the RENDERED HTML and tolerates HTML TAGS (and invisibles)
 * between digits/separators, redacting the whole span (tags inside the SSN go
 * with it; tags elsewhere are untouched). It is NOT folded into the generic
 * redactSSN: that would over-redact a literal `1*2*3` in KB/bus text where the
 * markers are NOT rendered away.
 *
 * REGISTRY-DRIVEN: `redactSSNMarkupAware` ITERATES `PII_REGISTRY` exactly as
 * `redactSSN` does for the plain-text path, calling each entry's
 * `markupBareMatcher` + `markupConservativeMatcher` (Pass 1) then
 * `markupFormattedMatcher` (Pass 2). The MARKUP primitives + per-entry markup
 * matcher builders are defined ABOVE the registry (with the plain primitives) so
 * the entries can reference them. Adding a future PII type to PII_REGISTRY thus
 * AUTOMATICALLY gets markup-aware egress with no edit to redactSSNMarkupAware.
 */
export function redactSSNMarkupAware(html: string, opts?: { aggressive?: boolean }): string {
  if (!html) return html;
  const aggressive = opts?.aggressive ?? process.env.SSN_REDACT_AGGRESSIVE === '1';
  let out = html;
  for (const entry of PII_REGISTRY) {
    if (!entry.enabled) continue;
    // Pass 1 — bare/candidate run, markup tolerated between digits. The entry's
    // markup conservative callback decides (aggressive short-circuit and/or its
    // own markup-STRIPPED label-window test). Scanned against the CURRENT text so
    // an earlier entry's placeholder is honored (digit regexes can't re-match it).
    const conservative = entry.markupConservativeMatcher(aggressive);
    out = out.replace(entry.markupBareMatcher(), conservative);
    // Pass 2 — formatted run, markup tolerated between digits/separators. Fresh
    // global regex; `.replace()` is stateless. Zero-match for entries with no
    // formatted variant. Each group keeps its exact digit count (a phone is not
    // matched by the SSN 3-2-4 shape; an SSN is not matched by the EIN 2-7 shape).
    out = out.replace(entry.markupFormattedMatcher(), entry.placeholder);
  }
  return out;
}

/**
 * True if `text` contains an SSN under the conservative ruleset (formatted or
 * context-keyed). Derived from `redactSSN` so the two can never drift.
 */
export function detectSSN(text: string): boolean {
  if (!text) return false;
  return redactSSN(text) !== text;
}

/** A complete formatted SSN occupying the entire string, invisibles tolerated
 *  between digits/separators (same primitives as formattedSsnRegex). */
const COMPLETE_SSN = new RegExp(
  `^${ssnDigits(3)}${INVIS}${SSN_SEP}${INVIS}${ssnDigits(2)}${INVIS}${SSN_SEP}${INVIS}${ssnDigits(4)}$`,
  'u',
);

/**
 * A trailing substring that could be the PREFIX of a FORMATTED SSN split
 * across a chunk boundary, anchored at end-of-string. It must hold EVERY
 * proper prefix of `\d{3}[-.\t ]\d{2}[-.\t ]\d{4}` so no boundary position can
 * leak — including a split inside the first group (`1`, `12`) and a split
 * immediately after a separator (`123-`, `123-45-`). Hence the leading group
 * is `\d{1,3}` (not an anchored `\d{3}`) and the later digit counts allow
 * zero (`\d{0,2}` / `\d{0,4}`). The COMPLETE_SSN guard in
 * splitTrailingPartialSsn recognises a whole SSN sitting at the chunk end so
 * it is emitted (caught in-chunk) rather than split by the holdback. The
 * separator class is `SSN_SEP` (ASCII + Unicode Zs spaces), identical to Pass 1, so a DOTTED SSN split
 * across the boundary is held and reassembled too.
 *
 * Examples held: `1` `12` `123` `123-` `123-4` `123-45` `123-45-`
 *   `123-45-6` `123-45-67` `123-45-678` `123.45` `123.45.6`
 *
 * The leading `\b` is load-bearing: it anchors the candidate at a word
 * boundary so the holdback can only grab a digit fragment that STARTS a
 * token, never the tail of a longer digit run. A real SSN first-group
 * fragment (`1`, `12`, `123 `) always sits at a boundary, so `\b` keeps
 * those held while excluding mid-run tails. The separator class is the same
 * HORIZONTAL-only `[-.\t ]` as Pass 1, so a trailing `<number>\n` is never
 * held (newline excluded) and a bare-9 run before a newline is not split.
 */
// INVIS-aware: every proper prefix of an invisible-laced formatted SSN, so a
// split `1<ZWSP>23-45-67` | `89` is held and reassembled exactly like the
// same-chunk matcher (formattedSsnRegex) would catch it. INVIS interleaves
// between digits and around each SSN_SEP; trailing INVIS lets a partial that
// ends in invisibles be held. `u` flag for \p{} in INVIS. The MAX-length cap in
// splitTrailingPartialSsn bounds the hold (DoS-prevention) since INVIS is `*`.
const PARTIAL_SSN_AT_END = new RegExp(
  `${SSN_LEAD}\\d(?:${INVIS}\\d){0,2}` +
    `(?:${INVIS}${SSN_SEP}${INVIS}(?:\\d(?:${INVIS}\\d)?)?` +
    `(?:${INVIS}${SSN_SEP}${INVIS}(?:\\d(?:${INVIS}\\d){0,3})?)?)?` +
    `${INVIS}$`,
  'u',
);

/**
 * Longest a held partial-SSN tail may grow before we stop withholding it. A
 * complete formatted SSN is 11 visible chars; 64 leaves margin for invisibles
 * interleaved in an invisible-laced partial (PARTIAL_SSN_AT_END tolerates INVIS)
 * while still bounding the hold so an absurd all-invisible tail is emitted, not
 * withheld (DoS-prevention — the cap is the bound now that INVIS is unbounded).
 */
export const MAX_PARTIAL_SSN_HOLDBACK = 64;

/**
 * Split `data` into `[emit, hold]` where `hold` is a trailing substring that
 * could be the prefix of a FORMATTED SSN continuing in the next chunk. The
 * caller (OutputBuffer.push) prepends `hold` to the next chunk before
 * redacting, so an SSN split across the OS chunk boundary is reassembled and
 * caught by `redactSecrets`.
 *
 * Two deliberate non-holds, mirroring `splitTrailingPartialJwt`:
 *   - Candidate already a COMPLETE SSN: `redactSecrets` catches it in THIS
 *     chunk, so emit now — withholding it would actually SPLIT the complete
 *     match and let the leading bytes through unredacted.
 *   - Candidate longer than MAX_PARTIAL_SSN_HOLDBACK: not an SSN prefix; emit.
 *
 * A context-keyed partial whose NUMBER is split mid-run with no nearby label
 * in the held region is the one remaining residual (Layer 2 backstops the
 * persistence/outbound surfaces; for stdout.log it is bounded). The far more
 * common label-then-number split is handled by splitTrailingPartialSsnLabel.
 */
export function splitTrailingPartialSsn(data: string): [string, string] {
  const m = data.match(PARTIAL_SSN_AT_END);
  if (!m || m.index === undefined) return [data, ''];
  const candidate = m[0];
  if (candidate.length > MAX_PARTIAL_SSN_HOLDBACK) return [data, ''];
  if (COMPLETE_SSN.test(candidate)) return [data, ''];
  return [data.slice(0, m.index), candidate];
}

/** Longest a held trailing-label region may grow (label ~15 + gap 16 + margin). */
export const MAX_PARTIAL_SSN_LABEL_HOLDBACK = 40;

/**
 * A trailing SSN LABEL (optionally followed by up to SSN_LABEL_GAP gap chars,
 * which may already include the start of a number) at the END of a chunk. Held
 * back so the next chunk's number reassembles WITH its label context — closes
 * the context-keyed `SSN:\n987654321` / `SSN: ` | `987654321` chunk-split that
 * would otherwise write the bare number raw to stdout.log (a Layer-1-only sink,
 * NOT Layer-2 backstopped). `[\s\S]` so a label split from its number by a
 * newline is held too.
 */
const PARTIAL_SSN_LABEL_AT_END = new RegExp(`${LABEL_ALT}[\\s\\S]{0,16}$`, 'i');

export function splitTrailingPartialSsnLabel(data: string): [string, string] {
  // Neutralize any [REDACTED-SSN] placeholder (same-length, so indices are
  // preserved) so the literal "SSN" inside it is not matched as a trailing
  // label — otherwise the holdback would split an already-redacted placeholder.
  const probe = data.split(SSN_PLACEHOLDER).join(' '.repeat(SSN_PLACEHOLDER.length));
  const m = probe.match(PARTIAL_SSN_LABEL_AT_END);
  if (!m || m.index === undefined) return [data, ''];
  const hold = data.slice(m.index);
  if (hold.length > MAX_PARTIAL_SSN_LABEL_HOLDBACK) return [data, ''];
  return [data.slice(0, m.index), hold];
}

/** True if `s` is (or contains) an SSN promoting label — exported for callers
 *  that key on an out-of-band label (e.g. a metadata KEY). Now a thin delegate
 *  to the registry resolver (SSN entry's labelHintPredicate) so the SSN entry
 *  stays the SINGLE source for what counts as an SSN label. */
export function isSsnLabel(s: string | undefined): boolean {
  return !!s && SSN_ENTRY.labelHintPredicate(s);
}

/**
 * Registry-level label resolver (F6 SSOT). Returns `key` if it is a promoting
 * label for ANY enabled PII_REGISTRY entry (SSN/EIN/routing/bank), else
 * undefined. This is the ONE source callers use to decide whether an
 * out-of-band KEY (e.g. an event-metadata key) should be inherited by a nested
 * value as that value's labelHint — generalizing the SSN-only `isSsnLabel`
 * check so `ein`/`routing_number`/`bank_account` keys promote their nested
 * child exactly as `ssn`/`tax id` always did. Do NOT hand-roll a parallel label
 * list at any call site — extend the registry instead.
 *
 * Registry-order first-match-wins: an `ssn`-ish key resolves to the SSN entry's
 * label first (highest sensitivity), but since the RETURN is the key itself
 * (not an entry), the downstream redactSSN(value, {labelHint: key}) re-tests the
 * key against EVERY entry's predicate anyway — so the only observable effect is
 * "inherit the key vs inherit nothing". An `ssn`/`tax id` wrapper key still
 * returns the key (SSN entry matches), keeping SSN inheritance byte-identical.
 */
// WINDOW-FREE anchored KEY matchers for the new entries. The in-text
// `*_LABEL_BEFORE/AFTER` carry a `[\s\S]{0,16}` window (label near the NUMBER in
// free text); a metadata KEY has no number — the key IS the label — so the window
// is wrong here (a real label buried >16 chars from both ends would under-resolve
// = leak direction). These reuse the SAME label ALTs + boundary discipline as the
// in-text matchers (SSOT: letter-boundary; routing ASYMMETRIC `(?![a-z0-9_])` to
// keep `routing_table`/`routing_protocol` OUT) but drop the window and `.test()`
// the key anywhere. SSN is intentionally NOT anchored here (see piiLabelKeyHint).
const EIN_KEY = new RegExp(`(?<![a-z])${EIN_LABEL_ALT}(?![a-z])`, 'i');
const ROUTING_KEY = new RegExp(`(?<![a-z])${ROUTING_LABEL_ALT}(?![a-z0-9_])`, 'i');
const BANK_KEY = new RegExp(`(?<![a-z])${BANK_LABEL_ALT}(?![a-z])`, 'i');

export function piiLabelKeyHint(key: string | undefined): string | undefined {
  if (!key) return undefined;
  // SSN stays UNANCHORED (isSsnLabel) — byte-identical to the m1 baseline; its
  // roots (ssn/social security/tax id) do not substring-collide with common keys.
  // A rare key containing the bare "ssn" substring (e.g. "passnote") over-promotes
  // as it did in m1 — pre-existing approved behavior; anchoring it would break SSN
  // byte-identity (a separate David tradeoff), so it is NOT changed here.
  if (isSsnLabel(key)) return key;
  // EIN/routing/bank: WINDOW-FREE anchored key match, so organic keys
  // (caffeine_level/vein_count/protein_grams/routing_table) do NOT over-promote
  // their bare-9/candidate value, while real keys (ein/ein_number/routing_number/
  // aba_routing/bank_account/account_number) and long-buried-label keys resolve.
  if (EIN_KEY.test(key) || ROUTING_KEY.test(key) || BANK_KEY.test(key)) return key;
  return undefined;
}

/** Longest a held trailing label-PREFIX region may grow. A label token is
 *  short (≤~15 chars); cap bounds worst-case held bytes. */
export const MAX_PARTIAL_SSN_LABEL_PREFIX_HOLDBACK = 20;

/**
 * A PROPER (strictly shorter than the complete token), ≥2-char prefix of an
 * SSN label, anchored at the END of a chunk. Kept in lockstep with SSN_LABEL:
 *   - `ss`            — proper prefix of `ssn`
 *   - `so…securit`    — every proper prefix of `social[\s_]+security`, from
 *                       `so` through `social securit` (the complete
 *                       `…security` is left to splitTrailingPartialSsnLabel)
 *   - `ta…i`          — `ta`, `tax`, and `tax[\s_]*i` (`taxi`, `tax i`, `tax_i`),
 *                       every proper prefix of `tax[\s_]*id`
 * The nested optionals make each character of the label optional left-to-right,
 * so the alternative matches at ANY mid-token cut. Greedy + `$`-anchored, so a
 * longer prefix (`social securit`) is preferred over a shorter (`so`).
 */
const PARTIAL_SSN_LABEL_PREFIX_AT_END =
  /(?:ss|so(?:c(?:i(?:a(?:l(?:[\s_]+(?:s(?:e(?:c(?:u(?:r(?:it?)?)?)?)?)?)?)?)?)?)?)?|ta(?:x(?:[\s_]*i)?)?)$/i;

/**
 * Hold a trailing PARTIAL label TOKEN split MID-TOKEN across the OS chunk
 * boundary — the `SS` | `N: 987654321` case that splitTrailingPartialSsnLabel
 * misses because its regex needs a COMPLETE label token. Without this, a label
 * cut anywhere inside its own characters (`socia` | `l security 987654321`,
 * `tax i` | `d 987654321`) lets the number reach the next chunk with no label
 * context, so the context-keyed pass never fires and the bare 9-digit run is
 * written raw to stdout.log (a Layer-1-only sink, NOT Layer-2 backstopped).
 *
 * FP-SAFE BY CONSTRUCTION (latency, never loss, never a false mask): the held
 * bytes are re-emitted — prepended to the next chunk and re-scanned by push().
 * A tail that merely LOOKS like a label prefix (`across`/`loss`/`business` end
 * in `ss`; `data` ends in `ta`; `also` ends in `so`) is HELD for exactly one
 * chunk, then on reassembly either completes to a label+number (redacted) or
 * fails to and is emitted byte-for-byte. It is never masked and never dropped:
 * close() flushes a no-digit held tail verbatim, and getRecent() appends the
 * pending tail so detection still sees the full text. Over-holding common
 * word-endings is the deliberate, bounded cost of closing the class.
 *
 * RESIDUAL (bounded, documented in SPEC): a label split with only ONE char on
 * the left of the boundary (`s` | `ocial security …`) is not held — holding
 * every chunk ending in a single common letter is the unbounded-latency surface
 * the ≥2-char floor avoids. A 1-char-aligned split of a label token is
 * astronomically rare given KB-sized PTY chunks.
 */
export function splitTrailingPartialSsnLabelPrefix(data: string): [string, string] {
  // Neutralize the placeholder (same-length, indices preserved) so the literal
  // "SSN" inside [REDACTED-SSN] is never read as a trailing label prefix.
  const probe = data.split(SSN_PLACEHOLDER).join(' '.repeat(SSN_PLACEHOLDER.length));
  const m = probe.match(PARTIAL_SSN_LABEL_PREFIX_AT_END);
  if (!m || m.index === undefined) return [data, ''];
  const hold = data.slice(m.index);
  if (hold.length > MAX_PARTIAL_SSN_LABEL_PREFIX_HOLDBACK) return [data, ''];
  return [data.slice(0, m.index), hold];
}

/**
 * True if a held tail carries partial-SSN MATERIAL — a digit group plus a
 * separator (e.g. `123-45-67`, `123 45`). Used at PTY close() to decide
 * whether to mask a withheld tail or emit it verbatim. A bare digit run with
 * no separator (e.g. `123`) carries no SSN structure and is emitted as-is.
 */
export function isPartialSsnMaterial(tail: string): boolean {
  // INVIS-aware (matches the invisible-laced holdback): a 3-digit group, a
  // separator, and a 4th digit, with invisibles tolerated between.
  return new RegExp(`${ssnDigits(3)}${INVIS}${SSN_SEP}${INVIS}\\d`, 'u').test(tail);
}

// ===========================================================================
// PII v2 m2 — STREAMING HOLDBACK for the new registry entries (EIN, routing,
// bank-account). PARALLEL to the SSN holdback machinery above; the SSN helpers
// stay BYTE-IDENTICAL (these are additive). The OutputBuffer (output-buffer.ts)
// holds the LONGEST tail across ALL hold-types, so a labeled new-entry value
// split across an OS chunk boundary reassembles WITH its label/format context
// and `redactSecrets`→`redactSSN` (conservative) fires on the reassembled chunk
// — closing the same Layer-1-only stdout.log leak class the SSN holdbacks close.
//
// THREE hold mechanisms for the new entries:
//   1. splitTrailingPartialEin — a trailing partial FORMATTED EIN (`12-345`),
//      mirroring splitTrailingPartialSsn (the only new entry with a fixed format).
//   2. splitTrailingPartialNewEntryLabel — a trailing COMPLETE new-entry label
//      (+gap), mirroring splitTrailingPartialSsnLabel. Bank-acct has NO formatted
//      partial, so its (and routing's, and a bare-9 EIN's) hold IS the label hold.
//   3. splitTrailingPartialNewEntryLabelPrefix — a trailing PARTIAL label TOKEN
//      split mid-token (`routi`, `bank acc`, `ei`), mirroring
//      splitTrailingPartialSsnLabelPrefix. FP-safe by construction: held bytes
//      are re-emitted next chunk, never masked or dropped.
// ===========================================================================

/**
 * Longest a held partial formatted-EIN tail may grow. A complete formatted EIN
 * is 10 visible chars (`12-3456789`); 64 (same as SSN) leaves margin for
 * interleaved invisibles while bounding the hold (DoS-prevention — the cap is the
 * bound now that INVIS is unbounded). Mirrors MAX_PARTIAL_SSN_HOLDBACK.
 */
export const MAX_PARTIAL_EIN_HOLDBACK = 64;

/** A complete formatted EIN (`\d{2}<sep>\d{7}`) occupying the entire string,
 *  invisibles tolerated — emitted (caught in-chunk) rather than split. Mirrors
 *  COMPLETE_SSN. */
const COMPLETE_EIN = new RegExp(`^${ssnDigits(2)}${INVIS}${SSN_SEP}${INVIS}${ssnDigits(7)}$`, 'u');

/**
 * Every proper prefix of a FORMATTED EIN `\d{2}<sep>\d{7}` at end-of-string,
 * INVIS-tolerant, `\b`-anchored at the start so only a digit fragment that STARTS
 * a token is grabbed (never a mid-run tail). Holds `1`, `12`, `12-`, `12-3` …
 * `12-345678` (the complete `12-3456789` is recognised by COMPLETE_EIN in
 * splitTrailingPartialEin and emitted in-chunk). Mirrors PARTIAL_SSN_AT_END.
 */
const PARTIAL_EIN_AT_END = new RegExp(
  `${SSN_LEAD}\\d(?:${INVIS}\\d)?` +
    `(?:${INVIS}${SSN_SEP}${INVIS}(?:\\d(?:${INVIS}\\d){0,5})?)?` +
    `${INVIS}$`,
  'u',
);

/**
 * Split `data` into `[emit, hold]` where `hold` is a trailing substring that
 * could be the prefix of a FORMATTED EIN continuing in the next chunk
 * (`EIN 12-345` | `6789`). Mirrors splitTrailingPartialSsn: a candidate that is
 * already a COMPLETE EIN is emitted (caught in-chunk; withholding would split the
 * complete match); a candidate over the cap is emitted (not an EIN prefix).
 *
 * NOTE: a BARE 9-digit EIN split mid-run with no nearby label is the same bounded
 * residual as the SSN case — handled by the label holdbacks when a label is
 * present, and Layer-2 backstops the persistence/outbound surfaces.
 */
export function splitTrailingPartialEin(data: string): [string, string] {
  const m = data.match(PARTIAL_EIN_AT_END);
  if (!m || m.index === undefined) return [data, ''];
  const candidate = m[0];
  if (candidate.length > MAX_PARTIAL_EIN_HOLDBACK) return [data, ''];
  if (COMPLETE_EIN.test(candidate)) return [data, ''];
  return [data.slice(0, m.index), candidate];
}

/** Longest a held new-entry trailing-label region may grow (label ~22 chars for
 *  `employer identification` + gap 16 + margin). Mirrors MAX_PARTIAL_SSN_LABEL_HOLDBACK. */
export const MAX_PARTIAL_NEW_ENTRY_LABEL_HOLDBACK = 48;

/** The UNION of the three new-entry label alternations (EIN ∪ routing ∪ bank),
 *  LETTER-CLASS-boundary anchored exactly like their in-text matchers
 *  (`(?<![a-z])…(?![a-z])`), so the short roots ein/fein/aba do not over-hold
 *  inside protein/Alibaba (a letter sits on the boundary) yet a snake_case label
 *  (`routing_number`, `ein_number`, `bank_account_number`) at the chunk END IS
 *  held — matching the in-text matchers' boundary so streaming and same-chunk
 *  redaction can never diverge on snake_case. A trailing complete label (+ up to
 *  SSN_LABEL_GAP gap chars, which may already include the start of the value) is
 *  held so the next chunk's value reassembles WITH its label. `[\s\S]` so a label
 *  split from its value by a newline is held too. Mirrors PARTIAL_SSN_LABEL_AT_END. */
const NEW_ENTRY_LABEL_AT_END = new RegExp(
  `(?<![a-z])(?:${EIN_LABEL_ALT}|${ROUTING_LABEL_ALT}|${BANK_LABEL_ALT})(?![a-z])[\\s\\S]{0,16}$`,
  'i',
);

/**
 * Neutralize every PII placeholder to a same-length blank run (indices
 * preserved) so a placeholder's own literal text is never read as a trailing
 * label/label-prefix. Critically `[REDACTED-BANK-ACCT]` contains `BANK-ACCT`,
 * and `-` is in LABEL_SEP, so without this the bank label would match INSIDE the
 * placeholder and the holdback would split an already-redacted span. Mirrors the
 * placeholder-neutralize the SSN holdbacks do for `[REDACTED-SSN]`.
 */
function neutralizePlaceholders(data: string): string {
  let probe = data;
  for (const ph of [SSN_PLACEHOLDER, EIN_PLACEHOLDER, ROUTING_PLACEHOLDER, BANK_ACCT_PLACEHOLDER]) {
    probe = probe.split(ph).join(' '.repeat(ph.length));
  }
  return probe;
}

export function splitTrailingPartialNewEntryLabel(data: string): [string, string] {
  const probe = neutralizePlaceholders(data);
  const m = probe.match(NEW_ENTRY_LABEL_AT_END);
  if (!m || m.index === undefined) return [data, ''];
  const hold = data.slice(m.index);
  if (hold.length > MAX_PARTIAL_NEW_ENTRY_LABEL_HOLDBACK) return [data, ''];
  return [data.slice(0, m.index), hold];
}

/** Longest a held new-entry label-PREFIX region may grow. The longest label token
 *  (`employer identification` ~23) bounds it; 28 leaves margin. Mirrors
 *  MAX_PARTIAL_SSN_LABEL_PREFIX_HOLDBACK. */
export const MAX_PARTIAL_NEW_ENTRY_LABEL_PREFIX_HOLDBACK = 28;

/**
 * Build a regex matching every NON-EMPTY (≥2-char, mirroring the SSN prefix
 * floor) PROPER prefix of `phrase`, anchored at end-of-string. `phrase` is a
 * label form whose inter-word separators are written as the literal token
 * `<SEP>` (expanded to LABEL_SEP here). Each successive character/token is made
 * optional left-to-right via nested optionals, so a cut ANYWHERE mid-token
 * matches. Built once at module load. ASCII `/i` (no `u`) — JS↔python parity-safe
 * for the ASCII label words.
 */
function buildPrefixAlternative(phrase: string): string {
  // Tokenize into atoms: a literal char OR a `<SEP>+`/`<SEP>*` separator atom.
  const atoms: string[] = [];
  let i = 0;
  while (i < phrase.length) {
    if (phrase.startsWith('<SEP+>', i)) {
      atoms.push(`${LABEL_SEP}+`);
      i += 6;
    } else if (phrase.startsWith('<SEP*>', i)) {
      atoms.push(`${LABEL_SEP}*`);
      i += 6;
    } else {
      // Escape regex-special literal chars (none of the label words have any,
      // but be safe).
      atoms.push(phrase[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      i += 1;
    }
  }
  // First atom REQUIRED (≥1 char on the left of the cut), rest nested-optional.
  // The ≥2-char floor is enforced by requiring the first TWO atoms before the
  // optional tail — but a separator atom is `*`/`+` so we keep it simple: require
  // the first atom, then nest the remainder; common 1-char word-endings are
  // handled by the same FP-safe re-emit contract as the SSN prefix holdback.
  let inner = '';
  for (let k = atoms.length - 1; k >= 1; k--) {
    inner = `(?:${atoms[k]}${inner})?`;
  }
  return `${atoms[0]}${inner}`;
}

// Label forms (first word omitted is impossible — each starts at a word boundary).
// `<SEP+>` / `<SEP*>` mark the canonical inter-word separators (LABEL_SEP+ / *).
const NEW_ENTRY_LABEL_FORMS = [
  // EIN
  'fein',
  'ein',
  'employer<SEP+>identification',
  'employer<SEP+>id',
  'federal<SEP+>tax<SEP*>id',
  // routing
  'routing',
  'aba',
  // bank
  'bank<SEP+>account',
  'account<SEP+>number',
  'bank<SEP+>acct',
];

/**
 * A PROPER, ≥2-char prefix of ANY new-entry label form, anchored at the END of a
 * chunk and LETTER-CLASS-boundary anchored at the start `(?<![a-z])` (only a
 * fragment STARTING a token, NOT glued to a preceding letter, is grabbed).
 * Letter-boundary (not `\b`) so a snake_case key split mid-token across the chunk
 * boundary (`…_routi` | `ng_number 021…`) is still held — `\b` would treat the
 * leading `_` as a word char and skip the hold, leaving the value to reassemble
 * unredacted only if the in-text matcher later catches it. Mirrors
 * PARTIAL_SSN_LABEL_PREFIX_AT_END (which has no start anchor) but UNION over
 * EIN/routing/bank label forms, generated from NEW_ENTRY_LABEL_FORMS. Greedy +
 * `$`-anchored, so a longer prefix (`bank acc`) is preferred over a shorter (`ba`).
 */
const NEW_ENTRY_LABEL_PREFIX_AT_END = new RegExp(
  `(?<![a-z])(?:${NEW_ENTRY_LABEL_FORMS.map(buildPrefixAlternative).join('|')})$`,
  'i',
);

/**
 * Hold a trailing PARTIAL new-entry label TOKEN split MID-TOKEN across the OS
 * chunk boundary — the `routi` | `ng 021000021` / `bank acc` | `ount 12345678` /
 * `ei` | `n 12-3456789` cases that splitTrailingPartialNewEntryLabel misses
 * (it needs a COMPLETE label token). Mirrors splitTrailingPartialSsnLabelPrefix.
 *
 * FP-SAFE BY CONSTRUCTION (latency, never loss, never a false mask): the held
 * bytes are re-emitted — prepended to the next chunk and re-scanned by push().
 * A tail that merely LOOKS like a label prefix is held for exactly one chunk,
 * then on reassembly either completes to label+value (redacted) or fails and is
 * emitted byte-for-byte. close() flushes a no-digit held tail verbatim.
 */
export function splitTrailingPartialNewEntryLabelPrefix(data: string): [string, string] {
  // Neutralize placeholders (same reason as splitTrailingPartialNewEntryLabel):
  // a placeholder's trailing chars (e.g. `…ACCT]`) must not be read as a label
  // prefix and split the already-redacted span.
  const probe = neutralizePlaceholders(data);
  const m = probe.match(NEW_ENTRY_LABEL_PREFIX_AT_END);
  if (!m || m.index === undefined) return [data, ''];
  const hold = data.slice(m.index);
  if (hold.length > MAX_PARTIAL_NEW_ENTRY_LABEL_PREFIX_HOLDBACK) return [data, ''];
  return [data.slice(0, m.index), hold];
}

/**
 * True if a held tail carries partial NEW-ENTRY material that must be MASKED (not
 * emitted verbatim) at PTY close(): a trailing partial FORMATTED EIN with a
 * separator and a digit on each side (`12-3`). A bare digit run with no separator,
 * or a label region with no digits, carries no fixed-format secret and is emitted
 * verbatim by close() (the SSN/digit/label branches already handle those). Mirrors
 * isPartialSsnMaterial. Routing/bank have NO fixed format, so a mid-run digit
 * split with no label is not maskable material here (it is the same bounded
 * residual as the SSN bare-run case) — only the formatted-EIN partial is masked.
 */
export function isPartialNewEntryMaterial(tail: string): boolean {
  // INVIS-aware: a 2-digit group, a separator, and a digit — a partial formatted EIN.
  return new RegExp(`${ssnDigits(2)}${INVIS}${SSN_SEP}${INVIS}\\d`, 'u').test(tail);
}
