/**
 * RC-4 — the scheduler must re-read tenant config on every project tick.
 *
 * A single-slot memo keyed on the last-resolved project only invalidated
 * when a DIFFERENT project resolved between calls — on a single-project
 * install (the common case) Settings changes like `scheduled_tasks_enabled`
 * were served from boot values until a daemon restart. This test drives the
 * collapsed scheduler job against ONE registered project, flips the
 * grove-tier toggle on disk between ticks, and asserts the gate sees it.
 *
 * Uses mock.module — keep this file's mocks self-contained (per-file
 * isolation, PR #466 rule). `@myco/db/client.js` is deliberately NOT
 * mocked: the scheduler tick opens a real per-Grove DB file through
 * `GroveRuntimeCache`, and `openInitializedDatabase` seeds built-in
 * agents/tasks on that real handle (Plan B Task 1) — a fake `getDatabase`
 * stub would break that seed call, not just this test's own assertions.
 */
import { describe, it, expect, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
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

import { registerScheduledTasks } from '@myco/daemon/task-scheduling.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { ProjectPowerStateTracker } from '@myco/daemon/project-power-state.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { invalidateMergedConfigCache } from '@myco/config/loader.js';

describe('RC-4 — scheduler config refresh on single-project installs', () => {
  it('flipping scheduled_tasks_enabled between ticks takes effect without restart', async () => {
    const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rc4-home-'));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc4-proj-'));
    const previousHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    invalidateMergedConfigCache();

    try {
      const vaultDir = path.join(projectRoot, '.myco');
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n', 'utf-8');
      ensureProjectManifest(vaultDir, { projectName: 'rc4-test' });

      const grove = createGrove('RC4 Test Grove', mycoHome);
      const projectId = 'proj_' + 'c'.repeat(32);
      registerProjectInGrove(grove.id, {
        projectId,
        projectName: 'rc4-test',
        projectRoot,
      }, mycoHome);

      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const captured: Array<{ name: string; fn: () => Promise<void> }> = [];
      const powerManager = {
        replaceGroup: vi.fn((_prefix: string, jobs: Array<{ name: string; fn: () => Promise<void> }>) => {
          captured.splice(0, captured.length, ...jobs);
        }),
      };

      await registerScheduledTasks(powerManager as never, {
        definitionsDir: '/tmp/defs',
        vaultDir,
        resolveEmbeddingManager: () => ({} as never),
        logger: logger as never,
        cache: new GroveRuntimeCache(),
        mycoHome,
        daemonStateDir: path.join(mycoHome, 'service'),
        machineId: 'rc4-machine',
        projectStateTracker: new ProjectPowerStateTracker({
          idleThresholdMs: 60_000,
          sleepThresholdMs: 5 * 60_000,
          deepSleepThresholdMs: 30 * 60_000,
        }),
      });

      const job = captured.find((j) => j.name === 'scheduled:tasks');
      expect(job).toBeDefined();

      // Tick 1: default config — scheduled tasks enabled; the null→enabled
      // transition logs once.
      await job!.fn();
      const enabledLog = logger.info.mock.calls.find(
        (c: unknown[]) => String(c[1]).includes('Scheduled agent tasks enabled for project'),
      );
      expect(enabledLog).toBeDefined();

      // Flip the grove-tier toggle on disk, exactly as the Settings UI does.
      fs.writeFileSync(
        path.join(mycoHome, 'groves', grove.id, 'grove.yaml'),
        YAML.stringify({ agent: { scheduled_tasks_enabled: false } }),
        'utf-8',
      );

      // Tick 2: the gate must see the change — the enabled→disabled
      // transition log is the proof of a fresh config read. The old
      // single-slot memo served boot config here and never logged this.
      await job!.fn();
      const disabledLog = logger.info.mock.calls.find(
        (c: unknown[]) => String(c[1]).includes('Scheduled agent tasks disabled for project'),
      );
      expect(disabledLog).toBeDefined();
    } finally {
      if (previousHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousHome;
      invalidateMergedConfigCache();
      fs.rmSync(mycoHome, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
