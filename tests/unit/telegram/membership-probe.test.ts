import { describe, it, expect } from 'vitest';
import { classifyMembershipProbe } from '../../../src/telegram/membership-probe';

// D1 classifier (PLAN-v3 §5 + §7). Each case is a green-while-deaf state the
// gate found, or an authoritative/transport distinction the plan depends on.

describe('classifyMembershipProbe — authoritative answers (class A)', () => {
  it('private + member => reachable', () => {
    const v = classifyMembershipProbe({ ok: true, chatType: 'private', status: 'member', canReadAllGroupMessages: undefined });
    expect(v).toMatchObject({ verdict: 'reachable', klass: 'A', alert: false });
  });

  it('group + administrator => reachable (regardless of the privacy flag)', () => {
    const v = classifyMembershipProbe({ ok: true, chatType: 'group', status: 'administrator', canReadAllGroupMessages: false });
    expect(v).toMatchObject({ verdict: 'reachable', klass: 'A', alert: false });
  });

  it('supergroup + creator => reachable', () => {
    const v = classifyMembershipProbe({ ok: true, chatType: 'supergroup', status: 'creator', canReadAllGroupMessages: undefined });
    expect(v.verdict).toBe('reachable');
  });

  it('supergroup + member + can_read_all_group_messages=true => reachable', () => {
    const v = classifyMembershipProbe({ ok: true, chatType: 'supergroup', status: 'member', canReadAllGroupMessages: true });
    expect(v).toMatchObject({ verdict: 'reachable', klass: 'A', alert: false });
  });

  it('GREEN-WHILE-DEAF: group + member + privacy ON (can_read=false) => UNREACHABLE + alert', () => {
    const v = classifyMembershipProbe({ ok: true, chatType: 'group', status: 'member', canReadAllGroupMessages: false });
    expect(v).toMatchObject({ verdict: 'unreachable', klass: 'A', alert: true });
  });

  it('UNKNOWN-NEVER-GREEN: group + member + can_read UNKNOWN => inconclusive, NOT reachable', () => {
    const v = classifyMembershipProbe({ ok: true, chatType: 'group', status: 'member', canReadAllGroupMessages: undefined });
    expect(v.verdict).toBe('inconclusive');
    expect(v.verdict).not.toBe('reachable');
    expect(v.alert).toBe(false); // inconclusive never raises the unreachable alert
  });

  it('left => unreachable + alert', () => {
    const v = classifyMembershipProbe({ ok: true, chatType: 'supergroup', status: 'left', canReadAllGroupMessages: true });
    expect(v).toMatchObject({ verdict: 'unreachable', klass: 'A', alert: true });
  });

  it('kicked => unreachable + alert', () => {
    const v = classifyMembershipProbe({ ok: true, chatType: 'supergroup', status: 'kicked', canReadAllGroupMessages: true });
    expect(v).toMatchObject({ verdict: 'unreachable', alert: true });
  });

  it('restricted + is_member=true => reachable (restriction governs sending, not reading)', () => {
    const v = classifyMembershipProbe({ ok: true, chatType: 'supergroup', status: 'restricted', isMember: true, canReadAllGroupMessages: true });
    expect(v.verdict).toBe('reachable');
  });

  it('restricted + is_member=false => unreachable + alert', () => {
    const v = classifyMembershipProbe({ ok: true, chatType: 'supergroup', status: 'restricted', isMember: false, canReadAllGroupMessages: true });
    expect(v).toMatchObject({ verdict: 'unreachable', alert: true });
  });

  it('CHANNEL is unsupported => always alert, whatever the status', () => {
    const v = classifyMembershipProbe({ ok: true, chatType: 'channel', status: 'administrator', canReadAllGroupMessages: true });
    expect(v.verdict).toBe('unreachable');
    expect(v.alert).toBe(true);
    expect(v.reason).toMatch(/channel/i);
  });

  it('UNKNOWN status enum => inconclusive, never green (do not false-page, do not false-pass)', () => {
    const v = classifyMembershipProbe({ ok: true, chatType: 'supergroup', status: 'zorp', canReadAllGroupMessages: true });
    expect(v.verdict).toBe('inconclusive');
    expect(v.verdict).not.toBe('reachable');
  });
});

describe('classifyMembershipProbe — errors (class C authoritative-rejection vs B transport)', () => {
  it('permanent 400 (chat not found) => class C, unreachable + alert', () => {
    const v = classifyMembershipProbe({ ok: false, errorCode: 400 });
    expect(v).toMatchObject({ verdict: 'unreachable', klass: 'C', alert: true });
  });

  it('401 bad token => class C, unreachable + alert', () => {
    const v = classifyMembershipProbe({ ok: false, errorCode: 401 });
    expect(v).toMatchObject({ klass: 'C', alert: true });
  });

  it('409 Conflict => class B, inconclusive, NO alert', () => {
    const v = classifyMembershipProbe({ ok: false, errorCode: 409 });
    expect(v).toMatchObject({ verdict: 'inconclusive', klass: 'B', alert: false });
  });

  it('429 rate limited => class B, inconclusive, NO alert', () => {
    const v = classifyMembershipProbe({ ok: false, errorCode: 429 });
    expect(v).toMatchObject({ klass: 'B', alert: false });
  });

  it('502 Bad Gateway => class B, inconclusive', () => {
    const v = classifyMembershipProbe({ ok: false, errorCode: 502 });
    expect(v).toMatchObject({ klass: 'B', alert: false });
  });

  it('CRITICAL: NO error code at all (fetch failed) => class B, NOT C', () => {
    // 99.85% of observed failures are codeless network throws. Filing them as C
    // would page the whole fleet on the first network blip.
    const v = classifyMembershipProbe({ ok: false, errorCode: undefined });
    expect(v).toMatchObject({ klass: 'B', alert: false });
    expect(v.klass).not.toBe('C');
  });

  it('unclassifiable coded 4xx (e.g. 418) => class C + alert, labelled', () => {
    const v = classifyMembershipProbe({ ok: false, errorCode: 418 });
    expect(v).toMatchObject({ klass: 'C', alert: true });
  });
});
