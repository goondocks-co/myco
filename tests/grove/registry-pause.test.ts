import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearGroveRegistryCaches,
  createGrove,
  forceResumeProject,
  isProjectPaused,
  pauseProject,
  registerProjectInGrove,
  resumeProject,
} from '@myco/grove/registry.js';
import { createProjectId } from '@myco/grove/ids.js';
import { readProjectLease } from '@myco/grove/project-lease.js';

let home: string;
let PROJECT_A: string;
let PROJECT_B: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pause-'));
  PROJECT_A = createProjectId();
  PROJECT_B = createProjectId();
  clearGroveRegistryCaches();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  clearGroveRegistryCaches();
});

/**
 * The pause is stored as a project lease under `<home>/leases/`, not in the
 * Grove's projects.toml row — that relocation is what lets it survive the
 * deregistration a move or a residency transition performs partway through.
 */
function readPauseFromDisk(_groveId: string, projectId: string): unknown {
  const lease = readProjectLease(projectId, home);
  return lease.state === 'present' ? lease.value : undefined;
}

describe('Grove registry pause primitive', () => {
  it('writes a paused block; isProjectPaused returns the right shape', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: PROJECT_A,
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, PROJECT_A, 'grove-move', 'op-1', home);

    const status = isProjectPaused(PROJECT_A, home);
    expect(status.paused).toBe(true);
    if (!status.paused) throw new Error('unreachable');
    expect(status.reason).toBe('grove-move');
    expect(status.owner_op).toBe('op-1');
    expect(status.grove_id).toBe(grove.id);
    expect(typeof status.since).toBe('number');
    expect(status.since).toBeGreaterThan(0);

    expect(readPauseFromDisk(grove.id, PROJECT_A)).toBeDefined();
  });

  it('is idempotent when called twice with the same owner_op and refreshes since', async () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: PROJECT_A,
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, PROJECT_A, 'grove-move', 'op-1', home);
    const first = isProjectPaused(PROJECT_A, home);
    if (!first.paused) throw new Error('expected paused');
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(() => pauseProject(grove.id, PROJECT_A, 'grove-move', 'op-1', home)).not.toThrow();
    const second = isProjectPaused(PROJECT_A, home);
    if (!second.paused) throw new Error('expected paused');
    expect(second.since).toBeGreaterThanOrEqual(first.since);
  });

  it('throws when re-pausing under a different owner_op', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: PROJECT_A,
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, PROJECT_A, 'grove-move', 'op-1', home);
    expect(() =>
      pauseProject(grove.id, PROJECT_A, 'vacuum', 'op-2', home),
    ).toThrow(/op-1/);
  });

  it('throws when called for an unregistered project', () => {
    const grove = createGrove('Test', home);
    expect(() =>
      pauseProject(grove.id, createProjectId(), 'grove-move', 'op-1', home),
    ).toThrow(/not registered/);
  });

  it('clears the block when resumeProject owner_op matches', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: PROJECT_A,
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, PROJECT_A, 'grove-move', 'op-1', home);
    resumeProject(grove.id, PROJECT_A, 'op-1', home);

    expect(isProjectPaused(PROJECT_A, home).paused).toBe(false);
    expect(readPauseFromDisk(grove.id, PROJECT_A)).toBeUndefined();
  });

  it('throws on resumeProject when owner_op mismatches', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: PROJECT_A,
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, PROJECT_A, 'grove-move', 'op-1', home);
    expect(() => resumeProject(grove.id, PROJECT_A, 'op-2', home)).toThrow(/op-1/);
  });

  it('is idempotent on resumeProject when project is not paused', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: PROJECT_A,
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    expect(() => resumeProject(grove.id, PROJECT_A, 'op-1', home)).not.toThrow();
    expect(isProjectPaused(PROJECT_A, home).paused).toBe(false);
  });

  it('isProjectPaused returns { paused: false } for an unknown project_id', () => {
    createGrove('Test', home);
    expect(isProjectPaused('proj_missing', home)).toEqual({ paused: false });
  });

  it('isProjectPaused finds a paused project across multiple Groves', () => {
    const groveA = createGrove('Alpha', home);
    const groveB = createGrove('Beta', home);
    registerProjectInGrove(groveA.id, {
      projectId: PROJECT_A,
      projectName: 'A',
      projectRoot: '/tmp/a',
    }, home);
    registerProjectInGrove(groveB.id, {
      projectId: PROJECT_B,
      projectName: 'B',
      projectRoot: '/tmp/b',
    }, home);

    pauseProject(groveB.id, PROJECT_B, 'grove-move', 'op-2', home);

    const status = isProjectPaused(PROJECT_B, home);
    expect(status.paused).toBe(true);
    if (!status.paused) throw new Error('unreachable');
    expect(status.grove_id).toBe(groveB.id);
  });

  it('forceResumeProject clears regardless of owner_op', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: PROJECT_A,
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, PROJECT_A, 'grove-move', 'op-1', home);
    expect(() =>
      forceResumeProject(grove.id, PROJECT_A, home),
    ).not.toThrow();
    expect(isProjectPaused(PROJECT_A, home).paused).toBe(false);
  });

  it('persists across cleared mtime caches (simulated daemon restart)', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: PROJECT_A,
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(grove.id, PROJECT_A, 'grove-move', 'op-1', home);
    clearGroveRegistryCaches();

    const status = isProjectPaused(PROJECT_A, home);
    expect(status.paused).toBe(true);
    if (!status.paused) throw new Error('unreachable');
    expect(status.owner_op).toBe('op-1');
  });

  it('reports paused no matter which Grove registers the project (mid-move window)', () => {
    // This used to guard against first-hit masking: the pause lived in one
    // Grove's row, so isProjectPaused had to scan every Grove or an
    // alphabetically-earlier unpaused Grove could hide a paused entry.
    //
    // The lease removes that failure mode rather than defending against it —
    // it is one read keyed by project id, so no number of registering Groves
    // can mask it. `grove_id` is now informational: during this window the
    // project genuinely sits in two Groves, and it can be neither if an
    // operation has deregistered it, so nothing keys on which one comes back.
    const source = createGrove('aardvark', home);
    const target = createGrove('zebra', home);
    registerProjectInGrove(source.id, {
      projectId: PROJECT_A,
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);
    registerProjectInGrove(target.id, {
      projectId: PROJECT_A,
      projectName: 'Demo',
      projectRoot: '/tmp/demo',
    }, home);

    pauseProject(target.id, PROJECT_A, 'grove-move', 'op-move', home);

    const status = isProjectPaused(PROJECT_A, home);
    expect(status.paused).toBe(true);
    if (!status.paused) throw new Error('unreachable');
    expect(status.owner_op).toBe('op-move');
    // Informational only — either registering Grove is a truthful answer.
    expect([source.id, target.id]).toContain(status.grove_id);
  });
});
