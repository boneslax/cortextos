import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// BUG-2 regression: the watchdog must NEVER report RECOVERED off a blind read.
//
// project_check returns one of THREE verdicts: STALL, OK, or UNKNOWN (an unparseable/failed
// runs read — exactly the state a Trigger outage that also degrades the reader produces). The
// original recovery decision was `if stalled … else RECOVER`, so an open incident whose next
// tick read UNKNOWN fell into the else and fired a false "🟢 RECOVERED / executing again",
// clearing the incident DURING the outage — active misinformation. The fix recovers ONLY on a
// positive OK read; UNKNOWN holds the incident open and stays silent.
//
// Isolation mirrors the sibling watchdog tests: DRY_RUN (send_alert only logs "DRY_RUN alert:"),
// CORTEXTOS_BIN + OP_SA_TOKEN_FILE = /nonexistent, TELEGRAM_API_BASE at a dead endpoint, and every
// status/runs read served from a local fixture so no network is touched.

const SCRIPT = join(__dirname, '../../../bin/trigger-watchdog.sh');

const STATUS_OK = JSON.stringify({ data: { attributes: { aggregate_state: 'operational' } } });

function baseEnv(stateRoot: string, fwRoot: string, extra: Record<string, string>) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/root',
    CTX_ROOT: stateRoot,
    CTX_FRAMEWORK_ROOT: fwRoot, // no agent .env → env_get returns empty; DRY_RUN never needs BOT_TOKEN
    CTX_ORG: 'testorg',
    WATCHDOG_BUS_AGENT: 'solo',
    WATCHDOG_DRY_RUN: '1',
    WATCHDOG_CHAT_ID: '123',
    CORTEXTOS_BIN: '/nonexistent',
    OP_SA_TOKEN_FILE: '/nonexistent',
    TELEGRAM_API_BASE: 'http://127.0.0.1:9',
    ...extra,
  } as NodeJS.ProcessEnv;
}

// Run the FULL watchdog once with an already-open hubapp incident marker, hubapp reading `verdict`,
// and return the watchdog.log contents.
function runWithOpenIncident(verdict: 'UNKNOWN' | 'OK'): string {
  const stateRoot = mkdtempSync(join(tmpdir(), 'bug2-state-'));
  const fwRoot = mkdtempSync(join(tmpdir(), 'bug2-fw-'));
  const stateDir = join(stateRoot, 'state', 'trigger-watchdog');
  mkdirSync(stateDir, { recursive: true });

  // An OPEN incident for hubapp (a real stall was previously detected + alerted).
  writeFileSync(join(stateDir, 'incident.hubapp.json'), JSON.stringify({ since: 'x', last: 'x' }));

  const statusFile = join(stateRoot, 'status.json');
  writeFileSync(statusFile, STATUS_OK);

  const extra: Record<string, string> = {
    WATCHDOG_STATUS_FIXTURE: statusFile,
  };

  if (verdict === 'OK') {
    // A parsed read with his prod executing → verdict OK → a legitimate recovery.
    const exec = join(stateRoot, 'exec.json');
    const queued = join(stateRoot, 'queued.json');
    const done = join(stateRoot, 'done.json');
    writeFileSync(exec, JSON.stringify({ data: [{ id: 'r1' }] }));
    writeFileSync(queued, JSON.stringify({ data: [] }));
    writeFileSync(done, JSON.stringify({ data: [{ finishedAt: new Date(0).toISOString() }] }));
    extra.WATCHDOG_RUNS_FIXTURE_hubapp_EXECUTING = exec;
    extra.WATCHDOG_RUNS_FIXTURE_hubapp_QUEUED = queued;
    extra.WATCHDOG_RUNS_FIXTURE_hubapp_COMPLETED = done;
  } else {
    // A BLIND read: the EXECUTING fixture has no `.data`, so `jq -e '.data'` fails → verdict UNKNOWN.
    const bad = join(stateRoot, 'bad.json');
    writeFileSync(bad, JSON.stringify({ error: 'trigger api unreachable' }));
    extra.WATCHDOG_RUNS_FIXTURE_hubapp_EXECUTING = bad;
    extra.WATCHDOG_RUNS_FIXTURE_hubapp_QUEUED = bad;
    extra.WATCHDOG_RUNS_FIXTURE_hubapp_COMPLETED = bad;
  }

  execFileSync('bash', [SCRIPT], { env: baseEnv(stateRoot, fwRoot, extra), timeout: 30000 });

  const log = readFileSync(join(stateDir, 'watchdog.log'), 'utf8');
  const markerStillOpen = existsSync(join(stateDir, 'incident.hubapp.json'));
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(fwRoot, { recursive: true, force: true });
  return JSON.stringify({ log, markerStillOpen });
}

describe('trigger-watchdog BUG-2: no recovery off a blind read', () => {
  it('a blind (UNKNOWN) read on an open incident does NOT emit a RECOVERED alert', () => {
    const { log } = JSON.parse(runWithOpenIncident('UNKNOWN'));
    // The whole point: no "🟢 … RECOVERED" is ever sent while the reader is blind.
    expect(log).not.toContain('RECOVERED');
    // And it explicitly holds state rather than silently doing nothing by accident.
    expect(log).toContain('UNKNOWN (blind read) — holding state');
  });

  it('positive control: a real OK read on an open incident DOES emit RECOVERED', () => {
    // Proves the recovery path is actually reachable in this harness, so the negative test above
    // is meaningful (not passing just because recovery never fires under these fixtures).
    const { log } = JSON.parse(runWithOpenIncident('OK'));
    expect(log).toContain('DRY_RUN alert');
    expect(log).toContain('RECOVERED');
  });
});
