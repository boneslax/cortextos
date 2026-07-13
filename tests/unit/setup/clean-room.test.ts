import { describe, it, expect } from 'vitest';

/**
 * Guards the clean-room itself (tests/setup/clean-room.ts, wired as vitest
 * `setupFiles`). If someone removes or breaks that wiring, THIS test goes red —
 * instead of the whole suite silently going red for a fake reason.
 *
 * This is the falsifiability guard for the fix: it FAILS when run without the
 * clean-room from an agent shell (which exports ~10-19 CTX_* vars), and PASSES
 * with it. Verified by negative control on 2026-07-13: same leaked env, old path
 * = 33 failing tests, clean-room path = 0.
 */
describe('clean-room test environment', () => {
  it('strips every CTX_* var — no live agent env leaks into tests', () => {
    const leaked = Object.keys(process.env).filter((k) => k.startsWith('CTX_'));
    expect(
      leaked,
      `Live agent env leaked into the test sandbox: ${leaked.join(', ')}. ` +
        'The clean-room setupFile (tests/setup/clean-room.ts) is not running — check ' +
        'vitest.config.ts `setupFiles`. Do NOT "fix" this by unsetting vars by hand: ' +
        'a partial unset yields a plausible, self-consistent, WRONG red suite.',
    ).toEqual([]);
  });

  it('a test can still set a CTX_ var itself (hermetic use is unaffected)', () => {
    process.env.CTX_TEST_SCRATCH = 'ok';
    expect(process.env.CTX_TEST_SCRATCH).toBe('ok');
    delete process.env.CTX_TEST_SCRATCH;
  });
});
