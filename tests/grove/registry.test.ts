import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import {
  createGrove,
  ensureDefaultGrove,
  getDefaultGroveId,
  listGroves,
  registerProjectInGrove,
  resolveGrove,
  setDefaultGrove,
} from '@myco/grove/registry.js';

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
});
