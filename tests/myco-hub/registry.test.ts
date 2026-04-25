import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpHome: string;

describe('myco-hub project registry', () => {
  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hub-home-'));
    process.env.HOME = tmpHome;
    process.env.MYCO_HUB_DIR = path.join(tmpHome, '.myco', 'hub');
  });

  beforeEach(() => {
    fs.rmSync(path.join(tmpHome, '.myco'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, 'Repos'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpHome, 'gone'), { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.HOME;
    delete process.env.MYCO_HUB_DIR;
  });

  it('upserts project daemon registrations into the last-seen cache', async () => {
    const { upsertProjectRegistration, listKnownProjects } = await import('@myco-hub/registry.js');
    const projectRoot = path.join(tmpHome, 'Repos', 'example');
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n', 'utf-8');
    fs.writeFileSync(path.join(vaultDir, 'runtime.command'), '/tmp/myco-dev\n', 'utf-8');

    const first = upsertProjectRegistration({
      name: 'example',
      projectRoot,
      vaultDir,
      machineId: 'chris_12345678',
      port: 21039,
      pid: 123,
      version: '0.22.3',
      startedAt: '2026-04-24T00:00:00.000Z',
      runtimeCommand: '/tmp/myco-dev',
    });
    const second = upsertProjectRegistration({
      name: 'example',
      projectRoot,
      vaultDir,
      machineId: 'chris_12345678',
      port: 21040,
      pid: 124,
      version: '0.22.4',
      startedAt: '2026-04-24T00:01:00.000Z',
      runtimeCommand: '/tmp/myco-dev',
    });

    expect(second.id).toBe(first.id);
    const projects = listKnownProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.preferredPort).toBe(21040);
    expect(projects[0]?.runtimeCommand).toBe('/tmp/myco-dev');
    expect(projects[0]?.source).toBe('registration');
  });

  it('does not list stale cache entries after the vault is gone', async () => {
    const { upsertProjectRegistration, listKnownProjects } = await import('@myco-hub/registry.js');
    const projectRoot = path.join(tmpHome, 'gone');
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n', 'utf-8');

    upsertProjectRegistration({
      projectRoot,
      vaultDir,
      machineId: 'local_abc',
    });
    expect(listKnownProjects()).toHaveLength(1);

    fs.rmSync(vaultDir, { recursive: true, force: true });
    expect(listKnownProjects()).toEqual([]);
  });

  it('removes a known project from the hub cache without deleting its vault', async () => {
    const { upsertProjectRegistration, listKnownProjects, removeKnownProject } = await import('@myco-hub/registry.js');
    const projectRoot = path.join(tmpHome, 'Repos', 'smoke');
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n', 'utf-8');

    const project = upsertProjectRegistration({
      name: 'smoke',
      projectRoot,
      vaultDir,
      machineId: 'local_abc',
    });

    expect(removeKnownProject(project.id)).toBe(true);
    expect(listKnownProjects()).toEqual([]);
    expect(fs.existsSync(path.join(vaultDir, 'myco.yaml'))).toBe(true);
    expect(removeKnownProject(project.id)).toBe(false);
  });
});
