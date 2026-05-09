import { readDaemonPort } from '@myco/daemon/service-state.js';
import { listRegisteredProjects } from '@myco/grove/registry.js';
import { projectUrlSlug } from '@myco/grove/ids.js';

export interface ProjectDashboardLocation {
  vaultDir: string;
  groveSlug: string;
  groveId: string;
  projectId: string;
  projectName: string;
}

/**
 * Build the dashboard URL pointing at a project under a Grove for the
 * daemon currently bound on the local host. Returns null when the daemon
 * isn't reachable — printing nothing is less misleading than printing a
 * URL that 404s.
 *
 * Canonical: every code path that surfaces a project URL must go through
 * here so the format stays in sync with the daemon's `/api/groves` route
 * and the UI router. Drift will produce dashboard URLs that 404.
 */
export function resolveProjectDashboardUrl(loc: ProjectDashboardLocation): string | null {
  const port = readDaemonPort(loc.vaultDir, { env: process.env });
  if (port === null) return null;
  const registered = listRegisteredProjects(loc.groveId).find((p) => p.project_id === loc.projectId);
  const slug = projectUrlSlug(registered?.name ?? loc.projectName, loc.projectId);
  return `http://localhost:${port}/g/${loc.groveSlug}/p/${slug}`;
}
