import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import {
  resolveGroveDbPath,
  resolveGroveDir,
  resolveGroveProjectsPath,
  resolveGroveRootsPath,
  resolveMycoHome,
  resolveProjectManifestPath,
  resolveProjectVaultDir,
} from '@myco/grove/paths.js';

describe('Grove path primitives', () => {
  it('resolves the global Myco home from MYCO_HOME when provided', () => {
    const home = resolveMycoHome({
      env: { MYCO_HOME: '~/custom-myco' } as NodeJS.ProcessEnv,
      homeDir: '/Users/tester',
    });

    expect(home).toBe(path.join('/Users/tester', 'custom-myco'));
  });

  it('resolves Grove-local data paths under the global home', () => {
    const home = '/tmp/myco-home';

    expect(resolveGroveDir('grove_1', home)).toBe('/tmp/myco-home/groves/grove_1');
    expect(resolveGroveDbPath('grove_1', home)).toBe('/tmp/myco-home/groves/grove_1/myco.db');
    expect(resolveGroveProjectsPath('grove_1', home)).toBe('/tmp/myco-home/groves/grove_1/registry/projects.toml');
    expect(resolveGroveRootsPath('grove_1', home)).toBe('/tmp/myco-home/groves/grove_1/registry/roots.toml');
  });

  it('keeps project-local manifest paths thin and project rooted', () => {
    const vaultDir = resolveProjectVaultDir('/tmp/project');

    expect(vaultDir).toBe('/tmp/project/.myco');
    expect(resolveProjectManifestPath(vaultDir)).toBe('/tmp/project/.myco/project.toml');
  });
});
