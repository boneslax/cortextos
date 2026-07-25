/**
 * D1 probe-streak reducer (PLAN-v3 §5e/§7) — PURE.
 *
 * Turns a stream of per-cycle probe verdicts into an alert decision:
 *  - An UNREACHABLE verdict (class A `left`/privacy/channel, or class C
 *    authoritative rejection) must occur N=2 consecutive times before it pages —
 *    one anomalous response cannot wake Bones. N is structural, not empirical:
 *    no transport shape can manufacture a class-A/C verdict.
 *  - A REACHABLE verdict resets the unreachable streak.
 *  - An INCONCLUSIVE verdict (class B, transport) carries ZERO membership
 *    information: it does NOT touch the unreachable streak (a network blip
 *    between two unreachables must not reset it) and instead feeds a SEPARATE
 *    blind counter. The blind-alarm threshold is deferred (phase 3) — here we
 *    only count it, so telemetry can size it from real data.
 *  - A cooldown prevents re-paging every cycle once alerted.
 */
import type { ProbeVerdict } from './membership-probe.js';

export interface ProbeStreakState {
  unreachableRun: number;
  blindRun: number;
  lastAlertAt: number | null;
}

export const INITIAL_PROBE_STREAK: ProbeStreakState = {
  unreachableRun: 0,
  blindRun: 0,
  lastAlertAt: null,
};

export interface ProbeStreakConfig {
  n: number; // consecutive unreachable verdicts before alerting
  cooldownMs: number;
}

export const DEFAULT_PROBE_STREAK_CONFIG: ProbeStreakConfig = {
  n: 2,
  cooldownMs: 30 * 60 * 1000,
};

export interface ProbeStreakStep {
  state: ProbeStreakState;
  fireAlert: boolean;
}

export function stepProbeStreak(
  state: ProbeStreakState,
  verdict: ProbeVerdict,
  now: number,
  cfg: ProbeStreakConfig = DEFAULT_PROBE_STREAK_CONFIG,
): ProbeStreakStep {
  if (verdict.verdict === 'reachable') {
    // Authoritative health clears both streaks.
    return { state: { unreachableRun: 0, blindRun: 0, lastAlertAt: state.lastAlertAt }, fireAlert: false };
  }

  if (verdict.verdict === 'inconclusive') {
    // Transport-only: carries no membership info. Feed the blind counter, leave
    // the unreachable streak untouched.
    return {
      state: { ...state, blindRun: state.blindRun + 1 },
      fireAlert: false,
    };
  }

  // Unreachable (class A left/privacy/channel, or class C rejection).
  const unreachableRun = state.unreachableRun + 1;
  const reached = unreachableRun >= cfg.n;
  const cooledDown = state.lastAlertAt === null || now - state.lastAlertAt >= cfg.cooldownMs;
  const fireAlert = reached && cooledDown;
  return {
    state: {
      unreachableRun,
      blindRun: state.blindRun,
      lastAlertAt: fireAlert ? now : state.lastAlertAt,
    },
    fireAlert,
  };
}
