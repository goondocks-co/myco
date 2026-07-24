/**
 * Tests for `ensureProjectRegistered`'s Team Host affiliation hint notice.
 *
 * The hint (`grove.remote { provider: 'team-host', remote_id }`, see
 * `host/hint.ts`) is prompt-only: it must never block, change, or auto-
 * resolve the local Grove registration it warns about — only add a
 * one-time stderr notice. This exercises the real cold path (first-ever
 * registration for a project root) rather than the pure classification
 * helpers, which are covered in `host/hint.test.ts`.
 */
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearProjectManifestCache } from '@myco/config/project-manifest';
import { __resetTeamHostHintNoticeForTests } from '@myco/host/hint';
import { type HostRecord } from '@myco/host/registry';
import { createHostId } from '@myco/grove/ids';
import { MYCO_HOME_ENV } from '@myco/grove/paths';
import {
  ensureDefaultGrove,
  ensureProjectRegistered as ensureProjectRegisteredWithDefaults,
  findProjectByRoot,
} from '@myco/grove/registry';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const ensureProjectRegistered = (
  projectRoot: string,
  mycoHome: string,
) => ensureProjectRegisteredWithDefaults(
  projectRoot,
  mycoHome,
  testPerUserLockNamespace,
);

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

describe('ensureProjectRegistered — Team Host hint notice', () => {
  let mycoHome: string;
  let teamHome: string;
  let projectRoot: string;
  let savedMycoHome: string | undefined;
  let savedTeamHome: string | undefined;
  let stderrChunks: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-registry-home-'));
    teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-registry-team-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-registry-proj-'));
    execFileSync('git', ['init', '-q'], { cwd: projectRoot });

    savedMycoHome = process.env[MYCO_HOME_ENV];
    process.env[MYCO_HOME_ENV] = mycoHome;
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = teamHome;

    clearProjectManifestCache();
    __resetTeamHostHintNoticeForTests();
    ensureDefaultGrove(mycoHome);

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
    if (savedMycoHome === undefined) delete process.env[MYCO_HOME_ENV];
    else process.env[MYCO_HOME_ENV] = savedMycoHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(mycoHome, { recursive: true, force: true });
    fs.rmSync(teamHome, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeManifest(hostId?: string): void {
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    const remote = hostId
      ? `\n[grove.remote]\nprovider = "team-host"\nremote_id = "${hostId}"\n`
      : '';
    fs.writeFileSync(
      path.join(vaultDir, 'project.toml'),
      `[project]\nid = "proj_${'a'.repeat(32)}"\n${remote}`,
      'utf-8',
    );
  }

  test('no hint → registers locally, zero notice (byte-identical to pre-hint behavior)', () => {
    writeManifest();
    const result = ensureProjectRegistered(projectRoot, mycoHome);
    expect(result).not.toBeNull();
    expect(findProjectByRoot(projectRoot, mycoHome)).not.toBeNull();
    expect(stderrChunks).toEqual([]);
  });

  test('hint + host NOT enrolled → notice suggests joining, project still registers locally', () => {
    const hostId = createHostId();
    writeManifest(hostId);

    const result = ensureProjectRegistered(projectRoot, mycoHome);

    expect(result).not.toBeNull();
    expect(findProjectByRoot(projectRoot, mycoHome)).not.toBeNull();
    const hits = stderrChunks.filter((c) => c.includes(hostId));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(`myco join ${hostId}`);
  });

  test('hint + host enrolled but NOT attached → notice suggests attaching, project still registers locally', () => {
    const hostId = createHostId();
    writeManifest(hostId);
    writeHostRecordFixture(makeHost(hostId));

    ensureProjectRegistered(projectRoot, mycoHome);

    const hits = stderrChunks.filter((c) => c.includes(hostId));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('attach');
    expect(hits[0]).not.toContain('myco join');
  });

  test('notice fires at most once ever: a second hook call (already registered) is silent', () => {
    const hostId = createHostId();
    writeManifest(hostId);

    ensureProjectRegistered(projectRoot, mycoHome);
    expect(stderrChunks.filter((c) => c.includes(hostId))).toHaveLength(1);

    stderrChunks.length = 0;
    ensureProjectRegistered(projectRoot, mycoHome);
    expect(stderrChunks.filter((c) => c.includes(hostId))).toHaveLength(0);
  });

  test('the notice never blocks or alters registration: local Grove row is created either way', () => {
    const hostId = createHostId();
    writeManifest(hostId);

    const withHint = ensureProjectRegistered(projectRoot, mycoHome);
    expect(withHint?.project.status).toBe('active');
    expect(withHint?.project.root).toBe(path.resolve(projectRoot));
  });
});
