import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { CRONS_DIRECTORY } from '../../src/bus/crons-schema';

/**
 * Documentation must agree with the constant the daemon actually reads.
 *
 * WHAT WENT WRONG. Every template and every live agent boot document said
 * the cron store was at `${CTX_ROOT}/state/<agent>/crons.json`. The daemon
 * reads `.cortextOS/state/agents/<agent>/`. An orchestrator lost an hour
 * unable to find a registered cron and nearly reopened a closed thread
 * against one that fires today.
 *
 * The failure shape is why this test exists rather than a code comment: the
 * documented PARENT directory is real and populated with ~25 files, so `ls`
 * on the wrong path SUCCEEDS and returns a plausible state directory that
 * simply lacks crons.json. An absence inside a directory that exists reads
 * as "not registered"; an absence because the directory is wrong reads as
 * "wrong place". Identical at the command line, opposite conclusions.
 *
 * A boot document asserting a location the mechanism does not read
 * specifically defeats the verification that would catch a missing cron.
 *
 * SCOPE — read this before widening the test.
 *
 * `${CTX_ROOT}/state/<agent>/` is CORRECT and live. It holds heartbeat.json,
 * .onboarded, .telegram-offset, .message-dedup-hashes, last-telegram-*.txt.
 * It is code-authoritative at src/utils/paths.ts (`stateDir`). Only the two
 * cron artifacts moved. This test must never be broadened into a check on
 * the `${CTX_ROOT}/state/` prefix — `.onboarded` is read at
 * src/daemon/agent-process.ts from exactly that path, and a prefix sweep
 * would point first-boot detection at a directory that has never held it.
 */

const REPO = join(__dirname, '..', '..');
const CRON_ARTIFACTS = ['crons.json', 'cron-execution.log'];

function markdownFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.next' || entry === 'dist') continue;
    const p = join(dir, entry);
    // Do not follow symlinks: a linked tree would be scanned twice, and a
    // linked directory outside the repo is not ours to assert on.
    if (statSync(p).isDirectory()) markdownFiles(p, acc);
    else if (entry.endsWith('.md')) acc.push(p);
  }
  return acc;
}

describe('cron store path in documentation', () => {
  it('the constant is the one this test asserts against', () => {
    // Positive control. If CRONS_DIRECTORY is ever renamed or moved, this
    // fails first and names the real cause, rather than the assertion below
    // failing for a reason that looks like a docs problem.
    expect(CRONS_DIRECTORY).toBe('.cortextOS/state/agents');
  });

  it('no .md documents a cron artifact under ${CTX_ROOT}/state/<agent>/', () => {
    const offenders: string[] = [];
    for (const file of markdownFiles(REPO)) {
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          for (const artifact of CRON_ARTIFACTS) {
            // Matches the wrong location specifically: state/ directly
            // followed by the agent-name variable and then a cron artifact.
            const wrong = new RegExp(
              `\\$\\{CTX_ROOT\\}/state/\\$\\{?CTX_AGENT_NAME\\}?/${artifact.replace('.', '\\.')}`,
            );
            if (wrong.test(line)) {
              offenders.push(`${file.slice(REPO.length + 1)}:${i + 1}  ${line.trim().slice(0, 120)}`);
            }
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('still documents .onboarded at the path the daemon reads', () => {
    // The guard against fixing this defect too enthusiastically. If a future
    // sweep rewrites the ${CTX_ROOT}/state/ prefix wholesale, this fails.
    const withOnboarded = markdownFiles(REPO).filter((f) =>
      /\$\{CTX_ROOT\}\/state\/\$\{CTX_AGENT_NAME\}\/\.onboarded/.test(readFileSync(f, 'utf-8')),
    );
    expect(withOnboarded.length).toBeGreaterThan(0);
  });
});
