import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentManager } from '../../../src/daemon/agent-manager.js';

// Integration glue for D0/D1 (PLAN-v3). The DECISION logic is unit-tested in the
// pure cores (membership-probe, probe-streak, poller pollerIsStale). This covers
// the wiring: runLivenessCheck reads the fresh entry, classifies, steps the
// streak, emits telemetry every cycle, and routes alerts through the OPERATOR
// channel — never the agent's own. In the clean room CTX_OPERATOR is stripped,
// so a fired alert MUST log UNDELIVERED rather than silently hit an agent chat.

function fakeApi(overrides: Partial<{ status: string; getChatMemberThrows: any; canRead: boolean }>) {
  return {
    botId: 8913497784,
    getMe: vi.fn(async () => ({ result: { can_read_all_group_messages: overrides.canRead ?? true } })),
    getChat: vi.fn(async () => ({ result: { type: 'supergroup' } })),
    getChatMember: overrides.getChatMemberThrows
      ? vi.fn(async () => { throw overrides.getChatMemberThrows; })
      : vi.fn(async () => ({ result: { status: overrides.status ?? 'administrator' } })),
  };
}

function inject(mgr: AgentManager, name: string, api: any, lastPollAt: number) {
  (mgr as any).agents.set(name, {
    chatId: '-1004463276612',
    api,
    poller: { lastSuccessfulPollAt: lastPollAt },
    pollerStartedAt: Date.now(),
    probeStreak: undefined,
  });
}

describe('runLivenessCheck — D0/D1 glue + operator-channel routing', () => {
  let ctxRoot: string;
  let frameworkRoot: string;
  let mgr: AgentManager;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'lc-ctx-'));
    frameworkRoot = mkdtempSync(join(tmpdir(), 'lc-fw-')); // no orgs/ => operator absent
    mgr = new AgentManager('test', ctxRoot, frameworkRoot, 'vault');
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const undelivered = () => errSpy.mock.calls.filter((c) => String(c[0]).includes('ALERT UNDELIVERED'));
  const telemetry = () => logSpy.mock.calls.filter((c) => String(c[0]).includes('liveness-telemetry'));

  it('reachable (administrator), poller fresh => NO alert, telemetry emitted', async () => {
    inject(mgr, 'seo', fakeApi({ status: 'administrator' }), Date.now());
    await (mgr as any).runLivenessCheck('seo');
    expect(undelivered()).toHaveLength(0);
    expect(telemetry().length).toBeGreaterThanOrEqual(1);
  });

  it('D1 unreachable (left) twice => alert fires at N=2, routed to operator (UNDELIVERED here)', async () => {
    inject(mgr, 'seo', fakeApi({ status: 'left' }), Date.now());
    await (mgr as any).runLivenessCheck('seo'); // run 1 — no alert (N=1)
    expect(undelivered()).toHaveLength(0);
    await (mgr as any).runLivenessCheck('seo'); // run 2 — alert
    const u = undelivered();
    expect(u.length).toBe(1);
    // Routed to the operator channel and refused (absent), NOT the agent's chat.
    expect(String(u[0][0])).toMatch(/operator channel absent/i);
    expect(String(u[0][0])).toMatch(/UNREACHABLE/);
  });

  it('D0 stale poller => D0 alert (UNDELIVERED), independent of membership', async () => {
    // lastSuccessfulPollAt far in the past => stale.
    inject(mgr, 'seo', fakeApi({ status: 'administrator' }), Date.now() - 5 * 60_000);
    await (mgr as any).runLivenessCheck('seo');
    const d0 = undelivered().filter((c) => String(c[0]).includes('D0'));
    expect(d0.length).toBe(1);
  });

  it('permanent 400 from getChatMember twice => class C alert at N=2', async () => {
    const err400 = Object.assign(new Error('Telegram API error: chat not found'), { error_code: 400 });
    inject(mgr, 'seo', fakeApi({ getChatMemberThrows: err400 }), Date.now());
    await (mgr as any).runLivenessCheck('seo');
    await (mgr as any).runLivenessCheck('seo');
    expect(undelivered().filter((c) => String(c[0]).includes('UNREACHABLE')).length).toBe(1);
  });

  it('a transient 502 does NOT alert (class B inconclusive)', async () => {
    const err502 = Object.assign(new Error('Telegram API error: Bad Gateway'), { error_code: 502 });
    inject(mgr, 'seo', fakeApi({ getChatMemberThrows: err502 }), Date.now());
    await (mgr as any).runLivenessCheck('seo');
    await (mgr as any).runLivenessCheck('seo');
    expect(undelivered().filter((c) => String(c[0]).includes('UNREACHABLE'))).toHaveLength(0);
  });
});
