import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Layer-1a classification tests for bin/trigger-watchdog.sh. Run the real script
// in DRY_RUN mode against status.trigger.dev (Better Stack) JSON fixtures and
// assert the PAGE/OK decision — the core behavior: page on aggregate downtime or
// a CRITICAL component down/degraded, but NOT on a non-critical component
// (Realtime/OTel/Deployments) being degraded.

const SCRIPT = join(__dirname, '../../../bin/trigger-watchdog.sh');
let dir: string;
const fix = (name: string, json: unknown) => {
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify(json));
  return p;
};

function run(fixturePath: string): string {
  const state = mkdtempSync(join(tmpdir(), 'wd-state-'));
  try {
    return execFileSync('bash', [SCRIPT], {
      env: { ...process.env, CTX_ROOT: state, WATCHDOG_DRY_RUN: '1', TRIGGER_STATUS_FIXTURE: fixturePath },
      encoding: 'utf-8',
    }).trim();
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'wd-fix-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const comp = (public_name: string, status: string) =>
  ({ type: 'status_page_resource', attributes: { public_name, status } });

describe('trigger-watchdog 1a classification', () => {
  it('operational → OK', () => {
    const p = fix('op', { data: { attributes: { aggregate_state: 'operational' } }, included: [comp('Trigger.dev API', 'operational'), comp('Realtime', 'operational')] });
    expect(run(p)).toContain('DECISION=OK');
  });

  it('aggregate downtime → PAGE', () => {
    const p = fix('down', { data: { attributes: { aggregate_state: 'downtime' } }, included: [comp('Trigger.dev cloud', 'downtime')] });
    expect(run(p)).toContain('DECISION=PAGE');
  });

  it('non-critical component (Realtime) degraded → OK (no false page)', () => {
    const p = fix('rt', { data: { attributes: { aggregate_state: 'degraded' } }, included: [comp('Trigger.dev API', 'operational'), comp('Realtime', 'downtime')] });
    expect(run(p)).toContain('DECISION=OK');
  });

  it('critical component (API) degraded → PAGE', () => {
    const p = fix('crit', { data: { attributes: { aggregate_state: 'operational' } }, included: [comp('Trigger.dev API', 'degraded')] });
    const out = run(p);
    expect(out).toContain('DECISION=PAGE');
    expect(out).toContain('Trigger.dev API=degraded');
  });
});
