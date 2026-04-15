import type { ConfigReaction } from './config-reactions/registry.js';
import type { PlanWatchConfig } from './plan-capture.js';

export interface PlanWatchReactionDeps {
  symbiontPlanDirs: string[];
  /**
   * The live PlanWatchConfig object. This factory mutates `.watchDirs` in
   * place — do NOT pass a fresh copy. Downstream consumers (event dispatcher)
   * close over this same object reference for hot-reload to work.
   */
  planWatchConfig: PlanWatchConfig;
}

/**
 * Returns a reaction that refreshes `planWatchConfig.watchDirs` from the
 * merged `capture.plan_dirs` passed through by the registry. Mutates the
 * config object in place so consumers that closed over the reference see
 * the update.
 */
export function createPlanWatchReaction(deps: PlanWatchReactionDeps): ConfigReaction {
  return (ctx) => {
    const customDirs = ctx.capture.plan_dirs ?? [];
    deps.planWatchConfig.watchDirs = [...new Set([...deps.symbiontPlanDirs, ...customDirs])];
  };
}
