/**
 * Content claim file-status — member disk truth (design §2(b)). Real
 * project registration + real filesystem writes in a temp project root; no
 * Grove DB is ever opened (the route never queries it).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RouteRequest } from '@myco/daemon/router.js';
import { createContentClaimFileStatusHandler } from '@myco/daemon/api/content-claims-file-status.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches } from '@myco/grove/registry.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import { CANONICAL_PROJECT_SKILLS_DIR } from '@myco/skills/publication.js';

interface FileStatusEntry {
  artifact_kind: unknown;
  artifact_id: unknown;
  file_present: boolean | null;
}

function req(projectRoot: string, artifacts: unknown[], extra: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: { project_root: projectRoot, artifacts },
    pathname: '/api/content-claims/file-status',
    ...extra,
  };
}

function writeSkillFile(projectRoot: string, name: string, content = `# ${name}\n`): void {
  const dir = path.join(projectRoot, CANONICAL_PROJECT_SKILLS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
}

/**
 * `resolveMemberProjectContext`'s own prelude (manifest + registry reads)
 * calls `existsSync` too, so a raw call count over the whole handler
 * invocation would be noisy. Filtering to calls that check a `SKILL.md`
 * path isolates the ones this route's per-artifact resolution makes.
 */
function skillPathCalls(spy: ReturnType<typeof spyOn>): string[] {
  return spy.mock.calls
    .map((call) => call[0] as string)
    .filter((checkedPath) => checkedPath.endsWith('SKILL.md'));
}

describe('content claim file-status — local project', () => {
  let tmp: string;
  let mycoHome: string;
  let projectRoot: string;
  let projectId: string;
  let groveId: string;
  let savedHome: string | undefined;
  let savedMycoHome: string | undefined;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cclaim-status-'));
    savedHome = process.env.HOME;
    savedMycoHome = process.env.MYCO_HOME;
    savedTeamHome = process.env.MYCO_TEAM_HOME;

    const fakeHome = path.join(tmp, 'user-home');
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;

    mycoHome = path.join(tmp, 'myco-home');
    fs.mkdirSync(mycoHome, { recursive: true });
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team-home'); // no host ever registered here
    clearGroveRegistryCaches();

    projectRoot = path.join(tmp, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });

    const grove = createGrove('Work', mycoHome);
    groveId = grove.id;

    projectId = assertGroveProjectId(createProjectId());
    registerProjectInGrove(groveId, { projectId, projectName: 'Work project', projectRoot }, mycoHome);
    saveProjectManifest(resolveProjectVaultDir(projectRoot), { project: { id: projectId } });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedMycoHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeamHome;
    clearGroveRegistryCaches();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function handler() {
    const warnObj = { warn(_message: string, _meta?: Record<string, unknown>): void {} };
    const warnSpy = spyOn(warnObj, 'warn');
    const h = createContentClaimFileStatusHandler({
      logger: { warn: warnObj.warn.bind(warnObj), error: () => {} },
      mycoHome,
    });
    return { h, warnSpy };
  }

  test('present/missing: an existing published file reports true, a missing one reports false', async () => {
    writeSkillFile(projectRoot, 'present-skill');

    const { h } = handler();
    const res = await h(req(projectRoot, [
      { artifact_kind: 'skill', artifact_id: 'sk-present', name: 'present-skill' },
      { artifact_kind: 'skill', artifact_id: 'sk-missing', name: 'missing-skill' },
    ]));

    expect(res.status).toBe(200);
    const statuses = (res.body as { statuses: FileStatusEntry[] }).statuses;
    expect(statuses).toEqual([
      { artifact_kind: 'skill', artifact_id: 'sk-present', file_present: true },
      { artifact_kind: 'skill', artifact_id: 'sk-missing', file_present: false },
    ]);
  });

  test('hostile names (traversal, absolute, empty) resolve to null and the resolver refusal never leaks an fs check outside the skills root', async () => {
    writeSkillFile(projectRoot, 'good-skill');
    const skillsRoot = path.resolve(projectRoot, CANONICAL_PROJECT_SKILLS_DIR);

    const existsSpy = spyOn(fs, 'existsSync');
    const { h, warnSpy } = handler();
    try {
      const res = await h(req(projectRoot, [
        { artifact_kind: 'skill', artifact_id: 'sk-good', name: 'good-skill' },
        { artifact_kind: 'skill', artifact_id: 'sk-traversal', name: '../evil' },
        { artifact_kind: 'skill', artifact_id: 'sk-absolute', name: '/etc/passwd' },
        { artifact_kind: 'skill', artifact_id: 'sk-empty', name: '' },
      ]));

      expect(res.status).toBe(200);
      const statuses = (res.body as { statuses: FileStatusEntry[] }).statuses;
      expect(statuses).toEqual([
        { artifact_kind: 'skill', artifact_id: 'sk-good', file_present: true },
        { artifact_kind: 'skill', artifact_id: 'sk-traversal', file_present: null },
        { artifact_kind: 'skill', artifact_id: 'sk-absolute', file_present: null },
        { artifact_kind: 'skill', artifact_id: 'sk-empty', file_present: null },
      ]);

      // The three hostile entries never reach existsSync: only the one
      // legitimate lookup fires, and it stays under the skills root.
      const skillChecks = skillPathCalls(existsSpy);
      expect(skillChecks).toEqual([path.join(skillsRoot, 'good-skill', 'SKILL.md')]);
      for (const checkedPath of skillChecks) {
        expect(checkedPath.startsWith(skillsRoot)).toBe(true);
      }

      // One warn log per bad entry — not noisy, not silent.
      expect(warnSpy).toHaveBeenCalledTimes(3);
    } finally {
      existsSpy.mockRestore();
    }
  });

  test('an empty artifact name alone -> null, one warn, no fs check', async () => {
    const existsSpy = spyOn(fs, 'existsSync');
    const { h, warnSpy } = handler();
    try {
      const res = await h(req(projectRoot, [{ artifact_kind: 'skill', artifact_id: 'sk-empty', name: '' }]));
      expect(res.status).toBe(200);
      expect((res.body as { statuses: FileStatusEntry[] }).statuses).toEqual([
        { artifact_kind: 'skill', artifact_id: 'sk-empty', file_present: null },
      ]);
      expect(skillPathCalls(existsSpy)).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      existsSpy.mockRestore();
    }
  });

  test('unknown artifact kind -> null, no warn log (a routine, expected shape — not a bad entry)', async () => {
    const { h, warnSpy } = handler();
    const res = await h(req(projectRoot, [
      { artifact_kind: 'okf_page', artifact_id: 'page-1', name: 'architecture/foo' },
    ]));

    expect(res.status).toBe(200);
    expect((res.body as { statuses: FileStatusEntry[] }).statuses).toEqual([
      { artifact_kind: 'okf_page', artifact_id: 'page-1', file_present: null },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('a host-served request context -> 404, never resolves paths', async () => {
    const { h } = handler();
    const res = await h(req(projectRoot, [{ artifact_kind: 'skill', artifact_id: 'sk-1', name: 'x' }], {
      requestContext: { hostServed: true } as never,
    }));
    expect(res.status).toBe(404);
  });

  test('current project root does not match the registered root -> 409 root_mismatch with both paths', async () => {
    const movedRoot = path.join(tmp, 'moved-checkout');
    fs.mkdirSync(movedRoot, { recursive: true });
    saveProjectManifest(resolveProjectVaultDir(movedRoot), { project: { id: projectId } });

    const { h } = handler();
    const res = await h(req(movedRoot, [{ artifact_kind: 'skill', artifact_id: 'sk-1', name: 'x' }]));

    expect(res.status).toBe(409);
    const body = res.body as { error: { code: string }; registered_root: string; current_root: string };
    expect(body.error.code).toBe('root_mismatch');
    expect(body.registered_root).toBe(projectRoot);
    expect(body.current_root).toBe(path.resolve(movedRoot));
  });

  test('more than 1000 artifacts -> 413, per-artifact work never runs', async () => {
    const existsSpy = spyOn(fs, 'existsSync');
    const { h } = handler();
    try {
      const artifacts = Array.from({ length: 1001 }, (_, i) => ({
        artifact_kind: 'skill',
        artifact_id: `sk-${i}`,
        name: `skill-${i}`,
      }));
      const res = await h(req(projectRoot, artifacts));
      expect(res.status).toBe(413);
      expect((res.body as { error: { code: string } }).error.code).toBe('too_many_artifacts');
      expect(skillPathCalls(existsSpy)).toEqual([]);
    } finally {
      existsSpy.mockRestore();
    }
  });

  test('exactly 1000 artifacts stays under the cap (not 413)', async () => {
    const { h } = handler();
    const artifacts = Array.from({ length: 1000 }, (_, i) => ({
      artifact_kind: 'skill',
      artifact_id: `sk-${i}`,
      name: `skill-${i}`,
    }));
    const res = await h(req(projectRoot, artifacts));
    expect(res.status).toBe(200);
    expect((res.body as { statuses: FileStatusEntry[] }).statuses.length).toBe(1000);
  });

  test('an empty artifacts list -> {statuses: []}', async () => {
    const { h } = handler();
    const res = await h(req(projectRoot, []));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ statuses: [] });
  });
});
