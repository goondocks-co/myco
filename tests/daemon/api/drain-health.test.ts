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
        },
      }],
    });
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
