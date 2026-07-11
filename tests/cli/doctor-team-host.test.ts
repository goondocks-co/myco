/**
 * `myco doctor` Team Host checks (consolidation Task C-5 — routed-capture
 * observability): the host-reachability probe (WS5 carried item) and the
 * drain-health summary lines, both machine-global (not vault-scoped).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkTeamHostDrainHealth, checkTeamHostReachability } from '@myco/cli/doctor.js';
import { upsertHost, type HostRecord } from '@myco/host/registry.js';
import { createFsDrainStore } from '@myco/capture/transcript-drain.js';
import { deriveTranscriptId } from '@myco/host/routed-transcript.js';
import { getMachineId } from '@myco/machine-id.js';

const HOST_A = 'host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function host(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    host_id: HOST_A,
    label: 'mac-studio',
    overlay_address: '127.0.0.1:9',
    protocol_version: 1,
    proxy_port: 39123,
    created_at: new Date().toISOString(),
    projects: [],
    ...overrides,
  };
}

describe('checkTeamHostReachability', () => {
  let tmp: string;
  let saved: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-teamhost-'));
    saved = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
    mock.restore();
  });

  test('no joined hosts → no rows', async () => {
    expect(await checkTeamHostReachability()).toEqual([]);
  });

  test('a host with no proxy_port on record warns to re-join, without probing', async () => {
    upsertHost(host({ proxy_port: undefined }));
    const checks = await checkTeamHostReachability();
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('warn');
    expect(checks[0].detail).toContain('myco join');
  });

  test('a reachable host reports ok', async () => {
    mock.module('@myco/host/member-overlay.js', () => ({
      defaultCheckHostReachable: async () => true,
    }));
    upsertHost(host());
    const checks = await checkTeamHostReachability();
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('Team Host');
    expect(checks[0].status).toBe('ok');
    expect(checks[0].detail).toContain('reachable');
  });

  test('an unreachable host reports warn', async () => {
    mock.module('@myco/host/member-overlay.js', () => ({
      defaultCheckHostReachable: async () => false,
    }));
    upsertHost(host());
    const checks = await checkTeamHostReachability();
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('warn');
    expect(checks[0].detail).toContain('not reachable');
  });

  test('a probe that throws is treated as unreachable, not a crash', async () => {
    mock.module('@myco/host/member-overlay.js', () => ({
      defaultCheckHostReachable: async () => { throw new Error('boom'); },
    }));
    upsertHost(host());
    const checks = await checkTeamHostReachability();
    expect(checks[0].status).toBe('warn');
  });

  test('multiple hosts each get their own row, named only on the first', async () => {
    mock.module('@myco/host/member-overlay.js', () => ({
      defaultCheckHostReachable: async () => true,
    }));
    upsertHost(host({ host_id: HOST_A, label: 'a' }));
    upsertHost(host({ host_id: 'host_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', label: 'b' }));
    const checks = await checkTeamHostReachability();
    expect(checks).toHaveLength(2);
    expect(checks[0].name).toBe('Team Host');
    expect(checks[1].name).toBe('');
  });
});

describe('checkTeamHostDrainHealth', () => {
  let tmp: string;
  let saved: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-drainhealth-'));
    saved = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('no joined hosts → no rows', async () => {
    expect(await checkTeamHostDrainHealth()).toEqual([]);
  });

  test('a joined host with no drain activity reports ok — nothing pending, no failures', async () => {
    upsertHost(host());
    const checks = await checkTeamHostDrainHealth();
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('Drain health');
    expect(checks[0].status).toBe('ok');
    expect(checks[0].detail).toContain('nothing pending, no failures');
  });

  test('a failing transcript entry (host unreachable) surfaces as a warn row naming the drain', async () => {
    upsertHost(host());
    // A LIVE failing entry: the transcript file must actually exist, un-rotated
    // (transcript_id derived from its real inode) and have un-shipped bytes
    // past acked_offset — a failure only counts while there is pending content
    // it is blocking (the inert-entry gate). No daemon process required:
    // doctor constructs its own disk-only queue.
    const transcriptPath = path.join(tmp, 'sess-1.jsonl');
    fs.writeFileSync(transcriptPath, '{"role":"user"}\n', 'utf-8');
    const inode = Number(fs.statSync(transcriptPath).ino);
    createFsDrainStore().put({
      host_id: HOST_A,
      session_id: 'sess-1',
      transcript_id: deriveTranscriptId({ machineId: getMachineId(), transcriptPath, inode }),
      project_id: 'proj_0123456789abcdef0123456789abcdef',
      grove_id: 'grove_0123456789abcdef0123456789abcdef',
      transcript_path: transcriptPath,
      acked_offset: 0,
      updated_at: new Date().toISOString(),
      consecutive_failures: 3,
      last_error_kind: 'unreachable',
      last_error_at: new Date().toISOString(),
    });

    const checks = await checkTeamHostDrainHealth();
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('warn');
    expect(checks[0].detail).toContain('transcript');
    expect(checks[0].detail).toContain('failing');
  });

  test('an inert entry\'s stale failure does NOT warn — rotated/deleted content is not a drain problem (reviewer repro)', async () => {
    upsertHost(host());
    // Same failing entry shape, but its transcript file does not exist — the
    // inert case (deleted, or rotated so the recorded inode no longer
    // matches). Doctor must report ok, not a permanent false warning.
    createFsDrainStore().put({
      host_id: HOST_A,
      session_id: 'sess-1',
      transcript_id: 'tid-stale',
      project_id: 'proj_0123456789abcdef0123456789abcdef',
      grove_id: 'grove_0123456789abcdef0123456789abcdef',
      transcript_path: path.join(tmp, 'gone.jsonl'), // never created
      acked_offset: 0,
      updated_at: new Date().toISOString(),
      consecutive_failures: 3,
      last_error_kind: 'unreachable',
      last_error_at: new Date().toISOString(),
    });

    const checks = await checkTeamHostDrainHealth();
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('ok');
    expect(checks[0].detail).toContain('nothing pending, no failures');
  });
});
