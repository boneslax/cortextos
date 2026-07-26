/**
 * tests/integration/concurrent-cron-mutations.test.ts — Iter 12 audit
 *
 * Pins the lost-update race in bus/crons.ts: addCron / updateCron /
 * removeCron all do `readCrons -> mutate -> writeCrons` with no
 * inter-process lock.  Two concurrent processes that interleave between
 * the read and the write will overwrite each other's mutations.
 *
 * The repro spawns N real child processes via the production CLI
 * (`node dist/cli.js bus ...`), each operating on a DIFFERENT cron name
 * within the same agent's crons.json.  After all complete, every
 * mutation MUST be reflected on disk.  Pre-fix, some mutations are lost
 * because the second writer's `readCrons` fired before the first
 * writer's `writeCrons` completed, so the second writer's snapshot was
 * stale and the rename overwrote the first writer's update.
 *
 * NOTE: this test invokes the compiled `dist/cli.js`, so the test
 * suite assumes `npm run build` ran beforehand (the CI workflow does
 * this).  If `dist/cli.js` is absent locally, the test is skipped with
 * a clear message rather than failing on a missing file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getIpcPath } from '../../src/utils/paths';
import { validateInstanceId } from '../../src/utils/validate';
import type { CronDefinition } from '../../src/types/index';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI  = join(REPO_ROOT, 'dist', 'cli.js');
const CRONS_DIR = '.cortextOS/state/agents';

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'concurrent-crons-'));
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

function writeEnabledAgents(agent: string): void {
  const configDir = join(tmpRoot, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'enabled-agents.json'),
    JSON.stringify({ [agent]: { enabled: true, org: 'lifeos' } }, null, 2),
  );
}

function readCronsFromDisk(agent: string): CronDefinition[] {
  const filePath = join(tmpRoot, CRONS_DIR, agent, 'crons.json');
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  return parsed.crons as CronDefinition[];
}

function seedCrons(agent: string, count: number): string[] {
  const dir = join(tmpRoot, CRONS_DIR, agent);
  mkdirSync(dir, { recursive: true });
  const names = Array.from({ length: count }, (_, i) => `cron-${i}`);
  const crons = names.map(name => ({
    name,
    prompt: `original-${name}`,
    schedule: '6h',
    enabled: true,
    created_at: new Date().toISOString(),
  }));
  writeFileSync(
    join(dir, 'crons.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), crons }, null, 2),
  );
  return names;
}

/**
 * Instance id for the spawned children — the OTHER half of the isolation.
 *
 * `CTX_ROOT` moves state; it cannot move the IPC socket. `getIpcPath`
 * (utils/paths.ts) builds `~/.cortextos/<instanceId>/daemon.sock` from the
 * INSTANCE ID alone, never from ctxRoot. Those two are normally coupled —
 * utils/env.ts defaults ctxRoot to `~/.cortextos/<instanceId>` — and
 * overriding CTX_ROOT on its own BREAKS that coupling: state lands in the
 * tmpdir while the instance id stays `default`, which is the live daemon.
 *
 * The symptom was `[ipc] reload-crons race-agent` appearing in the running
 * production daemon's log during test runs. It was harmless only because no
 * agent is named `race-agent` — a property of the fixture name, not of the
 * isolation. A fixture named after a real agent would have reached into it.
 *
 * Lowercased because `getIpcPath` calls `validateInstanceId`, which enforces
 * /^[a-z0-9_-]+$/, and `mkdtempSync` emits a mixed-case suffix. Getting this
 * wrong does not fail loudly: the throw happens inside the IPCClient
 * constructor, under the deliberate `catch {}` in signalCronReload, so an
 * INVALID id also produces a quiet no-op that looks exactly like success.
 * See the mechanism assertions below — they exist to tell those apart.
 */
function isolatedInstanceId(): string {
  return `test-${basename(tmpRoot).toLowerCase()}`;
}

/**
 * The single env every spawned child gets. Kept as one function so the
 * isolation is asserted on the SAME object the children actually receive —
 * see "the override reaches the child" below.
 */
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CTX_ROOT: tmpRoot, CTX_INSTANCE_ID: isolatedInstanceId() };
}

/**
 * The SOLE spawn path for this suite — no caller supplies its own env.
 *
 * Not stylistic. An earlier revision let `runUpdate` build the env inline, and
 * mutating that one call site back to a CTX_ROOT-only env passed every
 * assertion: the isolation was verified on a helper that the spawn no longer
 * used. Routing every child through one chokepoint means the only way to break
 * the isolation is to break `childEnv`, which IS asserted below.
 */
async function spawnCli(args: string[]): Promise<{ stdout: string }> {
  return execFileAsync(process.execPath, args, { env: childEnv() });
}

async function runUpdate(agent: string, name: string, newPrompt: string): Promise<void> {
  await spawnCli([DIST_CLI, 'bus', 'update-cron', agent, name, '--prompt', newPrompt]);
}

/**
 * These assert the MECHANISM of the isolation, not its symptom.
 *
 * Deliberately NOT gated on DIST_CLI: the race test skips on an unbuilt tree,
 * and the isolation invariant must not skip with it. A silent skip here would
 * mean the suite could start reaching the live daemon again with nothing red.
 */
describe('spawned children are isolated from the LIVE daemon socket', () => {
  it('the instance id is VALID — isolation must not come from a validation error', () => {
    // Load-bearing, and the reason this is its own assertion: an INVALID id
    // throws inside getIpcPath -> IPCClient -> signalCronReload's `catch {}`.
    // The child then never reaches the live socket and the test passes — with
    // the isolation supplied by a swallowed exception rather than by pointing
    // at a different socket. Same observable, wrong mechanism, and it holds
    // only until someone needs a genuinely working isolated daemon.
    expect(() => validateInstanceId(isolatedInstanceId())).not.toThrow();
  });

  it('the socket path actually MOVES off the live default instance', () => {
    // With the id proven valid above, this can only pass by resolving
    // somewhere other than the running daemon.
    expect(getIpcPath(isolatedInstanceId())).not.toBe(getIpcPath('default'));
  });

  it('the override REACHES the child process — not just the helper', async () => {
    // Found by mutating this very test: deleting CTX_INSTANCE_ID from the
    // child env left the other three assertions green, because they only ever
    // examined the helper's return value and never the wiring. A correct id
    // that is never passed is identical, from the daemon's side, to no fix.
    // So this crosses a real process boundary and reads the value back.
    // Goes through spawnCli — the same chokepoint the real children use — so
    // this cannot pass while the production spawn path is unisolated.
    const { stdout } = await spawnCli(['-p', 'process.env.CTX_INSTANCE_ID']);
    expect(stdout.trim()).toBe(isolatedInstanceId());
  });

  it('mkdtemp mixed-case suffixes are handled — the case that broke the first patch', () => {
    // mkdtempSync emits e.g. `concurrent-crons-nsKezq`; the regex is
    // lowercase-only. Four consecutive real runs were rejected before the
    // .toLowerCase(). Pin it so a future refactor of the id cannot regress.
    expect(isolatedInstanceId()).toMatch(/^[a-z0-9_-]+$/);
  });
});

describe.skipIf(!existsSync(DIST_CLI))('Iter 12 audit: concurrent bus update-cron lost-update race', () => {
  it('N parallel update-cron processes against same agent — every mutation MUST survive (pinned, expected to FAIL pre-fix)', async () => {
    const agent = 'race-agent';
    writeEnabledAgents(agent);

    const N = 8;
    const ITERATIONS = 5;
    const lostUpdatesPerIteration: number[] = [];

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const names = seedCrons(agent, N);

      // Launch N parallel CLI invocations updating N distinct crons.
      // Each writes a unique prompt so we can detect lost updates.
      const newPromptFor = (name: string) => `updated-iter${iter}-${name}`;
      await Promise.all(names.map(n => runUpdate(agent, n, newPromptFor(n))));

      // Verify all N mutations survived.
      const onDisk = readCronsFromDisk(agent);
      let lost = 0;
      for (const name of names) {
        const cron = onDisk.find(c => c.name === name);
        if (!cron || cron.prompt !== newPromptFor(name)) {
          lost++;
        }
      }
      lostUpdatesPerIteration.push(lost);
    }

    const totalLost = lostUpdatesPerIteration.reduce((a, b) => a + b, 0);
    // Diagnostic for debugging:
    if (totalLost > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[iter12 audit] lost updates per iteration: ${lostUpdatesPerIteration.join(', ')} (total ${totalLost} of ${N * ITERATIONS})`);
    }
    expect(totalLost, 'concurrent bus update-cron must not lose any updates').toBe(0);
  }, 60_000);
});
