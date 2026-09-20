// @vitest-environment jsdom

/**
 * What an owner reads on Status about workers.
 *
 * The panel's job is to distinguish five situations a single busy count cannot:
 * a worker polling and ready, a worker driving a run, one nothing has heard
 * from lately, one whose claim found no harness it could use, and a server that
 * could not answer at all. It must also never overstate what it knows — a
 * reported login is not a tested provider, and one worker's refusal is not a
 * statement about the queue.
 */
import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { WorkersPanel } from '../../packages/myco-server/ui/src/components/status/WorkersPanel';
import type { WorkerRow, WorkerStatus } from '../../packages/myco-server/ui/src/lib/api';

const NOW = 1_800_000_000_000;

const worker = (over: Partial<WorkerRow> = {}): WorkerRow => ({
  credentialId: 'mt_1',
  machineId: 'sirkirby-mbp',
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
  available: true,
  workersBusy: 0,
  runsQueued: 0,
  recentWithinMs: 90_000,
  fleet: [worker()],
  ...over,
});

describe('WorkersPanel', () => {
  it('shows an idle worker as polling, with what it reported and what that does not prove', () => {
    render(<WorkersPanel workers={status()} now={NOW} />);
    expect(screen.getByText(/sirkirby-mbp · Polling for work · Last contact 3s ago/)).toBeDefined();
    expect(screen.getByText(/Reported authenticated: Codex, Claude Code\./)).toBeDefined();
    expect(screen.getByText(/Provider access has not been tested by this check\./)).toBeDefined();
  });

  it('shows a busy worker by its lease, without promising the lease will be renewed', () => {
    render(<WorkersPanel workers={status({
      workersBusy: 1,
      fleet: [worker({ busy: { runId: 'run_1', projectId: 'myco', task: 'title-summary', leaseExpiresAt: NOW + 62_000 } })],
    })} now={NOW} />);
    expect(screen.getByText(/Running title-summary for myco · Lease expires in 62s/)).toBeDefined();
    // A lease says when it ends, never that it will be extended.
    expect(screen.queryByText(/renew/i)).toBeNull();
  });

  it('says a worker has not been seen recently without claiming it stopped', () => {
    render(<WorkersPanel workers={status({ fleet: [worker({ recent: false, lastSeenAt: NOW - 14 * 60_000 })] })} now={NOW} />);
    expect(screen.getByText(/sirkirby-mbp · Not seen recently · Last contact 14m ago/)).toBeDefined();
    for (const word of [/stopped/i, /terminated/i, /offline/i, /dead/i]) expect(screen.queryByText(word)).toBeNull();
  });

  it('reports the latest claim mismatch beside the queue, as this worker\'s poll and not the queue\'s verdict', () => {
    render(<WorkersPanel workers={status({ runsQueued: 2, fleet: [worker({ lastReason: 'no_harness' })] })} now={NOW} />);
    expect(screen.getByText(/2 queued runs\./)).toBeDefined();
    expect(screen.getByText(/Last claim: no matching harness \(3s ago\)\./)).toBeDefined();
    expect(screen.getByText(/not what every worker can run/)).toBeDefined();
  });

  it('does not call a worker ready when it reported nothing logged in', () => {
    render(<WorkersPanel workers={status({
      fleet: [worker({ offers: [{ id: 'codex', authenticated: false }] })],
    })} now={NOW} />);
    expect(screen.getByText(/Polling, but reported no harness logged in/)).toBeDefined();
    expect(screen.getByText(/Reported none logged in; reported present: Codex\./)).toBeDefined();
  });

  it('says worker status is unavailable rather than showing zero workers when the server could not answer', () => {
    render(<WorkersPanel workers={status({ available: false, fleet: [], workersBusy: 0, runsQueued: 0 })} now={NOW} />);
    expect(screen.getByText(/Worker status unavailable/)).toBeDefined();
    // Nothing that would read as "no workers attached" or "nothing queued".
    expect(screen.queryByText(/No worker has been heard from/)).toBeNull();
    expect(screen.queryByText(/Nothing queued/)).toBeNull();
  });

  it('shows a lease holder that predates contact records as busy, with no invented contact time', () => {
    render(<WorkersPanel workers={status({
      workersBusy: 1,
      fleet: [worker({ lastSeenAt: 0, lastReason: null, recent: false, busy: { runId: 'run_9', projectId: 'myco', task: null, leaseExpiresAt: NOW + 30_000 } })],
    })} now={NOW} />);
    expect(screen.getByText(/Running a run for myco · Lease expires in 30s/)).toBeDefined();
    expect(screen.queryByText(/Last claim:/)).toBeNull();
  });
});
