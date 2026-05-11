import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import {
  clearProjectManifestCache,
  loadProjectLocalManifest,
  loadProjectManifest,
} from '@myco/config/project-manifest.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry.js';

let tmpHome: string;
let projectRoot: string;
let vaultDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-manifest-mig-home-'));
  prevHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = tmpHome;
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-manifest-mig-proj-'));
  vaultDir = path.join(projectRoot, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  clearProjectManifestCache();
  clearGroveRegistryCaches();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
  clearProjectManifestCache();
  clearGroveRegistryCaches();
});

describe('project-manifest split migration', () => {
  it('combined-shape project.toml splits into project.toml + project.local.toml on read', () => {
    const projectId = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const bindingId = 'gbind_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    // Seed a Grove registry whose binding maps back to a known Grove + project.
    const grove = createGrove('Default', tmpHome);
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'test-project',
      projectRoot,
      bindingId,
    }, tmpHome);

    // Write the OLD combined shape on disk.
    fs.writeFileSync(path.join(vaultDir, 'project.toml'), `[project]
id = "${projectId}"
name = "test-project"

[grove]
mode = "local"
slug = "${grove.slug}"
binding_id = "${bindingId}"
`);

    // First read: triggers the split migration.
    clearProjectManifestCache();
    const manifest = loadProjectManifest(vaultDir);
    expect(manifest).not.toBeNull();
    expect(manifest?.project.id).toBe(projectId);

    // project.toml on disk now carries [grove] with id/slug/name and NOT
    // binding_id or mode.
    const tomlAfter = fs.readFileSync(path.join(vaultDir, 'project.toml'), 'utf-8');
    const parsedAfter = parse(tomlAfter) as Record<string, any>;
    expect(parsedAfter.grove).toBeDefined();
    expect(parsedAfter.grove.id).toBe(grove.id);
    expect(parsedAfter.grove.slug).toBe(grove.slug);
    expect(parsedAfter.grove.name).toBe(grove.name);
    expect(parsedAfter.grove.binding_id).toBeUndefined();
    expect(parsedAfter.grove.mode).toBeUndefined();

    // project.local.toml carries [grove_binding] with binding_id + mode.
    const local = loadProjectLocalManifest(vaultDir);
    expect(local?.grove_binding?.binding_id).toBe(bindingId);
    expect(local?.grove_binding?.mode).toBe('local');

    // Second read is a no-op (idempotent) — the file isn't rewritten.
    clearProjectManifestCache();
    loadProjectManifest(vaultDir);
    expect(fs.readFileSync(path.join(vaultDir, 'project.toml'), 'utf-8')).toBe(tomlAfter);
  });

  it('returns the strict-old-shape manifest unchanged when no registry binding can resolve it', () => {
    const projectId = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const bindingId = 'gbind_dddddddddddddddddddddddddddddddd';

    fs.writeFileSync(path.join(vaultDir, 'project.toml'), `[project]
id = "${projectId}"
name = "orphan"

[grove]
mode = "local"
slug = "default"
binding_id = "${bindingId}"
`);

    clearProjectManifestCache();
    const manifest = loadProjectManifest(vaultDir);
    expect(manifest?.project.id).toBe(projectId);

    // No project.local.toml was written — migration was skipped.
    expect(fs.existsSync(path.join(vaultDir, 'project.local.toml'))).toBe(false);
    // project.toml still carries the legacy fields.
    const parsed = parse(fs.readFileSync(path.join(vaultDir, 'project.toml'), 'utf-8')) as Record<string, any>;
    expect(parsed.grove.binding_id).toBe(bindingId);
    expect(parsed.grove.mode).toBe('local');
  });
});
