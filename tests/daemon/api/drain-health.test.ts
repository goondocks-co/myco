/**
 * Team Host member drain health status API (consolidation Task C-5 —
 * routed-capture observability). Verifies the response shape D-2's Team page
 * will consume: every joined host appears once, with per-drain counters
 * mapped to their drain-specific unit field (`pending_bytes` for transcript
 * and plan, `pending_records` for event-replay), omitted when nothing is
 * pending.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDrainHealthHandler } from '@myco/daemon/api/drain-health.js';
import { upsertHost, type HostRecord } from '@myco/host/registry.js';
import type { DrainHealthCounters } from '@myco/capture/drain-health.js';
import { PlanDrainQueue, type PlanDrainStore, type PlanDrainEntry, type PlanFileReader, type PlanPostTransport } from '@myco/capture/plan-drain.js';
import type { RemoteTarget } from '@myco/host/routing.js';

const HOST_A = 'host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOST_B = 'host_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function host(hostId: string, label: string): HostRecord {
  return {
    host_id: hostId,
    label,
    overlay_address: '127.0.0.1:9',
    protocol_version: 1,
    created_at: new Date().toISOString(),
    projects: [],
  };
}

function fakeQueue(byHost: Record<string, DrainHealthCounters>) {
  return { health: () => new Map(Object.entries(byHost)) };
}

describe('GET /api/team-host/drain-health', () => {
  let tmp: string;
  let saved: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-drain-health-api-'));
    saved = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('every joined host appears once, even with zero counters across all three drains', async () => {
    upsertHost(host(HOST_A, 'mac-studio'));

    const handler = createDrainHealthHandler({
      transcriptDrain: fakeQueue({}),
      planDrain: fakeQueue({}),
      eventReplayDrain: fakeQueue({}),
    });
    const res = await handler({ params: {}, query: {}, body: {}, pathname: '/api/team-host/drain-health' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hosts: [{
        host_id: HOST_A,
        label: 'mac-studio',
        drains: {
          transcript: { pending_entries: 0, failing_entries: 0, host_unreachable_entries: 0 },
          plan: { pending_entries: 0, failing_entries: 0, host_unreachable_entries: 0 },
          event_replay: { pending_entries: 0, failing_entries: 0, host_unreachable_entries: 0 },
          residency: { pending_entries: 0, failing_entries: 0, host_unreachable_entries: 0 },
        },
      }],
    });
  });

  test('the residency kind reports per-host in-flight/failing transition counts (same per-kind shape)', async () => {
    upsertHost(host(HOST_A, 'mac-studio'));

    const handler = createDrainHealthHandler({
      transcriptDrain: fakeQueue({}),
      planDrain: fakeQueue({}),
      eventReplayDrain: fakeQueue({}),
      residencyHealth: () => new Map([[HOST_A, { pendingEntries: 2, failingEntries: 1, hostUnreachableEntries: 0 }]]),
    });
    const res = await handler({ params: {}, query: {}, body: {}, pathname: '/api/team-host/drain-health' });
    const body = res.body as { hosts: Array<{ drains: Record<string, Record<string, unknown>> }> };
    // No pendingUnits for residency (whole transitions), so only the three
    // required fields — never a pending_bytes/records.
    expect(body.hosts[0].drains.residency).toEqual({ pending_entries: 2, failing_entries: 1, host_unreachable_entries: 0 });
  });

  test('the default residency health scans the journal store: an in-flight journal with a last_error is a failing entry', async () => {
    upsertHost(host(HOST_A, 'mac-studio'));
    // Write an in-flight attach journal for HOST_A carrying a last_error.
    const { startResidencyJournal, advanceResidencyPhase } = await import('@myco/host/residency-journal.js');
    const projectId = 'proj_dddddddddddddddddddddddddddddddd';
    startResidencyJournal({
      direction: 'attach', phase: 'pushing', host_id: HOST_A, project_id: projectId,
      divert_grove_id: 'grove_dddddddddddddddddddddddddddddddd', source_grove_id: 'grove_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      project_name: 'demo', root: '/x', backup_ref: null, cursors: {},
    });
    advanceResidencyPhase(projectId, 'pushing', { last_error: 'host returned 503', last_error_at: new Date().toISOString() });

    const handler = createDrainHealthHandler({
      transcriptDrain: fakeQueue({}), planDrain: fakeQueue({}), eventReplayDrain: fakeQueue({}),
    });
    const res = await handler({ params: {}, query: {}, body: {}, pathname: '/api/team-host/drain-health' });
    const body = res.body as { hosts: Array<{ drains: Record<string, Record<string, unknown>> }> };
    expect(body.hosts[0].drains.residency).toEqual({ pending_entries: 1, failing_entries: 1, host_unreachable_entries: 0 });
  });

  test('pendingUnits maps to the drain-specific wire field: pending_bytes for transcript/plan, pending_records for event-replay', async () => {
    upsertHost(host(HOST_A, 'mac-studio'));

    const handler = createDrainHealthHandler({
      transcriptDrain: fakeQueue({ [HOST_A]: { pendingEntries: 2, pendingUnits: 4096, failingEntries: 1, hostUnreachableEntries: 1 } }),
      planDrain: fakeQueue({ [HOST_A]: { pendingEntries: 1, pendingUnits: 128, failingEntries: 0, hostUnreachableEntries: 0 } }),
      eventReplayDrain: fakeQueue({ [HOST_A]: { pendingEntries: 3, pendingUnits: 9, failingEntries: 2, hostUnreachableEntries: 1 } }),
    });
    const res = await handler({ params: {}, query: {}, body: {}, pathname: '/api/team-host/drain-health' });

    const body = res.body as { hosts: Array<{ host_id: string; drains: Record<string, Record<string, unknown>> }> };
    expect(body.hosts[0].drains.transcript).toEqual({ pending_entries: 2, pending_bytes: 4096, failing_entries: 1, host_unreachable_entries: 1 });
    expect(body.hosts[0].drains.plan).toEqual({ pending_entries: 1, pending_bytes: 128, failing_entries: 0, host_unreachable_entries: 0 });
    expect(body.hosts[0].drains.event_replay).toEqual({ pending_entries: 3, pending_records: 9, failing_entries: 2, host_unreachable_entries: 1 });
  });

  test('a host absent from a drain\'s health map (nothing ever queued for it) reports zero counters, not an absent row', async () => {
    upsertHost(host(HOST_A, 'mac-studio'));
    upsertHost(host(HOST_B, 'linux-box'));

    // Only HOST_A ever had transcript activity.
    const handler = createDrainHealthHandler({
      transcriptDrain: fakeQueue({ [HOST_A]: { pendingEntries: 1, pendingUnits: 10, failingEntries: 0, hostUnreachableEntries: 0 } }),
      planDrain: fakeQueue({}),
      eventReplayDrain: fakeQueue({}),
    });
    const res = await handler({ params: {}, query: {}, body: {}, pathname: '/api/team-host/drain-health' });
    const body = res.body as { hosts: Array<{ host_id: string; drains: Record<string, Record<string, unknown>> }> };

    expect(body.hosts.map((h) => h.host_id).sort()).toEqual([HOST_A, HOST_B].sort());
    const hostB = body.hosts.find((h) => h.host_id === HOST_B)!;
    expect(hostB.drains.transcript).toEqual({ pending_entries: 0, failing_entries: 0, host_unreachable_entries: 0 });
  });

  test('end-to-end: a real plan-drain queue that recovered on a caught-up pass reports healthy through the route, not a stale unreachable count', async () => {
    // A REAL PlanDrainQueue (not the fakeQueue canned-Map double the other
    // tests use) — the wire-mapping layer must not reintroduce staleness
    // even when the underlying queue's health() is doing real work.
    upsertHost(host(HOST_A, 'mac-studio'));
    const files = new Map<string, string>();
    files.set('/plans/x.md', '# plan');
    const fileReader: PlanFileReader = { read: (p) => files.get(p) ?? null };
    const entries = new Map<string, PlanDrainEntry>();
    const store: PlanDrainStore = {
      list: () => [...entries.values()],
      listForHost: (h) => [...entries.values()].filter((e) => e.host_id === h),
      get: (h, s, r) => entries.get(`${h}|${s}|${r}`) ?? null,
      put: (e) => { entries.set(`${e.host_id}|${e.session_id}|${e.plan_ref}`, { ...e }); },
      remove: (h, s, r) => { entries.delete(`${h}|${s}|${r}`); },
      purgeHost: () => {},
      purgeProject: () => {},
    };
    const target: RemoteTarget = {
      projectId: 'proj_0123456789abcdef0123456789abcdef' as RemoteTarget['projectId'],
      groveId: 'grove_0123456789abcdef0123456789abcdef',
      host: { host_id: HOST_A, label: 'H', overlay_address: '127.0.0.1:9', protocol_version: 1 },
      bearer: 'b',
    };

    // Seed an entry that is ALREADY caught up (acked_hash matches the
    // current file content — computed the same way plan-drain.ts does:
    // sha256 hex of the UTF-8 content) but still carries a stale failure
    // from a past incident, e.g. recorded on a request the host has since
    // separately caught up through another path.
    const crypto = await import('node:crypto');
    const ackedHash = crypto.createHash('sha256').update('# plan', 'utf-8').digest('hex');
    store.put({
      host_id: HOST_A, session_id: 's', plan_ref: 'pl_seeded0000000000000000000000000',
      project_id: 'proj_0123456789abcdef0123456789abcdef', grove_id: 'grove_0123456789abcdef0123456789abcdef',
      plan_path: '/plans/x.md', acked_hash: ackedHash, updated_at: '2020-01-01T00:00:00.000Z',
      consecutive_failures: 3, last_error_kind: 'unreachable', last_error_at: '2020-01-01T00:00:00.000Z',
    });

    const transport: PlanPostTransport = async () => { throw new Error('should not be called — caught up already'); };
    const planDrain = new PlanDrainQueue({
      machineId: 'alice_a1b2c3d4',
      planWatchConfig: { watchDirs: ['/plans'], projectRoot: '/' },
      store, transport, fileReader,
      now: () => 1000, intervalMs: 100_000,
      setTimer: (() => 0) as unknown as (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });
    await planDrain.flushBeforeForward(target); // caught up — a genuine no-op pass

    const handler = createDrainHealthHandler({
      transcriptDrain: fakeQueue({}),
      planDrain,
      eventReplayDrain: fakeQueue({}),
    });
    const res = await handler({ params: {}, query: {}, body: {}, pathname: '/api/team-host/drain-health' });
    const body = res.body as { hosts: Array<{ host_id: string; drains: Record<string, Record<string, unknown>> }> };
    expect(body.hosts[0].drains.plan).toEqual({ pending_entries: 0, failing_entries: 0, host_unreachable_entries: 0 });

    // The STORED entry itself is clean, not just the health() aggregation —
    // the stale-clear fix, not the pre-existing pending-gate.
    const stored = store.get(HOST_A, 's', 'pl_seeded0000000000000000000000000');
    expect(stored?.consecutive_failures).toBe(0);
    expect(stored?.last_error_kind).toBeNull();
  });

  test('no joined hosts → an empty hosts array', async () => {
    const handler = createDrainHealthHandler({
      transcriptDrain: fakeQueue({}),
      planDrain: fakeQueue({}),
      eventReplayDrain: fakeQueue({}),
    });
    const res = await handler({ params: {}, query: {}, body: {}, pathname: '/api/team-host/drain-health' });
    expect(res.body).toEqual({ hosts: [] });
  });
});
