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
    expect(screen.getByText(/Last claim: no matching harness\./)).toBeDefined();
    // The claim's own time is not recorded, so no age is attached to it.
    expect(screen.queryByText(/Last claim: no matching harness \(/)).toBeNull();
    expect(screen.getByText(/not what every worker can run/)).toBeDefined();
  });

  it('does not call a worker ready, or claim it holds a harness, when it reported none authenticated', () => {
    render(<WorkersPanel workers={status({
      fleet: [worker({ offers: [{ id: 'codex', authenticated: false }] })],
    })} now={NOW} />);
    expect(screen.getByText(/Polling, but reported no harness authenticated/)).toBeDefined();
    // `authenticated: false` says nothing about whether the tool is installed.
    expect(screen.getByText(/Reported not authenticated: Codex\./)).toBeDefined();
    expect(screen.queryByText(/present/i)).toBeNull();
    expect(screen.queryByText(/installed/i)).toBeNull();
  });

  it('says offers are unknown rather than none when there is no readable report', () => {
    render(<WorkersPanel workers={status({
      workersBusy: 1,
      fleet: [worker({ offers: null, capabilities: null, lastSeenAt: 0, lastReason: null, recent: false, busy: { runId: 'run_7', projectId: 'myco', task: 'title-summary', leaseExpiresAt: NOW + 30_000 } })],
    })} now={NOW} />);
    expect(screen.getByText(/Offers unknown: this worker has reported none\./)).toBeDefined();
    expect(screen.queryByText(/Reported no harnesses/)).toBeNull();
  });

  it('says a stored report it could not read is unknown, and never treats it as ready', () => {
    render(<WorkersPanel workers={status({ fleet: [worker({ offers: null, capabilities: null })] })} now={NOW} />);
    expect(screen.getByText(/Offers unknown: the stored report could not be read\./)).toBeDefined();
    expect(screen.getByText(/Polling, with no readable report of its harnesses/)).toBeDefined();
    expect(screen.getAllByTestId('status-dot').at(-1)!.dataset.tone).toBe('terracotta');
  });

  it('says a credential the claim route would refuse is not polling for work', () => {
    render(<WorkersPanel workers={status({ fleet: [worker({ eligible: false })] })} now={NOW} />);
    expect(screen.getByText(/A claim from it would be refused now · Last contact 3s ago/)).toBeDefined();
    expect(screen.queryByText(/Polling/)).toBeNull();
  });

  it('says worker status is unavailable rather than showing zero workers when the server could not answer', () => {
    render(<WorkersPanel workers={status({ available: false, fleet: [], workersBusy: 0, runsQueued: 0 })} now={NOW} />);
    expect(screen.getByText(/Worker status unavailable/)).toBeDefined();
    // Nothing that would read as "no workers attached" or "nothing queued".
    expect(screen.queryByText(/No worker contact recorded/)).toBeNull();
    expect(screen.queryByText(/Nothing queued/)).toBeNull();
  });

  it('heads the panel with how many workers are attached and what the queue holds', () => {
    render(<WorkersPanel workers={status({ runsQueued: 1 })} now={NOW} />);
    expect(screen.getByText('1 worker attached, 0 driving a run. 1 queued run.')).toBeDefined();
    expect(screen.queryByText(/myco worker install/)).toBeNull();
  });

  it('says no worker is attached, when one was last heard from, and what waits for one', () => {
    render(<WorkersPanel workers={status({ runsQueued: 3, fleet: [worker({ recent: false, lastSeenAt: NOW - 8 * 86_400_000 })] })} now={NOW} />);
    expect(screen.getByText('No worker attached. Last worker contact 8d ago. 3 queued runs wait until one attaches.')).toBeDefined();
    expect(screen.getByText(/`myco worker install` there keeps one running/)).toBeDefined();
    expect(screen.getAllByTestId('status-dot')[0]!.dataset.tone).toBe('terracotta');
  });

  it('says no worker is attached, and that no contact is recorded, when the fleet holds nothing', () => {
    render(<WorkersPanel workers={status({ runsQueued: 1, fleet: [] })} now={NOW} />);
    expect(screen.getByText('No worker attached. No worker contact recorded. 1 queued run waits until one attaches.')).toBeDefined();
  });

  it('does not count a recent worker the claim route would refuse as attached', () => {
    render(<WorkersPanel workers={status({ fleet: [worker({ eligible: false })] })} now={NOW} />);
    expect(screen.getByText('No worker attached. Last worker contact 3s ago. Nothing queued.')).toBeDefined();
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
