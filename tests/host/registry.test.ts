/**
 * Tests for the machine-global host/attach registry (Team Host member side).
 *
 * `resolveHostsDir` funnels through `resolveTeamsHome`, which reads
 * `MYCO_TEAM_HOME` from process.env (see `grove/paths.ts`) — tests point
 * that at a fresh tmpdir per test so they never touch the developer's real
 * `~/.myco-team`, mirroring the env-override + tmpdir pattern used by
 * `symbionts/installer/project-files.test.ts` and `config/secrets.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HOST_BEARER_SECRET } from '@myco/constants';
import { createHostId } from '@myco/grove/ids';
import {
  attachProject,
  detachProject,
  getHost,
  ProjectAttachedToOtherHostError,
  readHostRegistry,
  readHostSecrets,
  removeHost,
  resolveAttach,
  upsertHost,
  writeHostSecret,
  type HostRecord,
} from '@myco/host/registry';

function makeHost(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    host_id: createHostId(),
    label: 'Mac Studio',
    overlay_address: '100.64.0.1:7433',
    protocol_version: 1,
    created_at: new Date().toISOString(),
    projects: [],
    ...overrides,
  };
}

describe('host registry', () => {
  let tmp: string;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-registry-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });

  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('round-trip: upsert then read back, with an attached project', () => {
    const host = makeHost();
    const ref = { grove_id: 'grove-1', project_id: 'proj-1' };
    upsertHost(host);
    attachProject(host.host_id, ref);

    const all = readHostRegistry();
    expect(all).toHaveLength(1);
    expect(all[0].host_id).toBe(host.host_id);
    expect(all[0].label).toBe('Mac Studio');
    expect(all[0].projects).toEqual([ref]);

    expect(getHost(host.host_id)?.overlay_address).toBe('100.64.0.1:7433');
  });

  test('resolveAttach hits the host + ref for an attached project', () => {
    const host = makeHost();
    const ref = { grove_id: 'grove-2', project_id: 'proj-2' };
    upsertHost(host);
    attachProject(host.host_id, ref);

    const resolved = resolveAttach(ref.project_id);
    expect(resolved).not.toBeNull();
    expect(resolved?.host.host_id).toBe(host.host_id);
    expect(resolved?.ref).toEqual(ref);
  });

  test('resolveAttach misses for a project attached to no host', () => {
    upsertHost(makeHost());
    expect(resolveAttach('proj-unattached')).toBeNull();
  });

  test('resolveAttach misses when the registry has no hosts at all', () => {
    expect(resolveAttach('proj-anything')).toBeNull();
  });

  test('detachProject removes the ref; resolveAttach then misses', () => {
    const host = makeHost();
    const ref = { grove_id: 'grove-3', project_id: 'proj-3' };
    upsertHost(host);
    attachProject(host.host_id, ref);
    expect(resolveAttach(ref.project_id)).not.toBeNull();

    detachProject(host.host_id, ref.project_id);

    expect(resolveAttach(ref.project_id)).toBeNull();
    expect(getHost(host.host_id)?.projects).toEqual([]);
  });

  test('detachProject on an unknown host is a silent no-op', () => {
    expect(() => detachProject(createHostId(), 'proj-nope')).not.toThrow();
  });

  test('attachProject throws for an unknown host', () => {
    expect(() => attachProject(createHostId(), { grove_id: 'grove-4', project_id: 'proj-4' }))
      .toThrow(/Unknown host/);
  });

  test('attachProject is idempotent for an already-attached project (same host)', () => {
    const host = makeHost();
    const ref = { grove_id: 'grove-5', project_id: 'proj-5' };
    upsertHost(host);
    attachProject(host.host_id, ref);
    expect(() => attachProject(host.host_id, ref)).not.toThrow();
    expect(getHost(host.host_id)?.projects).toHaveLength(1);
  });

  test('attachProject throws ProjectAttachedToOtherHostError when the project is already attached to a different host', () => {
    const hostA = makeHost({ label: 'Host A' });
    const hostB = makeHost({ label: 'Host B' });
    const ref = { grove_id: 'grove-6', project_id: 'proj-6' };
    upsertHost(hostA);
    upsertHost(hostB);
    attachProject(hostA.host_id, ref);

    let caught: unknown;
    try {
      attachProject(hostB.host_id, ref);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProjectAttachedToOtherHostError);
    const err = caught as ProjectAttachedToOtherHostError;
    expect(err.projectId).toBe(ref.project_id);
    expect(err.attemptedHostId).toBe(hostB.host_id);
    expect(err.existingHostId).toBe(hostA.host_id);

    // The write must not have happened — hostB stays unattached, hostA
    // keeps sole ownership, and resolveAttach still resolves to hostA.
    expect(getHost(hostB.host_id)?.projects).toEqual([]);
    expect(getHost(hostA.host_id)?.projects).toEqual([ref]);
    expect(resolveAttach(ref.project_id)?.host.host_id).toBe(hostA.host_id);
  });

  test('removeHost deletes the record and its secrets', () => {
    const host = makeHost();
    upsertHost(host);
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, 'a-bearer-token');

    removeHost(host.host_id);

    expect(getHost(host.host_id)).toBeNull();
    expect(readHostSecrets(host.host_id)).toEqual({});
  });

  test('bearer round-trips via secrets and never appears in host.json on disk', () => {
    const host = makeHost();
    upsertHost(host);
    const bearer = 'super-secret-host-bearer-value';
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, bearer);

    expect(readHostSecrets(host.host_id)[HOST_BEARER_SECRET]).toBe(bearer);

    const hostDir = path.join(tmp, 'hosts', host.host_id);
    const rawRegistry = fs.readFileSync(path.join(hostDir, 'host.json'), 'utf-8');
    expect(rawRegistry).not.toContain(bearer);

    const rawSecrets = fs.readFileSync(path.join(hostDir, 'secrets.env'), 'utf-8');
    expect(rawSecrets).toContain(bearer);
  });
});
