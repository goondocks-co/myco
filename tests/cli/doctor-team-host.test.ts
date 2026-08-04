/**
 * `myco doctor` Team Host checks (consolidation Task C-5 — routed-capture
 * observability): the host-reachability probe (WS5 carried item) and the
 * drain-health summary lines, both machine-global (not vault-scoped).
 */
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkTeamHostDrainHealth as checkTeamHostDrainHealthWith,
  checkTeamHostReachability as checkTeamHostReachabilityWith,
  runChecks as runChecksWith,
} from '@myco/cli/doctor.js';
import { createHostRegistryOperations, type HostRecord } from '@myco/host/registry.js';
import { createFsDrainStore } from '@myco/capture/transcript-drain.js';
import { deriveTranscriptId } from '@myco/host/routed-transcript.js';
import { getMachineId } from '@myco/machine-id.js';
import { clearProjectManifestCache, ensureProjectManifest } from '@myco/config/project-manifest.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { HOST_PROTOCOL_VERSION } from '@myco/constants.js';

const HOST_A = 'host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const { attachProject } = createHostRegistryOperations(testPerUserLockNamespace);
const checkTeamHostDrainHealth = () =>
  checkTeamHostDrainHealthWith(testPerUserLockNamespace);
const checkTeamHostReachability = () =>
  checkTeamHostReachabilityWith(testPerUserLockNamespace);
const runChecks = (vaultDir: string) =>
  runChecksWith(vaultDir, testPerUserLockNamespace);

function host(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    host_id: HOST_A,
    label: 'mac-studio',
    host_url: 'https://host-a.tailnet.ts.net:8443',
    protocol_version: HOST_PROTOCOL_VERSION,
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

  test('a joined host whose address does not resolve is named as a re-join, not a generic failure', async () => {
    // `.invalid` is reserved and cannot resolve, so this exercises the real
    // probe's DNS branch. What the row must not say is "unreachable": a name
    // that no longer resolves means the host was renamed and the stored URL is
    // dead, which only a re-join fixes — a different action from every other
    // failure this check can report.
    writeHostRecordFixture(host({ host_url: 'https://renamed-away.invalid:8443' }));
    const checks = await checkTeamHostReachability();
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('Team Host');
    expect(checks[0].status).toBe('warn');
    expect(checks[0].detail).toContain('re-join');
  });

  test('a host with NO address on record is reported as needing a re-join, never probed', async () => {
    writeHostRecordFixture({ ...host(), host_url: undefined });
    const checks = await checkTeamHostReachability();
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('warn');
    expect(checks[0].detail).toContain('Re-join');
  });

  test('multiple hosts each get their own row, named only on the first', async () => {
    writeHostRecordFixture(host({ host_id: HOST_A, label: 'a' }));
    writeHostRecordFixture(host({ host_id: 'host_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', label: 'b' }));
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
    writeHostRecordFixture(host());
    const checks = await checkTeamHostDrainHealth();
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('Drain health');
    expect(checks[0].status).toBe('ok');
    expect(checks[0].detail).toContain('nothing pending, no failures');
  });

  test('a failing transcript entry (host unreachable) surfaces as a warn row naming the drain', async () => {
    writeHostRecordFixture(host());
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
    writeHostRecordFixture(host());
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

/**
 * `checkDatabase` and `checkCaptureFlow` — attached-project hosted finding
 * (task_f629721c, E-4 W2 Task 7 item g). Both false-reported ("0 sessions" /
 * "capture not flowing") for a healthy ATTACHED project whose data lives on
 * the host, because they queried this machine's local (irrelevant) DB. Both
 * are vault-scoped (unlike the machine-global checks above), so the fixture
 * provisions a real `.myco/` vault dir with a manifest — never registered in
 * any local Grove (matching the never-materialize invariant an attach ref
 * implies) — and an attach ref on a host record.
 */
describe('checkDatabase / checkCaptureFlow — attached project hosted finding', () => {
  let tmp: string;
  let vaultDir: string;
  let savedHome: string | undefined;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-attached-'));
    vaultDir = path.join(tmp, 'checkout', '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n');
    savedHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(tmp, 'home');
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team-home');
    clearProjectManifestCache();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('an attached project renders an informational hosted finding for both Database and Capture — never "0 sessions" / "capture not flowing"', async () => {
    const manifest = ensureProjectManifest(vaultDir, { projectName: 'attached-proj' });
    writeHostRecordFixture({
      host_id: HOST_A,
      label: 'mac-studio',
      host_url: 'https://host-a.tailnet.ts.net:8443',
      protocol_version: HOST_PROTOCOL_VERSION,
      created_at: new Date().toISOString(),
      projects: [],
      // No usable address on record — the probe's own
      // "not confirmable" branch, so runChecks() dials no network here.
    });
    attachProject(HOST_A, { grove_id: 'grove_x', project_id: manifest.project.id });

    const checks = await runChecks(vaultDir);
    const database = checks.find((c) => c.name === 'Database')!;
    const capture = checks.find((c) => c.name === 'Capture')!;

    expect(database.status).toBe('ok');
    expect(database.fixable).toBe(false);
    expect(database.detail).toContain('hosted');
    expect(database.detail).toContain('mac-studio');
    expect(database.detail).not.toMatch(/0 sessions/);

    expect(capture.status).toBe('ok');
    expect(capture.fixable).toBe(false);
    expect(capture.detail).toContain('hosted');
    expect(capture.detail).toContain('mac-studio');
    expect(capture.detail).not.toContain('No sessions in the last');
    expect(capture.detail).not.toContain('capture may not be flowing');
    expect(capture.detail).not.toContain('No sessions captured yet');
  });

  test('a local (non-attached) project never renders the hosted finding — resolveAttach finds no ref', async () => {
    ensureProjectManifest(vaultDir, { projectName: 'local-proj' });
    // No host fixture or attachProject — this project is not attached to anything.

    const checks = await runChecks(vaultDir);
    const database = checks.find((c) => c.name === 'Database')!;
    const capture = checks.find((c) => c.name === 'Capture')!;

    expect(database.detail).not.toContain('hosted');
    expect(capture.detail).not.toContain('hosted');
  });
});
