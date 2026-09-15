import { describe, it, expect, beforeEach, vi } from 'vitest';

// checkMergeGateMetrics shells out to `gh pr list` and `gh api .../timeline`.
// Mock execSync so tests never touch the network or require gh auth.
const execSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => execSyncMock(...args),
  };
});

const { checkMergeGateMetrics } = await import('../../../src/bus/metrics.js');

describe('checkMergeGateMetrics', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
  });

  it('rejects a malformed repo argument without shelling out', () => {
    const result = checkMergeGateMetrics('not-a-repo');
    expect(result.status).toBe('error');
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed label option without shelling out', () => {
    const result = checkMergeGateMetrics('grandamenium/cortextos', { label: 'bad label!' });
    expect(result.status).toBe('error');
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('reports error status when gh pr list fails', () => {
    execSyncMock.mockImplementation(() => { throw new Error('gh: command not found'); });
    const result = checkMergeGateMetrics('grandamenium/cortextos');
    expect(result.status).toBe('error');
    expect(result.hint).toContain('command not found');
  });

  it('excludes PRs missing mergeable or checks-green (label alone is not enough)', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return JSON.stringify([
          { number: 986, mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
          { number: 987, mergeable: 'CONFLICTING', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
          { number: 988, mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'FAILURE' }] },
          { number: 989, mergeable: 'MERGEABLE', statusCheckRollup: [] },
        ]);
      }
      if (cmd.includes('timeline')) return '2026-08-30T23:16:00Z';
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = checkMergeGateMetrics('grandamenium/cortextos');
    expect(result.status).toBe('ok');
    expect(result.gated_queue_depth).toBe(1);
    expect(result.gated_prs?.map((p) => p.number)).toEqual([986]);
  });

  it('computes oldest_gated_age_days from the earliest labeled_at among gated PRs', () => {
    const now = Date.now();
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return JSON.stringify([
          { number: 986, mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
          { number: 987, mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'NEUTRAL' }] },
        ]);
      }
      if (cmd.includes('issues/986/timeline')) {
        return new Date(now - 5 * 86400000).toISOString(); // 5 days ago
      }
      if (cmd.includes('issues/987/timeline')) {
        return new Date(now - 1 * 86400000).toISOString(); // 1 day ago
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = checkMergeGateMetrics('grandamenium/cortextos');
    expect(result.gated_queue_depth).toBe(2);
    expect(result.oldest_gated_age_days).toBeCloseTo(5, 1);
  });

  it('takes the most recent labeled event when a PR was relabeled after a regress', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return JSON.stringify([
          { number: 990, mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
        ]);
      }
      if (cmd.includes('timeline')) {
        // Stale first application, then a fresh reapplication after regress.
        return ['2026-01-01T00:00:00Z', '2026-08-30T00:00:00Z'].join('\n');
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = checkMergeGateMetrics('grandamenium/cortextos');
    expect(result.gated_prs?.[0].labeled_at).toBe('2026-08-30T00:00:00Z');
  });

  it('returns zero depth and null age when no PRs carry the label', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) return '[]';
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = checkMergeGateMetrics('grandamenium/cortextos');
    expect(result.status).toBe('ok');
    expect(result.gated_queue_depth).toBe(0);
    expect(result.oldest_gated_age_days).toBeNull();
  });
});
