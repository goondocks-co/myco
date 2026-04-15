import { describe, it, expect } from 'vitest';
import { createPlanWatchReaction } from '@myco/daemon/plan-watch-reaction.js';
import type { PlanWatchConfig } from '@myco/daemon/plan-capture.js';
import type { MycoConfig } from '@myco/config/schema.js';

function ctxWithPlanDirs(planDirs: string[]): MycoConfig {
  return { capture: { plan_dirs: planDirs } } as unknown as MycoConfig;
}

describe('createPlanWatchReaction', () => {
  it('mutates planWatchConfig.watchDirs in place so closure consumers see updates', () => {
    const planWatchConfig: PlanWatchConfig = {
      projectRoot: '/tmp/project',
      watchDirs: ['/symbiont/x'],
    };
    const consumer = planWatchConfig; // simulates event-dispatch closure

    const reaction = createPlanWatchReaction({
      symbiontPlanDirs: ['/symbiont/x'],
      planWatchConfig,
    });
    reaction(ctxWithPlanDirs(['/custom/a']));

    expect(consumer.watchDirs).toContain('/symbiont/x');
    expect(consumer.watchDirs).toContain('/custom/a');
  });

  it('deduplicates overlap between symbiont dirs and custom dirs', () => {
    const planWatchConfig: PlanWatchConfig = {
      projectRoot: '/tmp/project',
      watchDirs: [],
    };
    const reaction = createPlanWatchReaction({
      symbiontPlanDirs: ['/symbiont/x'],
      planWatchConfig,
    });
    reaction(ctxWithPlanDirs(['/symbiont/x', '/custom/a']));
    expect(planWatchConfig.watchDirs.filter((d) => d === '/symbiont/x')).toHaveLength(1);
  });

  it('handles missing plan_dirs (undefined -> empty)', () => {
    const planWatchConfig: PlanWatchConfig = {
      projectRoot: '/tmp/project',
      watchDirs: ['stale'],
    };
    const reaction = createPlanWatchReaction({
      symbiontPlanDirs: ['/symbiont/x'],
      planWatchConfig,
    });
    reaction({ capture: {} } as unknown as MycoConfig);
    expect(planWatchConfig.watchDirs).toEqual(['/symbiont/x']);
  });
});
