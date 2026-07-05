import path from 'node:path';
import type { ConfigReaction } from './config-reactions/registry.js';
import { reconcileManagedProjectFiles } from '../symbionts/reconcile.js';

export interface OkfReconcileReactionDeps {
  /** Injectable for tests; defaults to the real reconciler. */
  reconcile?: typeof reconcileManagedProjectFiles;
}

/**
 * Reaction for `okf.*` scoped-config writes: reconcile the ONE written
 * project's managed files immediately so the AGENTS.md OKF pointer follows a
 * capability flip without waiting for the periodic all-projects sweep (which
 * remains the convergence backstop).
 *
 * `okf` is project-scoped, so per-project write-time reconciliation is sound
 * here — unlike machine-scoped `capture.*`, which affects every project and
 * is deliberately left to the MANAGED_FILES_RECONCILE power job.
 */
export function createOkfReconcileReaction(deps: OkfReconcileReactionDeps = {}): ConfigReaction {
  const reconcile = deps.reconcile ?? reconcileManagedProjectFiles;
  return (_ctx, scope) => {
    reconcile(path.dirname(scope.vaultDir), scope.vaultDir, scope.groveId);
  };
}
