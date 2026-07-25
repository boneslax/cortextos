import { describe, it, expect } from 'vitest';
import {
  stepProbeStreak,
  INITIAL_PROBE_STREAK,
  type ProbeStreakState,
} from '../../../src/telegram/probe-streak';
import type { ProbeVerdict } from '../../../src/telegram/membership-probe';

const reachable: ProbeVerdict = { verdict: 'reachable', klass: 'A', alert: false, reason: 'ok' };
const unreachable: ProbeVerdict = { verdict: 'unreachable', klass: 'A', alert: true, reason: 'left' };
const rejection: ProbeVerdict = { verdict: 'unreachable', klass: 'C', alert: true, reason: 'chat not found' };
const inconclusive: ProbeVerdict = { verdict: 'inconclusive', klass: 'B', alert: false, reason: 'transport' };

const cfg = { n: 2, cooldownMs: 1000 };

function run(verdicts: ProbeVerdict[], now = 0): { state: ProbeStreakState; alerts: number } {
  let state = INITIAL_PROBE_STREAK;
  let alerts = 0;
  for (const v of verdicts) {
    const step = stepProbeStreak(state, v, now, cfg);
    state = step.state;
    if (step.fireAlert) alerts++;
  }
  return { state, alerts };
}

describe('stepProbeStreak — N=2 debounce for the unreachable alert', () => {
  it('does NOT alert on a single unreachable (one anomaly cannot page)', () => {
    expect(run([unreachable]).alerts).toBe(0);
  });

  it('alerts on the SECOND consecutive unreachable', () => {
    expect(run([unreachable, unreachable]).alerts).toBe(1);
  });

  it('class C authoritative rejection also debounces to N=2', () => {
    expect(run([rejection, rejection]).alerts).toBe(1);
  });

  it('a reachable verdict RESETS the unreachable streak', () => {
    expect(run([unreachable, reachable, unreachable]).alerts).toBe(0);
  });

  it('INCONCLUSIVE does NOT reset the unreachable streak (blip between two unreachables still pages)', () => {
    expect(run([unreachable, inconclusive, unreachable]).alerts).toBe(1);
  });

  it('inconclusive feeds the blind counter, never the unreachable alert', () => {
    const { state, alerts } = run([inconclusive, inconclusive, inconclusive]);
    expect(alerts).toBe(0);
    expect(state.blindRun).toBe(3);
    expect(state.unreachableRun).toBe(0);
  });

  it('cooldown: does not re-alert every cycle while unreachable persists', () => {
    // 4 consecutive unreachables at the same instant: alert once at the 2nd,
    // then cooldown suppresses the 3rd and 4th.
    expect(run([unreachable, unreachable, unreachable, unreachable], 0).alerts).toBe(1);
  });

  it('re-alerts after the cooldown elapses', () => {
    let state = INITIAL_PROBE_STREAK;
    let alerts = 0;
    // t=0: unreachable, unreachable -> alert. t=2000 (> cooldown 1000): unreachable -> alert again.
    for (const [v, now] of [[unreachable, 0], [unreachable, 0], [unreachable, 2000]] as [ProbeVerdict, number][]) {
      const step = stepProbeStreak(state, v, now, cfg);
      state = step.state;
      if (step.fireAlert) alerts++;
    }
    expect(alerts).toBe(2);
  });

  it('a reachable verdict also clears the blind counter', () => {
    expect(run([inconclusive, inconclusive, reachable]).state.blindRun).toBe(0);
  });
});
