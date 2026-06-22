import type { Priority, EventCategory, EventSeverity, ApprovalCategory } from '../types/index.js';
import { VALID_PRIORITIES } from '../types/index.js';
import { resolve as pathResolve, sep as pathSep, dirname as pathDirname } from 'path';
import { existsSync, realpathSync } from 'fs';

const AGENT_NAME_REGEX = /^[a-z0-9_-]+$/;
// Org segments may preserve framework casing (e.g. AcmeCorp) — getOrgs() does
// NOT lowercase them — so the path-safety org check allows mixed case. (This is
// separate from validateOrgName, which gates lowercase org CREATION via the CLI.)
const ORG_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Path-safety helpers (dashboard + import-agent path traversal hardening)
// ---------------------------------------------------------------------------

/**
 * Decode a URL-encoded path segment to a FIXED POINT. Next.js route params are
 * already decoded once by the router; several API routes then decode AGAIN —
 * so `%252e%252e%252f` survives as `../`. Decoding to a fixed point (then
 * validating) collapses any depth of encoding so the regex sees the real value.
 * Throws on malformed encoding (caller should map to HTTP 400, not 500).
 */
export function decodeToFixedPoint(s: string): string {
  let cur = s;
  for (let i = 0; i < 6; i++) {
    let next: string;
    try { next = decodeURIComponent(cur); }
    catch { throw new Error(`Malformed URL encoding in '${s}'`); }
    if (next === cur) return cur;
    cur = next;
  }
  throw new Error(`Excessively-encoded value '${s}'`);
}

/** Validate an agent/skill name segment (lowercase id), after full decode. */
export function assertSafeName(name: string): string {
  const decoded = decodeToFixedPoint(String(name ?? ''));
  if (!decoded || !AGENT_NAME_REGEX.test(decoded)) {
    throw new Error(`Invalid name segment '${name}'. Allowed: [a-z0-9_-].`);
  }
  return decoded;
}

/** Validate an org segment (mixed-case allowed), after full decode. */
export function assertSafeOrgSegment(org: string): string {
  const decoded = decodeToFixedPoint(String(org ?? ''));
  if (!decoded || !ORG_SEGMENT_REGEX.test(decoded)) {
    throw new Error(`Invalid org segment '${org}'. Allowed: [A-Za-z0-9_-].`);
  }
  return decoded;
}

/**
 * Assert `target` resolves INSIDE `baseDir`. Defeats both base-segment escape
 * (string startsWith against a FIXED base) AND symlinked ancestors (realpath the
 * deepest existing ancestor and re-check). Throws if it escapes.
 */
export function assertContainedWithin(baseDir: string, target: string): string {
  const base = pathResolve(baseDir);
  const resolved = pathResolve(base, target);
  if (resolved !== base && !resolved.startsWith(base + pathSep)) {
    throw new Error(`Path escapes base: ${target}`);
  }
  // Symlink defense: realpath the deepest EXISTING ancestor of resolved.
  const realBase = existsSync(base) ? realpathSync(base) : base;
  let probe = resolved;
  while (!existsSync(probe) && probe !== pathDirname(probe)) probe = pathDirname(probe);
  const realProbe = existsSync(probe) ? realpathSync(probe) : probe;
  if (realProbe !== realBase && !realProbe.startsWith(realBase + pathSep)) {
    throw new Error(`Path escapes base via symlink: ${target}`);
  }
  return resolved;
}
// Task IDs are generated as `task_<epoch>_<rand>` (lowercase). Allow lowercase
// letters, digits, underscores and hyphens — matching the generator and the
// rest of the codebase's identifier convention — while rejecting path
// separators and dots so a task id can never traverse out of the task tree.
const TASK_ID_REGEX = /^[a-z0-9_-]+$/;

export function validateTaskId(taskId: string): void {
  if (!taskId || !TASK_ID_REGEX.test(taskId)) {
    throw new Error(
      `Invalid task id '${taskId}'. Must contain only letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validateInstanceId(instanceId: string): void {
  if (!instanceId || !AGENT_NAME_REGEX.test(instanceId)) {
    throw new Error(
      `Invalid instance ID '${instanceId}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validateAgentName(name: string): void {
  if (!name || !AGENT_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid agent name '${name}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validateOrgName(org: string): void {
  if (!org || !AGENT_NAME_REGEX.test(org)) {
    throw new Error(
      `Invalid org name '${org}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validatePriority(priority: string): asserts priority is Priority {
  if (!VALID_PRIORITIES.includes(priority as Priority)) {
    throw new Error(
      `Invalid priority '${priority}'. Must be one of: ${VALID_PRIORITIES.join(', ')}`
    );
  }
}

const VALID_CATEGORIES: EventCategory[] = [
  'action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval',
];

export function validateEventCategory(category: string): asserts category is EventCategory {
  if (!VALID_CATEGORIES.includes(category as EventCategory)) {
    throw new Error(
      `Invalid event category '${category}'. Must be one of: ${VALID_CATEGORIES.join(', ')}`
    );
  }
}

const VALID_SEVERITIES: EventSeverity[] = ['info', 'warning', 'error', 'critical'];

export function validateEventSeverity(severity: string): asserts severity is EventSeverity {
  if (!VALID_SEVERITIES.includes(severity as EventSeverity)) {
    throw new Error(
      `Invalid severity '${severity}'. Must be one of: ${VALID_SEVERITIES.join(', ')}`
    );
  }
}

const VALID_APPROVAL_CATEGORIES: ApprovalCategory[] = [
  'external-comms', 'financial', 'deployment', 'data-deletion', 'other',
];

export function validateApprovalCategory(category: string): asserts category is ApprovalCategory {
  if (!VALID_APPROVAL_CATEGORIES.includes(category as ApprovalCategory)) {
    throw new Error(
      `Invalid approval category '${category}'. Must be one of: ${VALID_APPROVAL_CATEGORIES.join(', ')}`
    );
  }
}

export function validateModel(model: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw new Error(`Invalid model name '${model}'. Must be alphanumeric with dots and hyphens.`);
  }
}

export function isValidJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip terminal control sequences and non-printable characters from external input.
 * Applied to all inbound Telegram text, captions, and callback data before PTY injection.
 * Prevents terminal injection attacks via crafted Telegram messages.
 */
export function stripControlChars(input: string): string {
  return input
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')    // ANSI CSI sequences (e.g. \e[31m)
    .replace(/\x1b\][^\x07]*\x07/g, '')         // OSC sequences (e.g. \e]0;title\a)
    .replace(/\x1b[^[\]]/g, '')                  // Other ESC sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // Control chars (keep \t=0x09, \n=0x0a, \r=0x0d)
}

/**
 * Wrap untrusted text as a code-fenced block that the body CANNOT escape, with
 * zero mutation of the body itself (legit code blocks survive byte-exact).
 *
 * Attack (Hoffman disclosure 2026-06-04): a fixed triple-backtick wrapper is
 * closed by any ``` the body contains, after which injected text reads as
 * top-level prompt and can forge `=== AGENT MESSAGE` / `=== TELEGRAM`
 * containment headers, impersonating the daemon in the recipient PTY.
 *
 * Fix uses the CommonMark rule "a fence is closed only by a run of backticks
 * >= the opening run": size the wrapper to (longest backtick run in body) + 1,
 * minimum 3. The body's own fences (even a ```` block discussing fences) are
 * then strictly shorter than the wrapper and cannot close it — and nothing in
 * the body is altered, so pasted code stays readable. Control chars are still
 * stripped.
 *
 * Use for the FENCED body of an injection block (inbox text, Telegram text).
 * For unfenced context fields use sanitizeForPtyInjection instead.
 */
export function wrapFenceSafe(input: string): string {
  const body = stripControlChars(input);
  let longest = 0;
  const runs = body.match(/`+/g);
  if (runs) for (const r of runs) longest = Math.max(longest, r.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

/**
 * Neutralize PTY structural-injection vectors in untrusted text that is
 * injected WITHOUT a protective fence — the context-preview fields
 * (`[Replying to: "..."]`, `[Your last message: "..."]`,
 * `[Recent conversation:] ...`). These have no wrapper to size, so a stray
 * fence-open or a forged header line is neutralized directly:
 *  - normalize carriage returns to newlines FIRST: stripControlChars keeps
 *    \r (0x0d), and a bare CR renders the following text at terminal column 0,
 *    so a `text\r=== AGENT MESSAGE` payload would visually present a header the
 *    `^` line-anchor never matched (CR is not a line start). Folding CR into LF
 *    makes the header-quote anchor see it (designer pre-validation finding);
 *  - collapse any run of 3+ backticks to 2 so the preview cannot open a fence
 *    that swallows following real structure (survives input transforms — no
 *    zero-width reliance);
 *  - prefix forged `=== AGENT MESSAGE` / `=== TELEGRAM` / `Reply using:
 *    cortextos bus` lines with [quoted] so they read as content. The leading-
 *    whitespace class must match every Unicode space char a downstream parser's
 *    `.trim()` would strip, or a header preceded by e.g. NBSP/IDEOGRAPHIC SPACE
 *    escapes [quoted] here yet is still recognized as a header after trim (#596,
 *    ClintMoody). Line terminators are excluded — the /m anchor already starts a
 *    new match after \n and after U+2028/U+2029; \r was folded to \n above; and
 *    \v/\f were removed by stripControlChars — so the class only needs the
 *    space-like chars: tab, space, NBSP, OGHAM, the U+2000–200A run, NARROW NBSP,
 *    MEDIUM MATH SPACE, IDEOGRAPHIC SPACE, and BOM/ZWNBSP.
 * Lossy, but these fields are already truncated context hints — acceptable.
 */
export function sanitizeForPtyInjection(input: string): string {
  return stripControlChars(input)
    .replace(/\r\n?/g, '\n')
    .replace(/`{3,}/g, '``')
    .replace(
      /^([ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]*)(={3,}\s*(?:AGENT MESSAGE|TELEGRAM)\b|Reply using:\s*cortextos\s+bus)/gim,
      '$1[quoted] $2',
    );
}
