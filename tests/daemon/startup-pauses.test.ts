import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';
import {
  ORPHAN_PAUSE_STALENESS_SECONDS,
  resumeOrphanedPauses,
} from '@myco/daemon/startup-pauses.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  isProjectPaused,
  pauseProject,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { createProjectId } from '@myco/grove/ids.js';
import type { DaemonLogger } from '@myco/daemon/logger.js';

function fakeLogger(): DaemonLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as DaemonLogger;
}

describe('resumeOrphanedPauses', () => {
  let home: string;
let PROJECT_A: string;
let PROJECT_B: string;
  let previousHome: string | undefined;

  beforeEach(() => {
  PROJECT_A = createProjectId();
  PROJECT_B = createProjectId();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-startup-pause-'));
    previousHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = home;
    clearGroveRegistryCaches();
  });

  afterEach(() => {
    clearGroveRegistryCaches();
    if (previousHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('force-resumes a pause older than the staleness threshold', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: PROJECT_A,
      projectName: 'A',
      projectRoot: '/tmp/a',
    }, home);
    pauseProject(grove.id, PROJECT_A, 'grove-move', 'op-1', home);

    // Advance the clock past the staleness window.
    const futureMs = Date.now() + (ORPHAN_PAUSE_STALENESS_SECONDS + 60) * 1000;
    const result = resumeOrphanedPauses(fakeLogger(), {
      now: () => futureMs,
      mycoHome: home,
    });

    expect(result.scanned).toBe(1);
    expect(result.resumed).toBe(1);
    expect(result.preserved).toBe(0);
    expect(isProjectPaused(PROJECT_A, home).paused).toBe(false);
  });

  it('preserves a pause younger than the staleness threshold', () => {
    const grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: PROJECT_A,
      projectName: 'A',
      projectRoot: '/tmp/a',
    }, home);
    pauseProject(grove.id, PROJECT_A, 'grove-move', 'op-1', home);

    const result = resumeOrphanedPauses(fakeLogger(), {
      now: () => Date.now() + 30 * 1000,
      mycoHome: home,
    });

    expect(result.scanned).toBe(1);
    expect(result.resumed).toBe(0);
    expect(result.preserved).toBe(1);
    const status = isProjectPaused(PROJECT_A, home);
    expect(status.paused).toBe(true);
    if (!status.paused) throw new Error('unreachable');
    expect(status.owner_op).toBe('op-1');
  });

  it('handles multiple Groves and mixed states', () => {
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
    pauseProject(groveA.id, PROJECT_A, 'grove-move', 'op-1', home);
    // PROJECT_B is unpaused.

    const futureMs = Date.now() + (ORPHAN_PAUSE_STALENESS_SECONDS + 60) * 1000;
    const result = resumeOrphanedPauses(fakeLogger(), {
      now: () => futureMs,
      mycoHome: home,
    });

    expect(result.scanned).toBe(2);
    expect(result.resumed).toBe(1);
    expect(isProjectPaused(PROJECT_A, home).paused).toBe(false);
  });
});
