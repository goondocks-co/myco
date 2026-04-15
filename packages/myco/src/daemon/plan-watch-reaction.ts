import { loadConfig } from '../config/loader.js';
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
 * current `capture.plan_dirs` in myco.yaml. Mutates the config object in
 * place so consumers that closed over the reference see the update.
 *
 * Idempotent: if the new watchDirs equals the old set, the assignment is
 * still made but observable behavior is unchanged.
 *
 * Swallows loadConfig errors (malformed YAML) so a transient write failure
 * doesn't propagate through fire() to other reactions.
 */
export function createPlanWatchReaction(deps: PlanWatchReactionDeps): () => void {
  return () => {
    try {
      const cfg = loadConfig(deps.vaultDir);
      const customDirs = cfg.capture.plan_dirs ?? [];
      deps.planWatchConfig.watchDirs = [...new Set([...deps.symbiontPlanDirs, ...customDirs])];
    } catch {
      // loadConfig throws on malformed YAML; the write just succeeded so this
      // should not happen, but swallowing keeps other reactions running.
    }
  };
}
