/**
 * Tests for `checkTeamHostHint` — the doctor row that prompts a fresh
 * checkout toward `myco join` + attach when the committed manifest carries
 * a Team Host affiliation hint (`grove.remote { provider: 'team-host',
 * remote_id }`) that this machine hasn't resolved yet.
 *
 * `MYCO_TEAM_HOME` is pointed at a fresh tmpdir per test so the host
 * registry never touches the developer's real `~/.myco-team`, mirroring
 * `host/registry.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearProjectManifestCache } from '@myco/config/project-manifest';
import { createHostId, createProjectId } from '@myco/grove/ids';
import {
  attachProject,
  readHostRegistry,
  resolveAttach,
  upsertHost,
  type HostRecord,
} from '@myco/host/registry';
import { checkTeamHostHint } from '@myco/cli/doctor';

function makeHost(hostId: string): HostRecord {
  return {
    host_id: hostId,
    label: 'Mac Studio',
    overlay_address: '100.64.0.1:7433',
    protocol_version: 1,
    created_at: new Date().toISOString(),
    projects: [],
  };
}

describe('checkTeamHostHint', () => {
  let tmp: string;
  let vaultDir: string;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-host-hint-'));
    vaultDir = path.join(tmp, 'checkout', '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team-home');
    clearProjectManifestCache();
  });

  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeManifest(projectId: string, hostId?: string): void {
    const remote = hostId
      ? `\n[grove.remote]\nprovider = "team-host"\nremote_id = "${hostId}"\n`
      : '';
    fs.writeFileSync(path.join(vaultDir, 'project.toml'), `[project]\nid = "${projectId}"\n${remote}`, 'utf-8');
  }

  test('no hint → no notice (zero behavior change)', () => {
    writeManifest(createProjectId());
    expect(checkTeamHostHint(vaultDir)).toBeNull();
  });

  test('hint + host enrolled + attached → no notice, normal routing', () => {
    const projectId = createProjectId();
    const hostId = createHostId();
    writeManifest(projectId, hostId);
    upsertHost(makeHost(hostId));
    attachProject(hostId, { grove_id: 'grove_1', project_id: projectId });

    expect(resolveAttach(projectId)).not.toBeNull();
    expect(checkTeamHostHint(vaultDir)).toBeNull();
  });

  test('hint + host enrolled + NOT attached → notice suggests attaching', () => {
    const projectId = createProjectId();
    const hostId = createHostId();
    writeManifest(projectId, hostId);
    upsertHost(makeHost(hostId));

    const notice = checkTeamHostHint(vaultDir);
    expect(notice).not.toBeNull();
    expect(notice?.status).toBe('warn');
    expect(notice?.detail).toContain(hostId);
    expect(notice?.detail.toLowerCase()).toContain('attach');
    expect(notice?.detail).not.toContain('myco join');
  });

  test('hint + host NOT enrolled → notice suggests joining', () => {
    const projectId = createProjectId();
    const hostId = createHostId();
    writeManifest(projectId, hostId);
    // Host never upserted — this machine hasn't joined it.

    const notice = checkTeamHostHint(vaultDir);
    expect(notice).not.toBeNull();
    expect(notice?.status).toBe('warn');
    expect(notice?.detail).toContain(`myco join ${hostId}`);
  });

  test('the check is read-only: it never joins or attaches on its own', () => {
    const projectId = createProjectId();
    const hostId = createHostId();
    writeManifest(projectId, hostId);

    checkTeamHostHint(vaultDir);
    checkTeamHostHint(vaultDir);

    expect(readHostRegistry()).toEqual([]);
    expect(resolveAttach(projectId)).toBeNull();
  });
});
