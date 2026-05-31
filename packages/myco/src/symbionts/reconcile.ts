import path from 'node:path';
import { loadManifests, resolvePackageRoot } from './detect.js';
import { SymbiontInstaller, type ManagedProjectFilesResult } from './installer.js';
import { listGroves, listRegisteredProjects, type DaemonVariant } from '../grove/registry.js';
import { currentDaemonVariant, resolveMycoHome } from '../grove/paths.js';
import type { SymbiontManifest } from './manifest-schema.js';

export interface ManagedProjectFilesOutcome {
  groveId: string;
  projectId: string;
  projectRoot: string;
  result: ManagedProjectFilesResult | null;
  error: string | null;
}

/**
 * Reconcile the project-scoped artifacts that a `capture` / `symbionts`
 * config change can affect under the global-install model: managed rules
 * guidance plus the project `.gitignore` (bundled skill dirs + configured
 * plan dirs + wrangler cache).
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
 * Project-managed files are still local repository surfaces. Keep those
 * reconciled through `reconcileManagedProjectFiles()` so future managed files
 * join one durable pattern instead of each caller growing a separate write.
 */
export function reconcileConfiguredSymbionts(
  projectRoot: string,
  vaultDir: string = path.join(projectRoot, '.myco'),
  groveId?: string | null,
): number {
  const result = reconcileManagedProjectFiles(projectRoot, vaultDir, groveId);
  return result ? 1 : 0;
}

export function reconcileManagedProjectFiles(
  projectRoot: string,
  vaultDir: string = path.join(projectRoot, '.myco'),
  groveId?: string | null,
  options: { manifests?: SymbiontManifest[]; packageRoot?: string } = {},
): ManagedProjectFilesResult | null {
  const manifests = options.manifests ?? loadManifests();
  if (manifests.length === 0) return null;
  const packageRoot = options.packageRoot ?? resolvePackageRoot();
  // Managed project-file reconciliation is symbiont-agnostic (rules guidance,
  // canonical skill dirs + plan dirs + wrangler cache), so any manifest serves.
  const installer = new SymbiontInstaller(
    manifests[0], projectRoot, packageRoot, false, vaultDir, groveId ?? null, 'project',
  );
  return installer.reconcileManagedProjectFiles();
}

export function reconcileRegisteredManagedProjectFiles(
  options: {
    mycoHome?: string;
    servedBy?: DaemonVariant;
    manifests?: SymbiontManifest[];
    packageRoot?: string;
  } = {},
): ManagedProjectFilesOutcome[] {
  const mycoHome = options.mycoHome ?? resolveMycoHome();
  const servedBy = options.servedBy ?? currentDaemonVariant();
  const manifests = options.manifests ?? loadManifests();
  const packageRoot = options.packageRoot ?? resolvePackageRoot();
  const outcomes: ManagedProjectFilesOutcome[] = [];
  if (manifests.length === 0) return outcomes;

  for (const grove of listGroves(mycoHome, { servedBy })) {
    for (const project of listRegisteredProjects(grove.id, mycoHome)) {
      try {
        const result = reconcileManagedProjectFiles(
          project.root,
          path.join(project.root, '.myco'),
          grove.id,
          { manifests, packageRoot },
        );
        outcomes.push({
          groveId: grove.id,
          projectId: project.project_id,
          projectRoot: project.root,
          result,
          error: null,
        });
      } catch (err) {
        outcomes.push({
          groveId: grove.id,
          projectId: project.project_id,
          projectRoot: project.root,
          result: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return outcomes;
}
