import { describe, it, expect } from 'vitest';
import { FastChecker } from '../../../src/daemon/fast-checker.js';

// v2: an inbound message in a project topic carries a [project: <label>] line.
describe('formatTelegramTextMessage project label', () => {
  it('injects [project: label] when provided', () => {
    const out = FastChecker.formatTelegramTextMessage(
      'B', '-100123', 'ship it', '/tmp', undefined, undefined, undefined, 34, 'auditflow',
    );
    expect(out).toContain('[project: auditflow]');
    expect(out).toContain("--thread 34");
  });

  it('omits the project line when no label (DM/v1 unchanged)', () => {
    const out = FastChecker.formatTelegramTextMessage('B', '1664028089', 'hi', '/tmp');
    expect(out).not.toContain('[project:');
    expect(out).not.toContain('--thread');
  });
});
