/**
 * Task A1: `resolveProjectConfig`'s `shouldVisit` gate must DEGRADE (empty
 * project tier, machine+grove still resolve) for a registered project whose
 * working tree isn't present on this machine — the Team Host shape — rather
 * than throw "myco.yaml not found" and silently skip the project every tick.
 *
 * This file deliberately does NOT mock `@myco/db/client.js` — real Grove DB
 * access (including the built-in-agent seed check that runs on first open)
 * needs the real ambient `getDatabase()`/`withDatabase()` AsyncLocalStorage
 * scoping, which `task-scheduling.test.ts`'s file-level DB mock breaks for
 * any test that opens a real Grove.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import {
  registerScheduledTasks as registerScheduledTasksWith,
  type TaskSchedulingDeps,
} from '@myco/daemon/task-scheduling.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { ProjectPowerStateTracker } from '@myco/daemon/project-power-state.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const registerScheduledTasks = (
  runner: Parameters<typeof registerScheduledTasksWith>[0],
  deps: TaskSchedulingDeps,
) => registerScheduledTasksWith(runner, {
  ...deps,
  lockNamespace: testPerUserLockNamespace,
});
import {
  createGrove,
  registerProjectInGrove,
  clearGroveRegistryCaches,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import type { AgentTask } from '@myco/agent/types.js';

mock.module('@myco/agent/registry.js', () => ({
  loadAllTasks: () => new Map<string, AgentTask>([
    ['vault-evolve', {
      name: 'vault-evolve',
      displayName: 'Vault Evolve',
      description: 'test',
      agent: 'myco-agent',
      prompt: 'test',
      isDefault: false,
      schedule: { enabled: true, intervalSeconds: 300, runIn: ['idle'] },
    }],
  ]),
}));

interface Fixture {
  workDir: string;
  mycoHome: string;
  grove: GroveRecord;
  cache: GroveRuntimeCache;
  cleanup: () => void;
}

function setupFixture(): Fixture {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-sched-tree-')));
  const mycoHome = path.join(workDir, 'home');
  fs.mkdirSync(mycoHome, { recursive: true });
  const previousMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  clearGroveRegistryCaches();

  const grove = createGrove('Solo', mycoHome);
  ensureGroveDatabase(grove.id, mycoHome);
  const databasePath = resolveGroveDbPath(grove.id, mycoHome);

  // Boot DB so the ambient getDatabase() (used by e.g. the built-in-agent
  // seed check on first Grove-DB open) resolves against a real, schema'd
  // sqlite handle instead of throwing.
  initDatabase(databasePath);
  createSchema(getDatabase());

  const cache = new GroveRuntimeCache();

  return {
    workDir,
    mycoHome,
    grove,
    cache,
    cleanup: () => {
      cache.closeAll();
      try { closeDatabase(); } catch { /* noop */ }
      if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousMycoHome;
      clearGroveRegistryCaches();
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

describe('scheduled tasks — projectTierOptional degrade for a treeless registered project', () => {
  let fx: Fixture;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fx = setupFixture();
  });

  afterEach(() => fx.cleanup());

  async function runOneTick(projectRoot: string): Promise<void> {
    registerProjectInGrove(fx.grove.id, {
      projectId: 'proj_' + 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
      projectName: 'hosted',
      projectRoot,
    }, fx.mycoHome);

    let capturedJobs: Array<{ name: string; fn: () => Promise<unknown> }> = [];
    const powerManager = {
      replaceGroup: (_prefix: string, jobs: typeof capturedJobs) => { capturedJobs = jobs; },
    };

    await registerScheduledTasks(powerManager as never, {
      definitionsDir: '/tmp/defs',
      resolveEmbeddingManager: () => ({} as never),
      logger: logger as never,
      cache: fx.cache,
      mycoHome: fx.mycoHome,
      daemonStateDir: path.join(fx.mycoHome, 'service'),
      machineId: 'test-machine',
      projectStateTracker: new ProjectPowerStateTracker({
        idleThresholdMs: 60_000,
        sleepThresholdMs: 5 * 60_000,
        deepSleepThresholdMs: 30 * 60_000,
      }),
    });

    const job = capturedJobs.find((j) => j.name === 'scheduled:tasks');
    expect(job).toBeDefined();
    await job!.fn();
  }

  it('resolves degraded config for a project with no working tree instead of silently skipping via a config-load error', async () => {
    // Team Host shape: the registered project row is real, but its working
    // tree was checked out on a member machine — this path never existed here.
    const projectRoot = path.join(fx.workDir, 'never-created', 'hosted');
    await runOneTick(projectRoot);

    // Before the projectTierOptional fix, loadMergedConfig threw "myco.yaml
    // not found" for this project; resolveProjectConfig caught it, logged
    // this exact message, and shouldVisit returned false via its `!config`
    // branch — silently skipping the project every tick.
    const errorMessages = (logger.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1]));
    expect(errorMessages.some((m) => m.includes('Failed to load tenant config'))).toBe(false);

    // "Scheduled agent tasks enabled for project" only logs once
    // resolveProjectConfig has returned a real (non-null) config and
    // `config.agent.scheduled_tasks_enabled` was read from it — proof the
    // config actually resolved rather than the `!config` branch firing.
    const infoMessages = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1]));
    expect(infoMessages.some((m) => m.includes('Scheduled agent tasks enabled for project'))).toBe(true);
  });

  it('regression: still resolves config normally for a project whose working tree exists', async () => {
    const projectRoot = path.join(fx.workDir, 'projects', 'local');
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n');
    await runOneTick(projectRoot);

    const errorMessages = (logger.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1]));
    expect(errorMessages.some((m) => m.includes('Failed to load tenant config'))).toBe(false);

    const infoMessages = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1]));
    expect(infoMessages.some((m) => m.includes('Scheduled agent tasks enabled for project'))).toBe(true);
  });
});
