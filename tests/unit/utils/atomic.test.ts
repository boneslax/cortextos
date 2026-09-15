import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, lstatSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { atomicWriteSync } from '../../../src/utils/atomic';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'atomic-test-'));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

describe('atomicWriteSync', () => {
  it('creates a new file with the data plus a trailing newline', () => {
    const p = join(tmpDir, 'new.json');
    atomicWriteSync(p, '{"a":1}');
    expect(readFileSync(p, 'utf-8')).toBe('{"a":1}\n');
  });

  it('overwrites an existing regular file atomically', () => {
    const p = join(tmpDir, 'reg.json');
    writeFileSync(p, 'old\n');
    atomicWriteSync(p, 'new');
    expect(readFileSync(p, 'utf-8')).toBe('new\n');
    // no temp file left behind
    expect(existsSync(join(tmpDir, '.tmp'))).toBe(false);
  });

  describe('symlink-aware writes', () => {
    it('writes THROUGH a symlink to its target and leaves the link intact', () => {
      const target = join(tmpDir, 'target.json');
      const link = join(tmpDir, 'link.json');
      writeFileSync(target, 'original\n');
      symlinkSync(target, link);

      atomicWriteSync(link, 'updated');

      // the link is still a symlink — NOT replaced by a regular file
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      // the write landed on the real target
      expect(readFileSync(target, 'utf-8')).toBe('updated\n');
      // and reading through the link sees it too
      expect(readFileSync(link, 'utf-8')).toBe('updated\n');
    });

    it('creates the declared target of a DANGLING symlink and keeps the link', () => {
      const target = join(tmpDir, 'not-yet.json');
      const link = join(tmpDir, 'dangling.json');
      // link points at a target that does not exist yet
      symlinkSync(target, link);
      expect(existsSync(target)).toBe(false);

      atomicWriteSync(link, 'created');

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, 'utf-8')).toBe('created\n');
    });

    it('resolves a RELATIVE dangling-symlink target against the link directory', () => {
      const target = join(tmpDir, 'rel-target.json');
      const link = join(tmpDir, 'rel-link.json');
      symlinkSync('rel-target.json', link); // relative target
      atomicWriteSync(link, 'via-relative');
      expect(readFileSync(target, 'utf-8')).toBe('via-relative\n');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });

    it('resolves a MULTI-HOP dangling chain to its terminus, keeping every link intact', () => {
      // a -> b -> missing: a single readlink hop would stop at b (itself a
      // symlink) and the rename would replace b with a regular file. The write
      // must land AT the terminus path, with both a and b still symlinks.
      const terminus = join(tmpDir, 'chain-terminus.json');
      const b = join(tmpDir, 'chain-b.json');
      const a = join(tmpDir, 'chain-a.json');
      symlinkSync(terminus, b);
      symlinkSync(b, a);
      expect(existsSync(terminus)).toBe(false);

      atomicWriteSync(a, 'through-the-chain');

      expect(lstatSync(a).isSymbolicLink()).toBe(true);
      expect(lstatSync(b).isSymbolicLink()).toBe(true);
      expect(lstatSync(terminus).isSymbolicLink()).toBe(false);
      expect(readFileSync(terminus, 'utf-8')).toBe('through-the-chain\n');
      // and reading through the chain sees it
      expect(readFileSync(a, 'utf-8')).toBe('through-the-chain\n');
    });

    it('throws ELOOP on a symlink cycle instead of silently replacing a link', () => {
      const a = join(tmpDir, 'cycle-a.json');
      const b = join(tmpDir, 'cycle-b.json');
      symlinkSync(b, a);
      symlinkSync(a, b);

      expect(() => atomicWriteSync(a, 'never-lands')).toThrow(/cycle/);
      // both links untouched — the failure must not mutate the link structure
      expect(lstatSync(a).isSymbolicLink()).toBe(true);
      expect(lstatSync(b).isSymbolicLink()).toBe(true);
    });

    it('keepBak backs up the real target content at <linkpath>.bak', () => {
      const target = join(tmpDir, 't.json');
      const link = join(tmpDir, 'l.json');
      writeFileSync(target, 'v1\n');
      symlinkSync(target, link);

      atomicWriteSync(link, 'v2', true);

      // backup captured the prior target content, and sits at the LINK path + .bak
      expect(readFileSync(link + '.bak', 'utf-8')).toBe('v1\n');
      expect(readFileSync(target, 'utf-8')).toBe('v2\n');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });
  });

  describe('keepBak on a regular file', () => {
    it('writes the prior content to <path>.bak', () => {
      const p = join(tmpDir, 'k.json');
      writeFileSync(p, 'first\n');
      atomicWriteSync(p, 'second', true);
      expect(readFileSync(p, 'utf-8')).toBe('second\n');
      expect(readFileSync(p + '.bak', 'utf-8')).toBe('first\n');
    });

    it('does not create a .bak on first write (nothing to back up)', () => {
      const p = join(tmpDir, 'fresh.json');
      atomicWriteSync(p, 'only', true);
      expect(existsSync(p + '.bak')).toBe(false);
    });
  });
});
