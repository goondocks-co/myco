/**
 * What an admin reads about the machines running Myco's work, on People & machines and Runners.
 *
 * The words distinguish five situations a single busy count cannot: a machine
 * waiting and ready, one driving a run, one nothing has heard from lately, one
 * whose check for work found nothing it could run, and a server that could not
 * answer at all. They never overstate what is known (a reported sign-in is not
 * a tested provider, and one machine's check is not a verdict on the queue),
 * and they name a machine and a project by name, never by an id.
 */
import { describe, expect, it } from 'bun:test';
import { agentsWords, lastClaimWords, taskWords, workerState } from '../../packages/myco-server/ui/src/features/admin/workers';
import type { WorkerRow } from '../../packages/myco-server/ui/src/lib/api';
import { RETAINED_TASKS } from '../../packages/myco-server/src/core/task-catalogue';

const NOW = 1_800_000_000_000;
const MYCO = 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11';

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

const project = (id: string) => (id === MYCO ? 'Myco' : null);

describe('a machine running Myco’s work, in words', () => {
  it('shows an idle machine as waiting, with the agents it reported and what that does not prove', () => {
    expect(workerState(worker(), NOW, project)).toEqual({ tone: 'ok', line: 'Waiting for work · last checked in 3s ago' });
    expect(agentsWords(worker())).toBe('Reports Codex and Claude Code signed in; their providers aren’t tested here.');
  });

  it('shows a busy machine by its lease and the project by name, without promising the lease will be renewed', () => {
    const busy = worker({ busy: { runId: 'run_4f1c9a2e7b', projectId: MYCO, task: 'title-summary', leaseExpiresAt: NOW + 62_000 } });
    const { line } = workerState(busy, NOW, project);
    expect(line).toBe('Running titling in Myco · due to check in within 62s');
    expect(line).not.toMatch(/renew/i);
    expect(line).not.toContain(MYCO);
    expect(lastClaimWords(busy)).toBeNull();
  });

  it('leaves out a project it cannot name rather than showing its id', () => {
    const busy = worker({ busy: { runId: 'run_1', projectId: 'proj_ffffffffffffffffffffffffffffffff', task: null, leaseExpiresAt: NOW + 30_000 } });
    expect(workerState(busy, NOW, project).line).toBe('Running a task · due to check in within 30s');
    expect(taskWords('something-new')).toBe('a task');
  });

  it('names every task the catalogue serves, each differently', () => {
    const words = RETAINED_TASKS.map((task) => taskWords(task));
    expect(words.filter((word) => word === 'a task')).toEqual([]);
    expect(new Set(words).size).toBe(RETAINED_TASKS.length);
  });

  it('says a machine has not been heard from lately without claiming it stopped', () => {
    const { tone, line } = workerState(worker({ recent: false, lastSeenAt: NOW - 14 * 60_000 }), NOW, project);
    expect({ tone, line }).toEqual({ tone: 'faint', line: 'Not checking in now · last checked in 14 min ago' });
    for (const word of [/stopped/i, /terminated/i, /offline/i, /dead/i]) expect(line).not.toMatch(word);
  });

  it('reports the last check for work as that machine’s, never the queue’s verdict, with no age it does not have', () => {
    expect(lastClaimWords(worker({ lastReason: 'no_harness' }))).toBe('Last check for work: the work waiting needs an agent it doesn’t have.');
    expect(lastClaimWords(worker({ lastReason: null }))).toBeNull();
    expect(lastClaimWords(worker({ lastSeenAt: 0 }))).toBeNull();
  });

  it('does not call a machine ready when it reported no agent signed in', () => {
    const w = worker({ offers: [{ id: 'codex', authenticated: false }] });
    expect(workerState(w, NOW, project)).toEqual({ tone: 'bad', line: 'Waiting for work, but reported no agent signed in · last checked in 3s ago' });
    expect(agentsWords(w)).toBe('Reported no agent signed in.');
    expect(agentsWords(worker({ offers: [] }))).toBe('Reported no agents.');
  });

  it('says the agents are unknown rather than none when there is no readable report, and never treats it as ready', () => {
    const w = worker({ offers: null, capabilities: null });
    expect(agentsWords(w)).toBe('Which agents it can run is unknown.');
    expect(workerState(w, NOW, project)).toEqual({ tone: 'bad', line: 'Waiting for work, with no readable report of its agents · last checked in 3s ago' });
  });

  it('says a machine whose claims the server would refuse is not waiting for work', () => {
    const { line } = workerState(worker({ eligible: false }), NOW, project);
    expect(line).toBe('It can’t take work now · last checked in 3s ago');
    expect(line).not.toContain('Waiting');
  });

  it('shows a lease holder from before contacts were kept as busy, with no invented contact time', () => {
    const w = worker({ lastSeenAt: 0, lastReason: null, recent: false, busy: { runId: 'run_9', projectId: MYCO, task: null, leaseExpiresAt: NOW + 30_000 } });
    expect(workerState(w, NOW, project).line).toBe('Running a task in Myco · due to check in within 30s');
  });
});
