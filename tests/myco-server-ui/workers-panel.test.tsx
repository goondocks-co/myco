/**
 * What an admin reads about the machines running Myco's work: a legacy worker's
 * agents and last check, and the one verdict a machine's page leads with. The
 * words never overstate what is known (a reported sign-in is not a tested
 * provider, and one machine's check is not a verdict on the queue).
 */
import { describe, expect, it } from 'bun:test';
import { agentsWords, lastClaimWords, taskWords } from '../../packages/myco-server/ui/src/features/admin/workers';
import { machineVerdict } from '../../packages/myco-server/ui/src/features/admin/machine/words';
import type { WorkerRow } from '../../packages/myco-server/ui/src/lib/api';
import { RETAINED_TASKS } from '../../packages/myco-server/src/core/task-catalogue';

const NOW = 1_800_000_000_000;

const worker = (over: Partial<WorkerRow> = {}): WorkerRow => ({
  credentialId: 'mt_4Kp9Qs2Vx7Lm0Zb1',
  machineId: 'ada_5a2d54af',
  offers: [{ id: 'codex', authenticated: true }, { id: 'claude-code', authenticated: true }],
  capabilities: ['repository-checkout'],
  lastReason: 'no_work',
  lastSeenAt: NOW - 3_000,
  busy: null,
  eligible: true,
  recent: true,
  ...over,
});


describe('a legacy worker, in words', () => {
  it('says the agents it reported and what that does not prove, unknown rather than none without a readable report', () => {
    expect(agentsWords(worker())).toBe('Reports Codex and Claude Code signed in; their providers aren’t tested here.');
    expect(agentsWords(worker({ offers: [{ id: 'codex', authenticated: false }] }))).toBe('Reported no agent signed in.');
    expect(agentsWords(worker({ offers: [] }))).toBe('Reported no agents.');
    expect(agentsWords(worker({ offers: null, capabilities: null }))).toBe('Which agents it can run is unknown.');
  });

  it('reports the last check for work as that machine’s, never the queue’s verdict, with no age it does not have', () => {
    expect(lastClaimWords(worker({ lastReason: 'no_harness' }))).toBe('Last check for work: the work waiting needs an agent it doesn’t have.');
    expect(lastClaimWords(worker({ lastReason: null }))).toBeNull();
    expect(lastClaimWords(worker({ lastSeenAt: 0 }))).toBeNull();
    expect(lastClaimWords(worker({ busy: { runId: 'run_1', projectId: 'proj_1', task: null, leaseExpiresAt: NOW + 30_000 } }))).toBeNull();
  });

  it('names every task the catalogue serves, each differently', () => {
    const words = RETAINED_TASKS.map((task) => taskWords(task));
    expect(words.filter((word) => word === 'a task')).toEqual([]);
    expect(new Set(words).size).toBe(RETAINED_TASKS.length);
    expect(taskWords('something-new')).toBe('a task');
  });
});

describe('the verdict a machine page leads with', () => {
  const DAY = 86_400_000;
  const claim = (over: Record<string, unknown> = {}) => ({ standing: 'allowed' as const, lastCaptureAt: NOW - 60_000, firstSeenAt: NOW - 30 * DAY, stoppedBy: null, ...over });
  const runner = (over: Record<string, unknown> = {}) => ({ state: 'enabled' as const, display: 'Online' as const, busy: null, lastSeenAt: NOW, removedAt: null, createdAt: NOW - 10 * DAY,
    lastCompleted: { runId: 'r1', projectId: 'p', projectName: 'Myco', task: 'extract-curate', at: NOW - 2 * 3_600_000, status: 'completed' }, lastFailed: null, lastAttempted: null,
    readiness: { state: 'ready' as const, reason: '', observedAt: NOW }, offers: [], awaitingReplacement: false, ...over });

  it('says Working while its runner is online, ahead of capture, with what it is doing', () => {
    expect(machineVerdict(claim(), runner(), NOW)).toEqual({ label: 'Working', tone: 'ok', line: 'Last ran learning 2 h ago.' });
  });

  it('says Capturing for a machine that captured in the last day, and Quiet since its last capture after that', () => {
    expect(machineVerdict(claim(), null, NOW).label).toBe('Capturing');
    expect(machineVerdict(claim({ lastCaptureAt: NOW - 3 * DAY }), null, NOW).label).toMatch(/^Quiet since /);
  });

  it('says Offline for a runner not seen lately, from when it was last seen, never that it stopped', () => {
    const verdict = machineVerdict(claim({ lastCaptureAt: null }), runner({ display: 'Offline', lastSeenAt: NOW - 14 * 60_000 }), NOW);
    expect(verdict).toEqual({ label: 'Offline', tone: 'faint', line: 'Not seen lately; last seen 14 min ago.' });
  });

  it('says Removed only when nothing on it may send or take work, and who stopped it when the server says', () => {
    expect(machineVerdict(claim({ standing: 'stopped', stoppedBy: 'mem_1' }), null, NOW, () => 'Ada').line).toBe('Stopped by Ada; it can’t send anything now.');
    expect(machineVerdict(null, runner({ state: 'removed', display: 'Removed', removedAt: NOW - 2 * DAY }), NOW).label).toBe('Removed');
    expect(machineVerdict(claim({ standing: 'expired' }), null, NOW).label).toBe('Offline');
  });
});
