import { loadMergedConfig } from '../config/loader.js';
import type { PlanWatchConfig } from './plan-capture.js';

export interface PlanWatchReactionDeps {
  vaultDir: string;
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
 * merged (project + local) `capture.plan_dirs`. Mutates the config object
 * in place so consumers that closed over the reference see the update.
 *
 * Reads the merged config so a local-scope override is honored — reading
 * project-only would miss per-machine additions made via the UI.
 *
 * Errors propagate to the reaction registry, which logs and continues so
 * other reactions still run.
 */
export function createPlanWatchReaction(deps: PlanWatchReactionDeps): () => void {
  return () => {
    const cfg = loadMergedConfig(deps.vaultDir);
    const customDirs = cfg.capture.plan_dirs ?? [];
    deps.planWatchConfig.watchDirs = [...new Set([...deps.symbiontPlanDirs, ...customDirs])];
  };
}
