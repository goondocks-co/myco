import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import {
  ensureProjectManifest,
  loadProjectManifest,
  parseProjectManifest,
  saveProjectManifest,
} from '@myco/config/project-manifest.js';

let vaultDir: string;

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-project-manifest-'));
});

afterEach(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

describe('project.toml manifest', () => {
  it('parses project identity and Grove binding metadata', () => {
    const manifest = parseProjectManifest(`
[project]
id = "proj_1"
name = "myco"

[grove]
binding_id = "gbind_1"
slug = "work"
mode = "local"
`);

    expect(manifest.project.id).toBe('proj_1');
    expect(manifest.grove?.binding_id).toBe('gbind_1');
  });

  it('writes project.toml and preserves unknown future-safe fields', () => {
    fs.writeFileSync(path.join(vaultDir, 'project.toml'), `
[project]
id = "proj_old"
custom = "keep"
`);

    saveProjectManifest(vaultDir, {
      project: { id: 'proj_new', name: 'myco' },
      grove: { binding_id: 'gbind_1', slug: 'work', mode: 'local' },
    });

    const raw = parse(fs.readFileSync(path.join(vaultDir, 'project.toml'), 'utf-8')) as Record<string, any>;
    expect(raw.project.id).toBe('proj_new');
    expect(raw.project.custom).toBe('keep');
    expect(raw.grove.binding_id).toBe('gbind_1');
  });

  it('ensures a new manifest with generated project and binding ids', () => {
    const manifest = ensureProjectManifest(vaultDir, {
      projectName: 'myco',
      groveSlug: 'work',
    });

    expect(manifest.project.id).toStartWith('proj_');
    expect(manifest.grove?.binding_id).toStartWith('gbind_');
    expect(loadProjectManifest(vaultDir)?.project.id).toBe(manifest.project.id);
  });

  it('adds Grove binding metadata to an existing project-only manifest', () => {
    saveProjectManifest(vaultDir, {
      project: { id: 'proj_1', name: 'myco' },
    });

    const manifest = ensureProjectManifest(vaultDir, {
      projectName: 'myco',
      groveSlug: 'work',
    });

    expect(manifest.project.id).toBe('proj_1');
    expect(manifest.grove?.binding_id).toStartWith('gbind_');
    expect(manifest.grove?.slug).toBe('work');
  });

  it('rejects secret-like fields', () => {
    expect(() => saveProjectManifest(vaultDir, {
      project: { id: 'proj_1', name: 'myco' },
      grove: {
        binding_id: 'gbind_1',
        slug: 'work',
        mode: 'local',
        remote: { provider: 'cloudflare-d1', remote_id: 'r1' },
      },
      token: 'nope',
    } as any)).toThrow(/secret-like field/);
  });
});
