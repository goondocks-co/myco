import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Smoke test for the variant-filtering logic in runAllProjects.
 * Mocks a registry with one Grove served_by=service and one served_by=service-dev,
 * each with a project. Asserts the helper produces the right target list per variant.
 */

let tmpHome: string;
let originalHome: string | undefined;
let originalVariant: string | undefined;

function writeRegistry(defaultGroveId: string): void {
  fs.mkdirSync(path.join(tmpHome, 'groves'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, 'groves', 'registry.yaml'), `default_grove_id: ${defaultGroveId}\n`);
}

function writeGrove(groveId: string, slug: string, name: string, servedBy: 'service' | 'service-dev'): void {
  const dir = path.join(tmpHome, 'groves', groveId);
  fs.mkdirSync(path.join(dir, 'registry'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'grove.toml'),
    `[grove]\nid = "${groveId}"\nname = "${name}"\nslug = "${slug}"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00.000Z"\nserved_by = "${servedBy}"\n`,
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
  originalVariant = process.env.MYCO_SERVICE_VARIANT;
  process.env.MYCO_HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = originalHome;
  if (originalVariant === undefined) delete process.env.MYCO_SERVICE_VARIANT;
  else process.env.MYCO_SERVICE_VARIANT = originalVariant;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('runAllProjects Grove ownership filter', () => {
  test('prod variant sees only Groves served_by service', async () => {
    const prodGrove = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const devGrove = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    writeRegistry(prodGrove);
    writeGrove(prodGrove, 'prod', 'Production', 'service');
    writeGrove(devGrove, 'dev', 'Dogfood', 'service-dev');
    writeProject(prodGrove, 'proj_prod', 'prod-app', '/nonexistent/prod-app');
    writeProject(devGrove, 'proj_dev', 'dev-app', '/nonexistent/dev-app');

    const { listGroves, listRegisteredProjects } = await import('../../packages/myco/src/grove/registry');
    const { serviceVariantToDirName } = await import('../../packages/myco/src/service/labels');
    const { isDevServiceMode, setDevServiceMode } = await import('../../packages/myco/src/grove/paths');

    // Ensure prod mode
    setDevServiceMode(false);
    try {
      const variantProd = isDevServiceMode() ? 'dev' : 'prod';
      const prodGroves = listGroves(undefined, { servedBy: serviceVariantToDirName(variantProd) });
      const prodProjects = prodGroves.flatMap((g) => listRegisteredProjects(g.id));

      expect(prodGroves.map((g) => g.id)).toEqual([prodGrove]);
      expect(prodProjects.map((p) => p.name)).toEqual(['prod-app']);
    } finally {
      setDevServiceMode(false);
    }
  });

  test('dev variant sees only Groves served_by service-dev', async () => {
    const prodGrove = 'grove_cccccccccccccccccccccccccccccccc';
    const devGrove = 'grove_dddddddddddddddddddddddddddddddd';
    writeRegistry(prodGrove);
    writeGrove(prodGrove, 'prod', 'Production', 'service');
    writeGrove(devGrove, 'dev', 'Dogfood', 'service-dev');
    writeProject(prodGrove, 'proj_prod2', 'prod-app', '/nonexistent/prod-app');
    writeProject(devGrove, 'proj_dev2', 'dev-app', '/nonexistent/dev-app');

    const { listGroves, listRegisteredProjects } = await import('../../packages/myco/src/grove/registry');
    const { serviceVariantToDirName } = await import('../../packages/myco/src/service/labels');
    const { setDevServiceMode, isDevServiceMode } = await import('../../packages/myco/src/grove/paths');

    setDevServiceMode(true);
    try {
      const variantDev = isDevServiceMode() ? 'dev' : 'prod';
      const devGroves = listGroves(undefined, { servedBy: serviceVariantToDirName(variantDev) });
      const devProjects = devGroves.flatMap((g) => listRegisteredProjects(g.id));

      expect(devGroves.map((g) => g.id)).toEqual([devGrove]);
      expect(devProjects.map((p) => p.name)).toEqual(['dev-app']);
    } finally {
      setDevServiceMode(false);
    }
  });
});
