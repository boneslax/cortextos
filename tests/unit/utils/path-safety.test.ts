import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  decodeToFixedPoint, assertSafeName, assertSafeOrgSegment, assertContainedWithin,
} from '../../../src/utils/validate.js';

describe('decodeToFixedPoint', () => {
  it('collapses single and double encoding to the real value', () => {
    expect(decodeToFixedPoint('dev-delegate')).toBe('dev-delegate');
    expect(decodeToFixedPoint('%2e%2e')).toBe('..');
    expect(decodeToFixedPoint('%252e%252e%252f')).toBe('../');
  });
  it('throws on malformed encoding (→ 400, not 500)', () => {
    expect(() => decodeToFixedPoint('%')).toThrow();
    expect(() => decodeToFixedPoint('%zz')).toThrow();
  });
});

describe('assertSafeName (lowercase ids)', () => {
  it('accepts valid names', () => {
    expect(assertSafeName('dev-delegate')).toBe('dev-delegate');
    expect(assertSafeName('agent_1')).toBe('agent_1');
  });
  it('rejects traversal in every encoding + bad chars', () => {
    for (const bad of ['..', '../x', '%2e%2e%2f', '%252e%252e%252f', '/etc', 'a/b', 'a\\b', 'a.b', 'AcmeCorp', '', ' ', 'a\0b']) {
      expect(() => assertSafeName(bad), bad).toThrow();
    }
  });
});

describe('assertSafeOrgSegment (mixed-case allowed)', () => {
  it('accepts real mixed-case orgs', () => {
    expect(assertSafeOrgSegment('AcmeCorp')).toBe('AcmeCorp');
    expect(assertSafeOrgSegment('vault')).toBe('vault');
  });
  it('rejects traversal/separators/empty', () => {
    for (const bad of ['../x', '%2e%2e', 'a/b', '', 'a b', 'a\0']) {
      expect(() => assertSafeOrgSegment(bad), bad).toThrow();
    }
  });
});

describe('assertContainedWithin', () => {
  it('allows a path inside the base', () => {
    const base = mkdtempSync(join(tmpdir(), 'pc-'));
    expect(() => assertContainedWithin(base, 'sub/file.md')).not.toThrow();
    rmSync(base, { recursive: true, force: true });
  });
  it('rejects ../ and absolute escapes', () => {
    const base = mkdtempSync(join(tmpdir(), 'pc-'));
    expect(() => assertContainedWithin(base, '../../etc/passwd')).toThrow();
    expect(() => assertContainedWithin(base, '/etc/passwd')).toThrow();
    rmSync(base, { recursive: true, force: true });
  });
  it('rejects base-SEGMENT escape (the F2 trap): attacker controls a base segment', () => {
    // base built from an attacker-influenced org → escapes a fixed root.
    const root = mkdtempSync(join(tmpdir(), 'pc-'));
    const fixed = join(root, 'orgs');
    mkdirSync(fixed, { recursive: true });
    // a base like fixed/../../etc must be rejected when contained against `fixed`
    expect(() => assertContainedWithin(fixed, '../../etc/x')).toThrow();
    rmSync(root, { recursive: true, force: true });
  });
  it('rejects a symlinked ancestor escaping the base', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-'));
    const base = join(root, 'base'); mkdirSync(base);
    const outside = join(root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(base, 'link'), 'dir');
    expect(() => assertContainedWithin(base, 'link/secret')).toThrow();
    rmSync(root, { recursive: true, force: true });
  });
  it('rejects a LEAF that is itself a symlink escaping (why F6 callers contain the PARENT, not the leaf)', () => {
    // The realpath-walk follows the leaf too, so a skill linkPath (legitimately
    // a symlink → catalog) must NOT be passed as the target; callers contain the
    // parent skills dir and join the validated leaf plainly.
    const root = mkdtempSync(join(tmpdir(), 'pc-'));
    const base = join(root, 'base'); mkdirSync(base);
    const outside = join(root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(base, 'leaf'), 'dir');
    expect(() => assertContainedWithin(base, 'leaf')).toThrow();
    rmSync(root, { recursive: true, force: true });
  });
});
