import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import YAML from 'yaml';
import {
  clearGroveRegistryCaches,
  archiveProjectInGrove,
  createGrove,
  DefaultGroveUndeletableError,
  deleteGrove,
  deregisterProjectInGrove,
  ensureDefaultGrove,
  ensureGroveExistsLocally,
  ensureProjectRegistered,
  getDefaultGroveId,
  LastGroveUndeletableError,
  listGroves,
  listRegisteredProjects,
  loadGroveRecord,
  registerProjectInGrove,
  renameGrove,
  resolveAttachRefHomeGroveId,
  resolveGrove,
  setDefaultGrove,
  unarchiveProjectInGrove,
} from '@myco/grove/registry.js';
import { createGroveId } from '@myco/grove/ids.js';
import type { AttachRef } from '@myco/host/registry.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-grove-registry-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('Grove registry', () => {
  it('creates a default Grove and records it in global config', () => {
    const grove = ensureDefaultGrove(home);

    expect(grove.name).toBe('default');
    expect(grove.slug).toBe('default');
    expect(getDefaultGroveId(home)).toBe(grove.id);
    expect(listGroves(home)).toHaveLength(1);
  });

  it('creates named Groves and resolves them by slug or id', () => {
    const grove = createGrove('Client Work', home);

    expect(resolveGrove('client-work', home).id).toBe(grove.id);
    expect(resolveGrove(grove.id, home).slug).toBe('client-work');
  });

  it('sets the default Grove by name', () => {
    createGrove('Research', home);
    const selected = setDefaultGrove('research', home);

    expect(getDefaultGroveId(home)).toBe(selected.id);
  });

  it('writes default_grove_id to groves/registry.yaml (not config.yaml)', () => {
    const grove = createGrove('Research', home);
    setDefaultGrove(grove.id, home);

    const registry = YAML.parse(fs.readFileSync(path.join(home, 'groves', 'registry.yaml'), 'utf-8'));
    expect(registry.default_grove_id).toBe(grove.id);

    // Machine-tier config.yaml must NOT carry the registry block.
    const configPath = path.join(home, 'config.yaml');
    if (fs.existsSync(configPath)) {
      const config = YAML.parse(fs.readFileSync(configPath, 'utf-8')) ?? {};
      expect(config.grove).toBeUndefined();
    }
  });

  it('migrates legacy ~/.myco/config.yaml { grove.default_grove_id } into registry.yaml on first read', () => {
    // Seed the legacy layout: a grove dir + a config.yaml with the
    // pre-Q-F1 registry block, no registry.yaml yet.
    const grove = createGrove('Legacy Grove', home);
    clearGroveRegistryCaches();
    fs.rmSync(path.join(home, 'groves', 'registry.yaml'), { force: true });
    fs.writeFileSync(
      path.join(home, 'config.yaml'),
      YAML.stringify({ daemon: { port: 9999 }, grove: { default_grove_id: grove.id } }),
      'utf-8',
    );
    clearGroveRegistryCaches();

    // First read should surface the legacy value AND auto-migrate it.
    expect(getDefaultGroveId(home)).toBe(grove.id);

    const registry = YAML.parse(fs.readFileSync(path.join(home, 'groves', 'registry.yaml'), 'utf-8'));
    expect(registry.default_grove_id).toBe(grove.id);
  });

  it('registers projects in Grove-local project and root registries', () => {
    const grove = createGrove('Work', home);
    const project = registerProjectInGrove(grove.id, {
      projectId: 'proj_1',
      projectName: 'myco',
      projectRoot: '/tmp/myco',
      bindingId: 'gbind_1',
    }, home);

    expect(project.root).toBe('/tmp/myco');

    const projects = parse(fs.readFileSync(path.join(home, 'groves', grove.id, 'registry', 'projects.toml'), 'utf-8')) as Record<string, any>;
    const roots = parse(fs.readFileSync(path.join(home, 'groves', grove.id, 'registry', 'roots.toml'), 'utf-8')) as Record<string, any>;

    expect(projects.projects.proj_1.binding_id).toBe('gbind_1');
    expect(roots.roots['/tmp/myco']).toBe('proj_1');
  });

  describe('ensureGroveExistsLocally', () => {
    it('returns the existing record without touching disk when already registered', () => {
      const created = createGrove('Already Here', home);
      const metadataPath = path.join(home, 'groves', created.id, 'grove.toml');
      const beforeStat = fs.statSync(metadataPath);

      const result = ensureGroveExistsLocally(created.id, { name: 'Other Name', slug: 'other-slug' }, home);

      expect(result.id).toBe(created.id);
      expect(result.name).toBe(created.name);
      expect(result.slug).toBe(created.slug);
      const afterStat = fs.statSync(metadataPath);
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    });

    it('lazy-provisions a Grove with the supplied id when none exists locally', () => {
      const portableId = createGroveId();

      const result = ensureGroveExistsLocally(portableId, { name: 'Imported Grove', slug: 'imported-grove' }, home);

      expect(result.id).toBe(portableId);
      expect(result.name).toBe('Imported Grove');
      expect(result.slug).toBe('imported-grove');
      expect(loadGroveRecord(portableId, home)?.id).toBe(portableId);
      expect(fs.existsSync(path.join(home, 'groves', portableId, 'grove.toml'))).toBe(true);
    });

    it('suffixes the slug when it collides with a different existing Grove', () => {
      createGrove('Work', home);
      const portableId = createGroveId();

      const result = ensureGroveExistsLocally(portableId, { name: 'Work', slug: 'work' }, home);

      expect(result.id).toBe(portableId);
      expect(result.slug).toBe('work-2');
    });
  });

  describe('deregisterProjectInGrove', () => {
    it('removes the project entry and root pointer', () => {
      const grove = createGrove('Work', home);
      registerProjectInGrove(grove.id, {
        projectId: 'proj_demo',
        projectName: 'Demo',
        projectRoot: '/tmp/demo',
        bindingId: 'gbind_demo',
      }, home);

      expect(listRegisteredProjects(grove.id, home).map((p) => p.project_id)).toContain('proj_demo');

      deregisterProjectInGrove(grove.id, 'proj_demo', home);

      expect(listRegisteredProjects(grove.id, home).map((p) => p.project_id)).not.toContain('proj_demo');

      const rootsRaw = fs.readFileSync(path.join(home, 'groves', grove.id, 'registry', 'roots.toml'), 'utf-8');
      expect(rootsRaw).not.toContain('/tmp/demo');
    });

    it('throws when the project is not bound to that Grove', () => {
      const grove = createGrove('Work', home);

      expect(() => deregisterProjectInGrove(grove.id, 'proj_missing', home)).toThrow(/not registered/);
    });

    it('with force: true is a no-op when the project is already missing', () => {
      const grove = createGrove('Work', home);

      // Move-orchestrator resume path: the project was already deregistered
      // on a prior partial commit; force makes the second attempt a no-op
      // instead of throwing and breaking resumability.
      expect(() =>
        deregisterProjectInGrove(grove.id, 'proj_missing', home, { force: true }),
      ).not.toThrow();
    });

    it('reflects deregistration in listRegisteredProjects without manual cache clear', () => {
      const grove = createGrove('Work', home);
      registerProjectInGrove(grove.id, {
        projectId: 'proj_a',
        projectName: 'A',
        projectRoot: '/tmp/a',
      }, home);
      registerProjectInGrove(grove.id, {
        projectId: 'proj_b',
        projectName: 'B',
        projectRoot: '/tmp/b',
      }, home);

      expect(listRegisteredProjects(grove.id, home)).toHaveLength(2);
      deregisterProjectInGrove(grove.id, 'proj_a', home);
      expect(listRegisteredProjects(grove.id, home).map((p) => p.project_id)).toEqual(['proj_b']);
    });
  });

  describe('project archive lifecycle', () => {
    it('hides archived projects by default and can list them explicitly', () => {
      const grove = createGrove('Work', home);
      registerProjectInGrove(grove.id, {
        projectId: 'proj_demo',
        projectName: 'Demo',
        projectRoot: '/tmp/demo',
        bindingId: 'gbind_demo',
      }, home);

      archiveProjectInGrove(grove.id, 'proj_demo', home);

      expect(listRegisteredProjects(grove.id, home)).toEqual([]);
      const archived = listRegisteredProjects(grove.id, home, { includeArchived: true });
      expect(archived).toHaveLength(1);
      expect(archived[0]!.status).toBe('archived');
      expect(typeof archived[0]!.archived_at).toBe('string');

      unarchiveProjectInGrove(grove.id, 'proj_demo', home);
      expect(listRegisteredProjects(grove.id, home).map((p) => p.project_id)).toEqual(['proj_demo']);
    });

    it('does not silently reactivate an archived project on auto-registration', () => {
      const grove = createGrove('Work', home);
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-archived-root-'));
      fs.mkdirSync(path.join(projectRoot, '.git'));
      registerProjectInGrove(grove.id, {
        projectId: 'proj_demo',
        projectName: 'Demo',
        projectRoot,
        bindingId: 'gbind_demo',
      }, home);
      archiveProjectInGrove(grove.id, 'proj_demo', home);

      const registered = ensureProjectRegistered(projectRoot, home);

      expect(registered).toBeNull();
      expect(listRegisteredProjects(grove.id, home)).toEqual([]);
      expect(listRegisteredProjects(grove.id, home, { includeArchived: true })[0]!.status).toBe('archived');
      fs.rmSync(projectRoot, { recursive: true, force: true });
    });
  });

  describe('renameGrove', () => {
    it('updates the name only when the slug is unchanged', () => {
      const grove = createGrove('My Project', home);

      const renamed = renameGrove(grove.id, 'My Project!!', home);

      expect(renamed.id).toBe(grove.id);
      expect(renamed.name).toBe('My Project!!');
      expect(renamed.slug).toBe('my-project');
      expect(loadGroveRecord(grove.id, home)?.name).toBe('My Project!!');
      expect(fs.existsSync(path.join(home, 'groves', grove.id, 'grove.toml'))).toBe(true);
    });

    it('updates the slug; loadGroveRecord still resolves by id', () => {
      const grove = createGrove('Original Name', home);

      const renamed = renameGrove(grove.id, 'Renamed Project', home);

      expect(renamed.slug).toBe('renamed-project');
      expect(loadGroveRecord(grove.id, home)?.slug).toBe('renamed-project');
      expect(loadGroveRecord(grove.id, home)?.name).toBe('Renamed Project');
    });

    it('auto-suffixes when the new slug collides with another Grove', () => {
      createGrove('Existing', home);
      const grove = createGrove('Other', home);

      const renamed = renameGrove(grove.id, 'Existing', home);

      expect(renamed.slug).toBe('existing-2');
      expect(renamed.name).toBe('Existing');
    });

    it('throws when the Grove id does not exist', () => {
      expect(() => renameGrove(createGroveId(), 'Anything', home)).toThrow(/Unknown Grove/);
    });
  });

  describe('deleteGrove', () => {
    it('refuses to delete a Grove with bound projects unless force is set', () => {
      // A second Grove keeps `grove` non-default and non-last so this
      // test isolates the bound-projects guard.
      createGrove('Other', home);
      const grove = createGrove('Work', home);
      registerProjectInGrove(grove.id, {
        projectId: 'proj_demo',
        projectName: 'Demo',
        projectRoot: '/tmp/demo',
      }, home);

      expect(() => deleteGrove(grove.id, {}, home)).toThrow(/bound project/);
      expect(loadGroveRecord(grove.id, home)).not.toBeNull();
    });

    it('deletes a Grove when force is true even with bound projects', () => {
      createGrove('Other', home);
      const grove = createGrove('Work', home);
      registerProjectInGrove(grove.id, {
        projectId: 'proj_demo',
        projectName: 'Demo',
        projectRoot: '/tmp/demo',
      }, home);

      deleteGrove(grove.id, { force: true }, home);

      expect(loadGroveRecord(grove.id, home)).toBeNull();
      expect(listGroves(home).find((g) => g.id === grove.id)).toBeUndefined();
      expect(fs.existsSync(path.join(home, 'groves', grove.id))).toBe(false);
    });

    it('removes the on-disk Grove directory', () => {
      createGrove('Other', home);
      const grove = createGrove('Lonely', home);
      const groveDir = path.join(home, 'groves', grove.id);
      expect(fs.existsSync(groveDir)).toBe(true);

      deleteGrove(grove.id, {}, home);

      expect(fs.existsSync(groveDir)).toBe(false);
    });

    it('refuses to delete the default Grove with a typed error', () => {
      const a = createGrove('Alpha', home);
      createGrove('Beta', home);
      expect(getDefaultGroveId(home)).toBe(a.id);

      expect(() => deleteGrove(a.id, {}, home)).toThrow(DefaultGroveUndeletableError);
      expect(loadGroveRecord(a.id, home)).not.toBeNull();
    });

    it('force does not bypass the default-Grove refusal', () => {
      const a = createGrove('Alpha', home);
      createGrove('Beta', home);
      expect(getDefaultGroveId(home)).toBe(a.id);

      expect(() => deleteGrove(a.id, { force: true }, home)).toThrow(DefaultGroveUndeletableError);
      expect(loadGroveRecord(a.id, home)).not.toBeNull();
    });

    it('refuses to delete the last remaining Grove (surfaces as the default-Grove refusal since the sole Grove is always default)', () => {
      const grove = createGrove('Solo', home);
      expect(listGroves(home)).toHaveLength(1);

      expect(() => deleteGrove(grove.id, {}, home)).toThrow(DefaultGroveUndeletableError);
      expect(loadGroveRecord(grove.id, home)).not.toBeNull();
    });

    it('refuses to delete the last remaining Grove with LastGroveUndeletableError when the default pointer is stale/unset', () => {
      const grove = createGrove('Solo', home);
      // Simulate a stale/unset default pointer independent of the
      // single-Grove state — the last-Grove guard must not rely on the
      // pointer being correct.
      const doc = YAML.parse(fs.readFileSync(path.join(home, 'groves', 'registry.yaml'), 'utf-8')) ?? {};
      delete doc.default_grove_id;
      fs.writeFileSync(path.join(home, 'groves', 'registry.yaml'), YAML.stringify(doc), 'utf-8');
      clearGroveRegistryCaches();
      expect(getDefaultGroveId(home)).toBeNull();

      expect(() => deleteGrove(grove.id, {}, home)).toThrow(LastGroveUndeletableError);
      expect(loadGroveRecord(grove.id, home)).not.toBeNull();
    });

    it('force does not bypass the last-Grove refusal even with a stale/unset default pointer', () => {
      const grove = createGrove('Solo', home);
      const doc = YAML.parse(fs.readFileSync(path.join(home, 'groves', 'registry.yaml'), 'utf-8')) ?? {};
      delete doc.default_grove_id;
      fs.writeFileSync(path.join(home, 'groves', 'registry.yaml'), YAML.stringify(doc), 'utf-8');
      clearGroveRegistryCaches();

      expect(() => deleteGrove(grove.id, { force: true }, home)).toThrow(LastGroveUndeletableError);
      expect(loadGroveRecord(grove.id, home)).not.toBeNull();
    });

    it('allows deleting a Grove after the default is reassigned elsewhere', () => {
      const a = createGrove('Alpha', home);
      const b = createGrove('Beta', home);
      expect(getDefaultGroveId(home)).toBe(a.id);

      setDefaultGrove(b.id, home);
      expect(getDefaultGroveId(home)).toBe(b.id);

      deleteGrove(a.id, {}, home);

      expect(loadGroveRecord(a.id, home)).toBeNull();
      expect(getDefaultGroveId(home)).toBe(b.id);
    });
  });

  describe('resolveAttachRefHomeGroveId (E-4 local-view requirement — read-time resolution)', () => {
    function ref(localGroveId?: string): Pick<AttachRef, 'local_grove_id'> {
      return { local_grove_id: localGroveId };
    }

    it('a ref with no local_grove_id (legacy/absent) resolves to the current default Grove', () => {
      const defaultGrove = createGrove('Default', home);

      expect(resolveAttachRefHomeGroveId(ref(undefined), home)).toBe(defaultGrove.id);
    });

    it('a dangling local_grove_id (the chosen Grove was deleted after attach) falls back to the current default Grove', () => {
      const defaultGrove = createGrove('Default', home);
      const deleted = createGrove('Gone', home);
      deleteGrove(deleted.id, {}, home);

      expect(resolveAttachRefHomeGroveId(ref(deleted.id), home)).toBe(defaultGrove.id);
    });

    it('a valid local_grove_id resolves to itself, even when it is not the default Grove', () => {
      createGrove('Default', home);
      const other = createGrove('Other', home);

      expect(resolveAttachRefHomeGroveId(ref(other.id), home)).toBe(other.id);
    });

    it('resolves to null (never creates a Grove) when the machine has no Groves at all yet — dangling or absent alike', () => {
      expect(listGroves(home)).toEqual([]);

      expect(resolveAttachRefHomeGroveId(ref(undefined), home)).toBeNull();
      expect(resolveAttachRefHomeGroveId(ref(createGroveId()), home)).toBeNull();

      // Pure read: no Grove was minted as a side effect of resolving, in
      // either case — the empty registry is exactly as empty as it started.
      expect(listGroves(home)).toEqual([]);
      expect(fs.existsSync(path.join(home, 'groves'))).toBe(false);
    });
  });
});
