// Path-traversal hardening for the dashboard API routes + server actions.
// Mirrors src/utils/validate.ts (the daemon side) — the dashboard is a separate
// TS project and can't import the daemon's src/, so the validators live here too.
//
// Why: 6 routes built filesystem paths from unvalidated [name]/org/slug and
// double-decoded the param, so %252e%252e%252f survived as ../ (cross-tenant
// read/write/delete + cron-takeover). Validate EVERY user segment against a
// fixed root; never trust startsWith against an attacker-influenced base.

import path from 'path';
import fs from 'fs';

const NAME_REGEX = /^[a-z0-9_-]+$/;          // agent + skill names (lowercase ids)
const ORG_REGEX = /^[A-Za-z0-9_-]+$/;        // orgs preserve framework casing (AcmeCorp)

/**
 * Decode to a FIXED POINT (Next.js already decoded once; routes decoded again →
 * double-decode bypass). Throws on malformed encoding → caller returns HTTP 400.
 */
export function decodeToFixedPoint(s: string): string {
  let cur = s;
  for (let i = 0; i < 6; i++) {
    let next: string;
    try { next = decodeURIComponent(cur); }
    catch { throw new PathSafetyError(`Malformed URL encoding`); }
    if (next === cur) return cur;
    cur = next;
  }
  throw new PathSafetyError(`Excessively-encoded value`);
}

export class PathSafetyError extends Error {}

export function assertSafeName(name: unknown): string {
  const decoded = decodeToFixedPoint(String(name ?? ''));
  if (!decoded || !NAME_REGEX.test(decoded)) throw new PathSafetyError(`Invalid name segment`);
  return decoded;
}

export function assertSafeOrg(org: unknown): string {
  const decoded = decodeToFixedPoint(String(org ?? ''));
  if (!decoded || !ORG_REGEX.test(decoded)) throw new PathSafetyError(`Invalid org segment`);
  return decoded;
}

/**
 * Assert `target` resolves inside `baseDir`. Defeats base-segment escape
 * (string check vs a FIXED base) AND symlinked ancestors (realpath the deepest
 * existing ancestor). Throws PathSafetyError on escape.
 */
export function assertContainedWithin(baseDir: string, target: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new PathSafetyError(`Path escapes base`);
  }
  // realpath-walk (no existsSync→realpath TOCTOU). baseDir MUST be a FIXED
  // trusted root so a symlinked intermediate (planted skills -> /outside) is
  // caught — callers pass frameworkRoot/orgs, never the attacker-reachable dir.
  const realBase = realpathDeepest(base);
  const realProbe = realpathDeepest(resolved);
  if (realProbe !== realBase && !realProbe.startsWith(realBase + path.sep)) {
    throw new PathSafetyError(`Path escapes base via symlink`);
  }
  return resolved;
}

/** realpath the deepest EXISTING ancestor of `p` (walks up on ENOENT). */
function realpathDeepest(p: string): string {
  let cur = p;
  for (;;) {
    try { return fs.realpathSync(cur); }
    catch {
      const parent = path.dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
}
