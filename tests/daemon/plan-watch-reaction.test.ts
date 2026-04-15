import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPlanWatchReaction } from '@myco/daemon/plan-watch-reaction.js';
import type { PlanWatchConfig } from '@myco/daemon/plan-capture.js';

describe('createPlanWatchReaction', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-planwatch-'));
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'),
      `version: 3\ncapture:\n  plan_dirs:\n    - /custom/a\n`);
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('mutates planWatchConfig.watchDirs in place so closure consumers see updates', () => {
    const planWatchConfig: PlanWatchConfig = {
      projectRoot: tmpDir,
      watchDirs: ['/symbiont/x'],
    };
    const consumer = planWatchConfig; // simulates event-dispatch closure

    const reaction = createPlanWatchReaction({
      vaultDir: tmpDir,
      symbiontPlanDirs: ['/symbiont/x'],
      planWatchConfig,
    });
    reaction();

    // Mutation in place — consumer sees the update without being passed a new ref.
    expect(consumer.watchDirs).toContain('/symbiont/x');
    expect(consumer.watchDirs).toContain('/custom/a');
  });

  it('deduplicates overlap between symbiont dirs and custom dirs', () => {
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'),
      `version: 3\ncapture:\n  plan_dirs:\n    - /symbiont/x\n    - /custom/a\n`);
    const planWatchConfig: PlanWatchConfig = {
      projectRoot: tmpDir,
      watchDirs: [],
    };
    const reaction = createPlanWatchReaction({
      vaultDir: tmpDir,
      symbiontPlanDirs: ['/symbiont/x'],
      planWatchConfig,
    });
    reaction();
    expect(planWatchConfig.watchDirs.filter((d) => d === '/symbiont/x')).toHaveLength(1);
  });

  it('picks up plan_dirs from local overlay (merged config, not project-only)', () => {
    // Project has no custom plan dirs; local overlay adds one.
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'),
      `version: 3\ncapture:\n  plan_dirs: []\n`);
    fs.writeFileSync(path.join(tmpDir, 'local.yaml'),
      `capture:\n  plan_dirs:\n    - /local/override\n`);
    const planWatchConfig: PlanWatchConfig = {
      projectRoot: tmpDir,
      watchDirs: [],
    };
    const reaction = createPlanWatchReaction({
      vaultDir: tmpDir,
      symbiontPlanDirs: [],
      planWatchConfig,
    });
    reaction();
    expect(planWatchConfig.watchDirs).toContain('/local/override');
  });

  it('swallows loadMergedConfig errors (malformed yaml during reconcile should not throw)', () => {
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), '::: not yaml');
    const planWatchConfig: PlanWatchConfig = {
      projectRoot: tmpDir,
      watchDirs: ['/symbiont/x'],
    };
    const reaction = createPlanWatchReaction({
      vaultDir: tmpDir,
      symbiontPlanDirs: ['/symbiont/x'],
      planWatchConfig,
    });
    expect(() => reaction()).not.toThrow();
    // watchDirs unchanged on failure
    expect(planWatchConfig.watchDirs).toEqual(['/symbiont/x']);
  });
});
