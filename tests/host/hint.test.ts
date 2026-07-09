/**
 * Tests for the Team Host affiliation hint: `teamHostHintFromManifest` (the
 * prompt-only reading of `grove.remote { provider: 'team-host', remote_id }`
 * off an already-loaded project manifest), `resolveTeamHostHintState` /
 * `teamHostHintMessage` (the shared classification + message text used by
 * both `checkTeamHostHint` and `noticeTeamHostHintOnce`), and
 * `noticeTeamHostHintOnce`'s once-per-host stderr notice.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseProjectManifest, type ProjectManifest } from '@myco/config/project-manifest';
import { createHostId, createProjectId } from '@myco/grove/ids';
import { attachProject, upsertHost, type HostRecord } from '@myco/host/registry';
import {
  __resetTeamHostHintNoticeForTests,
  noticeTeamHostHintOnce,
  resolveTeamHostHintState,
  teamHostHintFromManifest,
  teamHostHintMessage,
} from '@myco/host/hint';

function manifestWith(grove?: ProjectManifest['grove']): ProjectManifest {
  return { project: { id: 'proj_test' }, grove };
}

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

describe('teamHostHintFromManifest', () => {
  test('null manifest → null', () => {
    expect(teamHostHintFromManifest(null)).toBeNull();
  });

  test('no grove block → null', () => {
    expect(teamHostHintFromManifest(manifestWith(undefined))).toBeNull();
  });

  test('grove with no remote block → null', () => {
    expect(teamHostHintFromManifest(manifestWith({ mode: 'local' }))).toBeNull();
  });

  test('remote block with a different provider → null', () => {
    expect(teamHostHintFromManifest(manifestWith({
      mode: 'local',
      remote: { provider: 'other-provider', remote_id: 'host_abc' },
    }))).toBeNull();
  });

  test('remote provider matches but remote_id is missing → null', () => {
    expect(teamHostHintFromManifest(manifestWith({
      mode: 'local',
      remote: { provider: 'team-host' },
    }))).toBeNull();
  });

  test('valid team-host hint → { host_id }', () => {
    const hint = teamHostHintFromManifest(manifestWith({
      mode: 'local',
      remote: { provider: 'team-host', remote_id: 'host_abc123' },
    }));
    expect(hint).toEqual({ host_id: 'host_abc123' });
  });

  test('regression: a manifest with grove.remote plus a secret-like key elsewhere still rejects (existing guard)', () => {
    const toml = `
[project]
id = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[grove]
mode = "local"
api_key = "sk-should-not-be-here"

[grove.remote]
provider = "team-host"
remote_id = "host_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
`;
    expect(() => parseProjectManifest(toml)).toThrow(/secret-like/);
  });
});

describe('resolveTeamHostHintState / teamHostHintMessage', () => {
  let tmp: string;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hint-state-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });

  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('no hint → none, no message', () => {
    const state = resolveTeamHostHintState(manifestWith(undefined), 'proj_x');
    expect(state).toEqual({ kind: 'none' });
    expect(teamHostHintMessage(state)).toBeNull();
  });

  test('hint + host enrolled + attached → resolved, no message', () => {
    const projectId = createProjectId();
    const hostId = createHostId();
    upsertHost(makeHost(hostId));
    attachProject(hostId, { grove_id: 'grove_x', project_id: projectId });

    const manifest = manifestWith({ mode: 'local', remote: { provider: 'team-host', remote_id: hostId } });
    const state = resolveTeamHostHintState(manifest, projectId);
    expect(state).toEqual({ kind: 'resolved' });
    expect(teamHostHintMessage(state)).toBeNull();
  });

  test('hint + host enrolled + NOT attached → not_attached, message suggests attaching', () => {
    const hostId = createHostId();
    upsertHost(makeHost(hostId));

    const manifest = manifestWith({ mode: 'local', remote: { provider: 'team-host', remote_id: hostId } });
    const state = resolveTeamHostHintState(manifest, createProjectId());
    expect(state).toEqual({ kind: 'not_attached', hostId });
    const message = teamHostHintMessage(state);
    expect(message).toContain(hostId);
    expect(message).toContain('attach');
    expect(message).not.toContain('myco join');
  });

  test('hint + host NOT enrolled → not_joined, message suggests myco join', () => {
    const hostId = createHostId();
    const manifest = manifestWith({ mode: 'local', remote: { provider: 'team-host', remote_id: hostId } });
    const state = resolveTeamHostHintState(manifest, createProjectId());
    expect(state).toEqual({ kind: 'not_joined', hostId });
    expect(teamHostHintMessage(state)).toContain(`myco join ${hostId}`);
  });
});

describe('noticeTeamHostHintOnce', () => {
  let tmp: string;
  let savedTeamHome: string | undefined;
  let stderrChunks: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hint-notice-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
    __resetTeamHostHintNoticeForTests();

    stderrChunks = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: unknown): boolean => {
      stderrChunks.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    __resetTeamHostHintNoticeForTests();
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('no hint → never writes to stderr', () => {
    noticeTeamHostHintOnce(manifestWith(undefined), 'proj_x');
    expect(stderrChunks).toEqual([]);
  });

  test('hint not joined → notices once per (host, project); same project suppressed, a different project on the same host notices again', () => {
    const hostId = createHostId();
    const manifest = manifestWith({ mode: 'local', remote: { provider: 'team-host', remote_id: hostId } });
    const projectA = createProjectId();

    noticeTeamHostHintOnce(manifest, projectA);
    noticeTeamHostHintOnce(manifest, projectA); // same (host, project) → suppressed

    let hits = stderrChunks.filter((c) => c.includes(hostId));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(`myco join ${hostId}`);

    // A DIFFERENT project that hints at the same host still gets its own notice —
    // the dedup is keyed on (host_id, project_id), not the host alone.
    noticeTeamHostHintOnce(manifest, createProjectId());
    hits = stderrChunks.filter((c) => c.includes(hostId));
    expect(hits).toHaveLength(2);
  });

  test('resolved (attached) → never writes to stderr', () => {
    const projectId = createProjectId();
    const hostId = createHostId();
    upsertHost(makeHost(hostId));
    attachProject(hostId, { grove_id: 'grove_x', project_id: projectId });

    const manifest = manifestWith({ mode: 'local', remote: { provider: 'team-host', remote_id: hostId } });
    noticeTeamHostHintOnce(manifest, projectId);

    expect(stderrChunks).toEqual([]);
  });
});
