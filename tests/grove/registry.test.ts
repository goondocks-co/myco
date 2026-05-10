import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import YAML from 'yaml';
import {
  clearGroveRegistryCaches,
  createGrove,
  ensureDefaultGrove,
  ensureGroveExistsLocally,
  getDefaultGroveId,
  listGroves,
  loadGroveRecord,
  registerProjectInGrove,
  resolveGrove,
  setDefaultGrove,
} from '@myco/grove/registry.js';
import { createGroveId } from '@myco/grove/ids.js';

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
});
