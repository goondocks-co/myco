import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Home-scoping for `runAllProjects`: the MYCO_HOME is the ownership boundary.
 * Every Grove registered under the home belongs to this daemon, so
 * `listGroves(undefined)` (home-scoped) returns them all. The raw TOML fixtures
 * below include a legacy `served_by` key that is ignored on read — it no longer
 * affects ownership or filtering.
 */

let tmpHome: string;
let originalHome: string | undefined;

function writeRegistry(defaultGroveId: string): void {
  fs.mkdirSync(path.join(tmpHome, 'groves'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, 'groves', 'registry.yaml'), `default_grove_id: ${defaultGroveId}\n`);
}

function writeGrove(groveId: string, slug: string, name: string): void {
  const dir = path.join(tmpHome, 'groves', groveId);
  fs.mkdirSync(path.join(dir, 'registry'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'grove.toml'),
    `[grove]\nid = "${groveId}"\nname = "${name}"\nslug = "${slug}"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00.000Z"\nserved_by = "service"\n`,
  );
}

function writeProject(groveId: string, projectId: string, projectName: string, root: string): void {
  const projectsPath = path.join(tmpHome, 'groves', groveId, 'registry', 'projects.toml');
  const existing = fs.existsSync(projectsPath) ? fs.readFileSync(projectsPath, 'utf-8') : '';
  fs.writeFileSync(
    projectsPath,
    `${existing}[projects.${projectId}]\nproject_id = "${projectId}"\nname = "${projectName}"\nroot = "${root}"\nbinding_id = "gbind_${projectId}"\ncreated_at = "2026-01-01T00:00:00.000Z"\nupdated_at = "2026-01-01T00:00:00.000Z"\n\n`,
  );
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-grove-'));
  originalHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('runAllProjects home scoping', () => {
  test('home-scoped listGroves returns every Grove + project under the home', async () => {
    const groveA = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const groveB = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    writeRegistry(groveA);
    writeGrove(groveA, 'app', 'App');
    writeGrove(groveB, 'lib', 'Lib');
    writeProject(groveA, 'proj_app', 'app', '/nonexistent/app');
    writeProject(groveB, 'proj_lib', 'lib', '/nonexistent/lib');

    const { listGroves, listRegisteredProjects } = await import('../../packages/myco/src/grove/registry');

    const groves = listGroves(undefined);
    const projects = groves.flatMap((g) => listRegisteredProjects(g.id));

    expect(groves.map((g) => g.id).sort()).toEqual([groveA, groveB].sort());
    expect(projects.map((p) => p.name).sort()).toEqual(['app', 'lib']);
  });

  test('a fresh home with no Groves yields nothing', async () => {
    writeRegistry('grove_cccccccccccccccccccccccccccccccc');
    const { listGroves } = await import('../../packages/myco/src/grove/registry');
    expect(listGroves(undefined)).toEqual([]);
  });
});
