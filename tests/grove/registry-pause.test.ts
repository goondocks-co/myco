import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import {
  clearGroveRegistryCaches,
  createGrove,
  forceResumeProject,
  isProjectPaused,
  pauseProject,
  registerProjectInGrove,
  resumeProject,
} from '@myco/grove/registry.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pause-'));
  clearGroveRegistryCaches();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  clearGroveRegistryCaches();
});

function readPauseFromDisk(groveId: string, projectId: string): unknown {
  const projectsPath = path.join(home, 'groves', groveId, 'registry', 'projects.toml');
  const doc = parse(fs.readFileSync(projectsPath, 'utf-8'));
  const projects = (doc as { projects?: Record<string, { paused?: unknown }> }).projects ?? {};
  return projects[projectId]?.paused;
}

describe('Grove registry pause primitive', () => {
  it('writes a paused block; isProjectPaused returns the right shape', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_aaaa',
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, 'proj_aaaa', 'grove-move', 'op-1', home);

    const status = isProjectPaused('proj_aaaa', home);
    expect(status.paused).toBe(true);
    if (!status.paused) throw new Error('unreachable');
    expect(status.reason).toBe('grove-move');
    expect(status.owner_op).toBe('op-1');
    expect(status.grove_id).toBe(grove.id);
    expect(typeof status.since).toBe('number');
    expect(status.since).toBeGreaterThan(0);

    expect(readPauseFromDisk(grove.id, 'proj_aaaa')).toBeDefined();
  });

  it('is idempotent when called twice with the same owner_op and refreshes since', async () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_aaaa',
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, 'proj_aaaa', 'grove-move', 'op-1', home);
    const first = isProjectPaused('proj_aaaa', home);
    if (!first.paused) throw new Error('expected paused');
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(() => pauseProject(grove.id, 'proj_aaaa', 'grove-move', 'op-1', home)).not.toThrow();
    const second = isProjectPaused('proj_aaaa', home);
    if (!second.paused) throw new Error('expected paused');
    expect(second.since).toBeGreaterThanOrEqual(first.since);
  });

  it('throws when re-pausing under a different owner_op', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_aaaa',
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, 'proj_aaaa', 'grove-move', 'op-1', home);
    expect(() =>
      pauseProject(grove.id, 'proj_aaaa', 'vacuum', 'op-2', home),
    ).toThrow(/op-1/);
  });

  it('throws when called for an unregistered project', () => {
    const grove = createGrove('Test', home);
    expect(() =>
      pauseProject(grove.id, 'proj_missing', 'grove-move', 'op-1', home),
    ).toThrow(/not registered/);
  });

  it('clears the block when resumeProject owner_op matches', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_aaaa',
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, 'proj_aaaa', 'grove-move', 'op-1', home);
    resumeProject(grove.id, 'proj_aaaa', 'op-1', home);

    expect(isProjectPaused('proj_aaaa', home).paused).toBe(false);
    expect(readPauseFromDisk(grove.id, 'proj_aaaa')).toBeUndefined();
  });

  it('throws on resumeProject when owner_op mismatches', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_aaaa',
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, 'proj_aaaa', 'grove-move', 'op-1', home);
    expect(() => resumeProject(grove.id, 'proj_aaaa', 'op-2', home)).toThrow(/op-1/);
  });

  it('is idempotent on resumeProject when project is not paused', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_aaaa',
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    expect(() => resumeProject(grove.id, 'proj_aaaa', 'op-1', home)).not.toThrow();
    expect(isProjectPaused('proj_aaaa', home).paused).toBe(false);
  });

  it('isProjectPaused returns { paused: false } for an unknown project_id', () => {
    createGrove('Test', home);
    expect(isProjectPaused('proj_missing', home)).toEqual({ paused: false });
  });

  it('isProjectPaused finds a paused project across multiple Groves', () => {
    const groveA = createGrove('Alpha', home);
    const groveB = createGrove('Beta', home);
    registerProjectInGrove(groveA.id, {
      projectId: 'proj_aaaa',
      projectName: 'A',
      projectRoot: '/tmp/a',
    }, home);
    registerProjectInGrove(groveB.id, {
      projectId: 'proj_bbbb',
      projectName: 'B',
      projectRoot: '/tmp/b',
    }, home);

    pauseProject(groveB.id, 'proj_bbbb', 'grove-move', 'op-2', home);

    const status = isProjectPaused('proj_bbbb', home);
    expect(status.paused).toBe(true);
    if (!status.paused) throw new Error('unreachable');
    expect(status.grove_id).toBe(groveB.id);
  });

  it('forceResumeProject clears regardless of owner_op', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_aaaa',
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, 'proj_aaaa', 'grove-move', 'op-1', home);
    expect(() =>
      forceResumeProject(grove.id, 'proj_aaaa', 'orphan-cleanup', home),
    ).not.toThrow();
    expect(isProjectPaused('proj_aaaa', home).paused).toBe(false);
  });

  it('persists across cleared mtime caches (simulated daemon restart)', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_aaaa',
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, 'proj_aaaa', 'grove-move', 'op-1', home);
    clearGroveRegistryCaches();

    const status = isProjectPaused('proj_aaaa', home);
    expect(status.paused).toBe(true);
    if (!status.paused) throw new Error('unreachable');
    expect(status.owner_op).toBe('op-1');
  });
});
