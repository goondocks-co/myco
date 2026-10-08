/**
 * What an admin reads on Health about the machines running Myco's work.
 *
 * The words distinguish five situations a single busy count cannot: a machine
 * waiting and ready, one driving a run, one nothing has heard from lately, one
 * whose check for work found nothing it could run, and a server that could not
 * answer at all. They never overstate what is known (a reported sign-in is not
 * a tested provider, and one machine's check is not a verdict on the queue),
 * and they name a machine and a project by name, never by an id.
 */
import { describe, expect, it } from 'bun:test';
import { agentsWords, fleetLine, lastClaimWords, taskWords, workerLine } from '../../packages/myco-server/ui/src/features/admin/workers';
import type { WorkerRow, WorkerStatus } from '../../packages/myco-server/ui/src/lib/api';

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

const status = (over: Partial<WorkerStatus> = {}): WorkerStatus => ({
  available: true, workersBusy: 0, runsQueued: 0, recentWithinMs: 90_000, fleet: [worker()], ...over,
});

const names = { machine: 'Ada’s studio Mac', project: (id: string) => (id === MYCO ? 'Myco' : null) };

describe('a machine running Myco’s work, in words', () => {
  it('names an enrolled runner separately from member machines', () => {
    const row = worker({ runner: { id: 'runner-mini', name: 'Homelab mini', state: 'enabled' } });
    expect(workerLine(row, NOW, names).line).toContain('Homelab mini · Registered runner');
    expect(workerLine(row, NOW, names).line).not.toContain('member credential');
  });

  it('shows an idle machine as waiting, with the agents it reported and what that does not prove', () => {
    expect(workerLine(worker(), NOW, names)).toEqual({ tone: 'ok', line: 'Ada’s studio Mac · Legacy worker — uses member credential · Waiting for work · last checked in 3s ago' });
    expect(agentsWords(worker())).toBe('Reports Codex and Claude Code signed in; their providers aren’t tested here.');
  });

  it('shows a busy machine by its lease and the project by name, without promising the lease will be renewed', () => {
    const busy = worker({ busy: { runId: 'run_4f1c9a2e7b', projectId: MYCO, task: 'title-summary', leaseExpiresAt: NOW + 62_000 } });
    const { line } = workerLine(busy, NOW, names);
    expect(line).toBe('Ada’s studio Mac · Legacy worker — uses member credential · Running titling in Myco · due to check in within 62s');
    expect(line).not.toMatch(/renew/i);
    expect(line).not.toContain(MYCO);
    expect(lastClaimWords(busy)).toBeNull();
  });

  it('leaves out a project it cannot name rather than showing its id', () => {
    const busy = worker({ busy: { runId: 'run_1', projectId: 'proj_ffffffffffffffffffffffffffffffff', task: null, leaseExpiresAt: NOW + 30_000 } });
    expect(workerLine(busy, NOW, names).line).toBe('Ada’s studio Mac · Legacy worker — uses member credential · Running a task · due to check in within 30s');
    expect(taskWords('something-new')).toBe('a task');
  });

  it('says a machine has not been heard from lately without claiming it stopped', () => {
    const { tone, line } = workerLine(worker({ recent: false, lastSeenAt: NOW - 14 * 60_000 }), NOW, names);
    expect({ tone, line }).toEqual({ tone: 'faint', line: 'Ada’s studio Mac · Legacy worker — uses member credential · Not checking in now · last checked in 14m ago' });
    for (const word of [/stopped/i, /terminated/i, /offline/i, /dead/i]) expect(line).not.toMatch(word);
  });

  it('reports the last check for work as that machine’s, never the queue’s verdict, with no age it does not have', () => {
    expect(lastClaimWords(worker({ lastReason: 'no_harness' }))).toBe('Last check for work: the work waiting needs an agent it doesn’t have.');
    expect(lastClaimWords(worker({ lastReason: null }))).toBeNull();
    expect(lastClaimWords(worker({ lastSeenAt: 0 }))).toBeNull();
  });

  it('does not call a machine ready when it reported no agent signed in', () => {
    const w = worker({ offers: [{ id: 'codex', authenticated: false }] });
    expect(workerLine(w, NOW, names)).toEqual({ tone: 'bad', line: 'Ada’s studio Mac · Legacy worker — uses member credential · Waiting for work, but reported no agent signed in · last checked in 3s ago' });
    expect(agentsWords(w)).toBe('Reported no agent signed in.');
    expect(agentsWords(worker({ offers: [] }))).toBe('Reported no agents.');
  });

  it('says the agents are unknown rather than none when there is no readable report, and never treats it as ready', () => {
    const w = worker({ offers: null, capabilities: null });
    expect(agentsWords(w)).toBe('Which agents it can run is unknown.');
    expect(workerLine(w, NOW, names)).toEqual({ tone: 'bad', line: 'Ada’s studio Mac · Legacy worker — uses member credential · Waiting for work, with no readable report of its agents · last checked in 3s ago' });
  });

  it('says a machine whose claims the server would refuse is not waiting for work', () => {
    const { line } = workerLine(worker({ eligible: false }), NOW, names);
    expect(line).toBe('Ada’s studio Mac · Legacy worker — uses member credential · It can’t take work now · last checked in 3s ago');
    expect(line).not.toContain('Waiting');
  });

  it('shows a lease holder from before contacts were kept as busy, with no invented contact time', () => {
    const w = worker({ lastSeenAt: 0, lastReason: null, recent: false, busy: { runId: 'run_9', projectId: MYCO, task: null, leaseExpiresAt: NOW + 30_000 } });
    expect(workerLine(w, NOW, names).line).toBe('Ada’s studio Mac · Legacy worker — uses member credential · Running a task in Myco · due to check in within 30s');
  });
});

describe('the machines running Myco’s work, in one line', () => {
  it('says how many are running it and what waits', () => {
    expect(fleetLine(status({ runsQueued: 1 }), NOW)).toEqual({ tone: 'ok', attached: 1, line: '1 machine is running Myco’s work, 0 busy now. 1 task is waiting.' });
  });

  it('says none is running it, when one was last heard from, and what waits for one', () => {
    expect(fleetLine(status({ runsQueued: 3, fleet: [worker({ recent: false, lastSeenAt: NOW - 8 * 86_400_000 })] }), NOW))
      .toEqual({ tone: 'bad', attached: 0, line: 'No machine is running Myco’s work. A machine last checked in 8d ago. 3 tasks are waiting.' });
  });

  it('says no machine has checked in when the fleet holds nothing', () => {
    expect(fleetLine(status({ runsQueued: 0, fleet: [] }), NOW)).toEqual({ tone: 'faint', attached: 0, line: 'No machine is running Myco’s work. No machine has checked in yet. Nothing is waiting.' });
  });

  it('does not count a machine whose claims would be refused as running it, or its contact as a worker’s', () => {
    expect(fleetLine(status({ fleet: [worker({ eligible: false }), worker({ credentialId: 'mt_2', recent: false, lastSeenAt: NOW - 2 * 3_600_000 })] }), NOW).line)
      .toBe('No machine is running Myco’s work. A machine last checked in 2h ago. Nothing is waiting.');
    expect(fleetLine(status({ fleet: [worker({ eligible: false })] }), NOW).line)
      .toBe('No machine is running Myco’s work. No machine has checked in yet. Nothing is waiting.');
  });
});
