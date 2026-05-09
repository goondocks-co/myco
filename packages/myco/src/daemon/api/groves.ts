import { loadProjectManifest } from '@myco/config/project-manifest.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import {
  getDefaultGroveId,
  listGroves,
  listRegisteredProjects,
  type GroveRecord,
  type RegisteredProject,
} from '@myco/grove/registry.js';
import { projectUrlSlug } from '@myco/grove/ids.js';
import type { RouteHandler } from '@myco/daemon/router.js';
import type { DaemonServiceScope } from '@myco/daemon/service-state.js';

export interface GroveProjectSummary {
  project_id: string;
  name: string;
  slug: string;
  root: string;
  binding_id: string | null;
  created_at: string;
  updated_at: string;
  manifest_state: 'present' | 'missing' | 'mismatch';
}

export interface GroveSummary {
  id: string;
  name: string;
  slug: string;
  mode: GroveRecord['mode'];
  is_default: boolean;
  created_at: string;
  project_count: number;
  projects: GroveProjectSummary[];
}

export interface GrovesResponse {
  groves: GroveSummary[];
}

export interface ServedGroveScope {
  /**
   * Grove ids this daemon should advertise. `null` means "every Grove
   * the global registry knows about" (the global daemon model that serves
   * the user's full Grove set). A populated array is reserved for legacy
   * project-local daemon mode.
   */
  groveIds: readonly string[] | null;
}

export function servedGroveScopeForDaemon(input: {
  daemonScope: DaemonServiceScope;
  startupGroveId: string | null;
}): ServedGroveScope {
  if (input.daemonScope === 'global') return { groveIds: null };
  return { groveIds: input.startupGroveId ? [input.startupGroveId] : null };
}

export function createListGrovesHandler(scope: ServedGroveScope): RouteHandler {
  return async () => ({ body: listGroveSummaries(scope) });
}

export function createListGroveProjectsHandler(scope: ServedGroveScope): RouteHandler {
  return async (req) => {
    const groveId = req.params.id;
    const grove = listGroveSummaries(scope).groves.find((row) => row.id === groveId || row.slug === groveId);
    if (!grove) return { status: 404, body: { error: 'grove_not_found' } };
    return { body: { projects: grove.projects } };
  };
}

export function listGroveSummaries(scope: ServedGroveScope = { groveIds: null }): GrovesResponse {
  const defaultGroveId = getDefaultGroveId();
  const allGroves = listGroves();
  const filtered = scope.groveIds
    ? allGroves.filter((grove) => scope.groveIds!.includes(grove.id))
    : allGroves;
  const groves = filtered.map((grove) => {
    const projects = listRegisteredProjects(grove.id)
      .map((project) => serializeProject(project));
    return {
      id: grove.id,
      name: grove.name,
      slug: grove.slug,
      mode: grove.mode,
      is_default: grove.id === defaultGroveId,
      created_at: grove.created_at,
      project_count: projects.length,
      projects,
    };
  });
  return { groves };
}

function serializeProject(project: RegisteredProject): GroveProjectSummary {
  return {
    project_id: project.project_id,
    name: project.name,
    slug: projectSlug(project),
    root: project.root,
    binding_id: project.binding_id ?? null,
    created_at: project.created_at,
    updated_at: project.updated_at,
    manifest_state: manifestState(project),
  };
}

function projectSlug(project: RegisteredProject): string {
  return projectUrlSlug(project.name, project.project_id);
}

function manifestState(project: RegisteredProject): GroveProjectSummary['manifest_state'] {
  try {
    const manifest = loadProjectManifest(resolveProjectVaultDir(project.root));
    if (!manifest) return 'missing';
    if (manifest.project.id !== project.project_id) return 'mismatch';
    if (
      project.binding_id
      && manifest.grove?.binding_id
      && project.binding_id !== manifest.grove.binding_id
    ) {
      return 'mismatch';
    }
    return 'present';
  } catch {
    return 'missing';
  }
}
