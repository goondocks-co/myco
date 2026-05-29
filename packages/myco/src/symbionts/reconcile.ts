import path from 'node:path';
import { loadManifests, resolvePackageRoot } from './detect.js';
import { SymbiontInstaller } from './installer.js';

/**
 * Reconcile the project-scoped artefacts that a `capture` / `symbionts`
 * config change can affect under the global-install model: the project
 * `.gitignore` (bundled skill dirs + configured plan dirs + wrangler cache).
 *
 * Symbiont hooks are installed GLOBALLY by bootstrap / `myco update`. They are
 * deliberately NOT re-created at project scope here. The previous version
 * called `installer.install()` at project scope, which re-created
 * `.agents/myco-run.cjs` and repointed the agent hook command at the
 * project-local launcher — silently re-coupling a migrated project to exactly
 * the project-local launcher the global-install migration had just stripped.
 * Capture kept working (the re-created stub carried the v2 sentinel), so the
 * regression was invisible: a clean-break un-done with no user-facing symptom,
 * leaving stray `.agents/` churn in `git status`.
 *
 * The only project-scoped write the global model needs on a capture/symbionts
 * change is the `.gitignore` reconciliation (mirrors the migration pass's
 * `reconcileProjectGitignore` call). Idempotent: re-running with the same
 * config produces the same `.gitignore`.
 */
export function reconcileConfiguredSymbionts(
  projectRoot: string,
  vaultDir: string = path.join(projectRoot, '.myco'),
  groveId?: string | null,
): number {
  const manifests = loadManifests();
  if (manifests.length === 0) return 0;
  // Gitignore reconciliation is symbiont-agnostic (it manages canonical skill
  // dirs + plan dirs + wrangler cache), so any manifest serves — mirrors the
  // migration pass, which also reconciles via `manifests[0]`.
  const installer = new SymbiontInstaller(
    manifests[0], projectRoot, resolvePackageRoot(), false, vaultDir, groveId ?? null, 'project',
  );
  installer.reconcileProjectGitignore();
  return 1;
}
