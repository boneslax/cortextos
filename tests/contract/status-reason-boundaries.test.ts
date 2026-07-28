import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Contract tests: properties nobody is looking at, made executable.
 *
 * A unit test describes an OUTCOME you already expected. These pin
 * PROPERTIES that no outcome test would notice breaking — both of these
 * constraints lived in prose (a code comment and a plan document) where
 * nothing could enforce them, and both would survive a fully green suite.
 *
 * cortextos already runs `npm test` on pull requests to main
 * (.github/workflows/ci.yml) and vitest's default include is
 * `tests/**\/*.test.ts`, so a file here genuinely gates. That matters:
 * Hub carried fifteen contract tests for months with no runner, and a
 * guard nobody executes decays exactly like a convention while leaving an
 * artifact that looks like coverage.
 */

const REPO = join(__dirname, '..', '..');
const RENDERER = join(REPO, 'src', 'utils', 'status-reason.ts');

describe('status-reason module boundaries', () => {
  /**
   * The dashboard's sync derivation is meant to import this renderer so the
   * CLI and the board cannot drift on what "current" means. The dashboard
   * is a separate Next.js build with its own tsconfig and node_modules, so
   * the moment this file imports anything with a filesystem dependency,
   * that consumer breaks — or silently drags the server graph into a
   * browser bundle.
   *
   * Nothing in the unit suite pins this. `formatStatusReason` passes every
   * one of its 11 tests with `import { readFileSync } from 'fs'` at the
   * top. The constraint was a paragraph in a comment until it was this.
   */
  it('the renderer imports nothing at all', () => {
    const src = readFileSync(RENDERER, 'utf-8');
    const imports = src
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l) || /^\s*(const|let|var)\s+.*\brequire\s*\(/.test(l));
    expect(imports).toEqual([]);
  });

  /**
   * `status_reason.reason` must not be read raw outside the renderer.
   *
   * The gate's finding was that one caller makes the formatter
   * *centralised*, not *structural* — nothing stops the next surface
   * reading the bare string and rendering it without the currency check,
   * which reintroduces exactly the staleness the stamp exists to prevent.
   * A reader who gets the text but not the verdict is the failure mode.
   *
   * Escape hatch is deliberate and must carry a reason, so a bypass is a
   * decision someone wrote down rather than a line that slipped in.
   */
  it('nothing outside the renderer reads status_reason.reason raw', () => {
    const SUPPRESS = 'status-reason-ok:';
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        if (p === RENDERER) continue; // the renderer is the one place allowed
        if (p.includes(join('tests', ''))) continue; // tests assert on it by design

        readFileSync(p, 'utf-8')
          .split('\n')
          .forEach((line, i) => {
            if (line.includes(SUPPRESS)) return;
            if (/status_reason\s*[?!]?\s*\.\s*reason/.test(line)) {
              offenders.push(`${p.slice(REPO.length + 1)}:${i + 1}  ${line.trim()}`);
            }
          });
      }
    };
    walk(join(REPO, 'src'));

    expect(offenders).toEqual([]);
  });
});
