/**
 * Regression tests for the multi-bug batch PR:
 *
 * - BUG-035: discoverProjectRoot() — cwd-independent project root discovery
 * - BUG-013: readEnabledAgents() — defensive validation + backup of corrupt files
 *
 * The point of these tests is to lock in the contract: enable's CLI must work
 * from any cwd, and corrupt JSON must NEVER be silently destroyed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  discoverProjectRoot,
  readEnabledAgents,
  shouldRequireTelegramForEnable,
  missingTelegramEnvForEnable,
} from '../../../src/cli/enable-agent';

describe('BUG-035 + BUG-013: enable-agent validation', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;
  const origFw = process.env.CTX_FRAMEWORK_ROOT;
  const origPr = process.env.CTX_PROJECT_ROOT;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-batch-'));
    process.env.HOME = tmpHome;
    delete process.env.CTX_FRAMEWORK_ROOT;
    delete process.env.CTX_PROJECT_ROOT;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origFw === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = origFw;
    if (origPr === undefined) delete process.env.CTX_PROJECT_ROOT;
    else process.env.CTX_PROJECT_ROOT = origPr;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('discoverProjectRoot (BUG-035)', () => {
    it('honors CTX_FRAMEWORK_ROOT when set', () => {
      process.env.CTX_FRAMEWORK_ROOT = '/some/explicit/path';
      expect(discoverProjectRoot()).toBe('/some/explicit/path');
    });

    it('falls back to CTX_PROJECT_ROOT when CTX_FRAMEWORK_ROOT is unset', () => {
      process.env.CTX_PROJECT_ROOT = '/legacy/path';
      expect(discoverProjectRoot()).toBe('/legacy/path');
    });

    it('discovers ~/cortextos when both env vars are unset and the canonical install exists', () => {
      // Create a fake ~/cortextos with an orgs/ dir (the canonical marker)
      mkdirSync(join(tmpHome, 'cortextos', 'orgs'), { recursive: true });
      expect(discoverProjectRoot()).toBe(join(tmpHome, 'cortextos'));
    });

    it('also recognizes ~/cortextos via legacy agents/ dir', () => {
      mkdirSync(join(tmpHome, 'cortextos', 'agents'), { recursive: true });
      expect(discoverProjectRoot()).toBe(join(tmpHome, 'cortextos'));
    });

    it('falls back to process.cwd() when nothing else applies (legacy behavior preserved)', () => {
      // No env vars, no ~/cortextos at all
      expect(discoverProjectRoot()).toBe(process.cwd());
    });
  });

  describe('readEnabledAgents (BUG-013)', () => {
    function setupConfigFile(instanceId: string, content: string): string {
      const configDir = join(tmpHome, '.cortextos', instanceId, 'config');
      mkdirSync(configDir, { recursive: true });
      const path = join(configDir, 'enabled-agents.json');
      writeFileSync(path, content);
      return path;
    }

    it('returns {} when the file does not exist (legitimate empty state)', () => {
      const result = readEnabledAgents('default');
      expect(result).toEqual({});
    });

    it('returns the parsed object on valid JSON', () => {
      setupConfigFile('default', '{"commander":{"enabled":true,"org":"testorg"}}');
      const result = readEnabledAgents('default');
      expect(result).toEqual({ commander: { enabled: true, org: 'testorg' } });
    });

    it('backs up corrupt JSON instead of silently returning {}', () => {
      const path = setupConfigFile('default', 'this is not json{{{');
      const result = readEnabledAgents('default');
      expect(result).toEqual({});

      // The corrupt file should be backed up, not destroyed
      const backups = readdirSync(join(tmpHome, '.cortextos', 'default', 'config'))
        .filter(f => f.startsWith('enabled-agents.json.broken-'));
      expect(backups.length).toBeGreaterThan(0);

      // The original file is still there (caller may decide to overwrite)
      expect(existsSync(path)).toBe(true);
    });

    it('rejects array values (wrong shape) and backs them up', () => {
      setupConfigFile('default', '["this", "should", "be", "an", "object"]');
      const result = readEnabledAgents('default');
      expect(result).toEqual({});

      const backups = readdirSync(join(tmpHome, '.cortextos', 'default', 'config'))
        .filter(f => f.startsWith('enabled-agents.json.broken-'));
      expect(backups.length).toBeGreaterThan(0);
    });

    it('rejects null values and backs them up', () => {
      setupConfigFile('default', 'null');
      const result = readEnabledAgents('default');
      expect(result).toEqual({});

      const backups = readdirSync(join(tmpHome, '.cortextos', 'default', 'config'))
        .filter(f => f.startsWith('enabled-agents.json.broken-'));
      expect(backups.length).toBeGreaterThan(0);
    });

    it('rejects primitive values (string) and backs them up', () => {
      setupConfigFile('default', '"a string"');
      const result = readEnabledAgents('default');
      expect(result).toEqual({});

      const backups = readdirSync(join(tmpHome, '.cortextos', 'default', 'config'))
        .filter(f => f.startsWith('enabled-agents.json.broken-'));
      expect(backups.length).toBeGreaterThan(0);
    });

    it('does not back up the file when JSON is valid', () => {
      setupConfigFile('default', '{}');
      readEnabledAgents('default');

      const backups = readdirSync(join(tmpHome, '.cortextos', 'default', 'config'))
        .filter(f => f.startsWith('enabled-agents.json.broken-'));
      expect(backups.length).toBe(0);
    });
  });
});

describe('internal-only Telegram preflight', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortextos-internal-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(content: string): string {
    const path = join(tmpDir, 'config.json');
    writeFileSync(path, content);
    return path;
  }

  describe('shouldRequireTelegramForEnable', () => {
    it('returns false when config.json has telegram_polling: false (internal-only)', () => {
      const path = writeConfig('{"telegram_polling": false}');
      expect(shouldRequireTelegramForEnable(path)).toBe(false);
    });

    it('returns true for a null path', () => {
      expect(shouldRequireTelegramForEnable(null)).toBe(true);
    });

    it('returns true for a nonexistent config path', () => {
      expect(shouldRequireTelegramForEnable(join(tmpDir, 'does-not-exist.json'))).toBe(true);
    });

    it('returns true for malformed JSON', () => {
      const path = writeConfig('{not valid json{{{');
      expect(shouldRequireTelegramForEnable(path)).toBe(true);
    });

    it('returns true for an empty object (no telegram_polling field)', () => {
      const path = writeConfig('{}');
      expect(shouldRequireTelegramForEnable(path)).toBe(true);
    });

    it('returns true when telegram_polling is true', () => {
      const path = writeConfig('{"telegram_polling": true}');
      expect(shouldRequireTelegramForEnable(path)).toBe(true);
    });

    it('requires strict boolean false — string "false", numeric 0, and array all return true', () => {
      const strPath = writeConfig('{"telegram_polling": "false"}');
      expect(shouldRequireTelegramForEnable(strPath)).toBe(true);

      const numPath = writeConfig('{"telegram_polling": 0}');
      expect(shouldRequireTelegramForEnable(numPath)).toBe(true);

      const arrPath = writeConfig('[]');
      expect(shouldRequireTelegramForEnable(arrPath)).toBe(true);
    });
  });

  describe('missingTelegramEnvForEnable', () => {
    it('returns [] when Telegram is not required, regardless of env', () => {
      expect(missingTelegramEnvForEnable({}, false)).toEqual([]);
    });

    it('returns both keys when required and env is empty', () => {
      expect(missingTelegramEnvForEnable({}, true)).toEqual(['BOT_TOKEN', 'CHAT_ID']);
    });

    it('returns only the missing key when one is present', () => {
      expect(missingTelegramEnvForEnable({ BOT_TOKEN: 'x' }, true)).toEqual(['CHAT_ID']);
    });
  });
});
