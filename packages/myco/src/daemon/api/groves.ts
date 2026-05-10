import { loadProjectManifest } from '@myco/config/project-manifest.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import {
  createGrove,
  deleteGrove,
  findRegisteredProject,
  getDefaultGroveId,
  listGroves,
  listRegisteredProjects,
  loadGroveRecord,
  renameGrove,
  type GroveRecord,
  type RegisteredProject,
} from '@myco/grove/registry.js';
import { moveProjectBetweenGroves } from '@myco/grove/move.js';
import { projectUrlSlug } from '@myco/grove/ids.js';
import type { RouteHandler } from '@myco/daemon/router.js';
import { errorBody } from './error-envelope.js';

export interface GroveProjectSummary {
  project_id: string;
  name: string;
  slug: string;
  root: string;
  binding_id: string | null;
  created_at: string;
  updated_at: string;
  manifest_state: 'present' | 'missing' | 'invalid' | 'mismatch';
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
   * the global registry knows about".
   */
  groveIds: readonly string[] | null;
}

export function servedGroveScopeForDaemon(): ServedGroveScope {
  return { groveIds: null };
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

export function createCreateGroveHandler(): RouteHandler {
  return async (req) => {
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return { status: 400, body: errorBody('name_required', 'Grove name is required') };
    }
    try {
      const grove = createGrove(name);
      return {
        status: 201,
        body: {
          id: grove.id,
          slug: grove.slug,
          name: grove.name,
          mode: grove.mode,
          created_at: grove.created_at,
        },
      };
    } catch (err) {
      return { status: 500, body: errorBody('create_failed', (err as Error).message) };
    }
  };
}

export function createRenameGroveHandler(): RouteHandler {
  return async (req) => {
    const groveId = req.params.id;
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return { status: 400, body: errorBody('name_required', 'Grove name is required') };
    }
    if (!loadGroveRecord(groveId)) {
      return { status: 404, body: errorBody('grove_not_found', `Unknown Grove: ${groveId}`) };
    }
    try {
      const updated = renameGrove(groveId, name);
      return {
        body: {
          id: updated.id,
          slug: updated.slug,
          name: updated.name,
          mode: updated.mode,
          created_at: updated.created_at,
        },
      };
    } catch (err) {
      return { status: 500, body: errorBody('rename_failed', (err as Error).message) };
    }
  };
}

export function createDeleteGroveHandler(): RouteHandler {
  return async (req) => {
    const groveId = req.params.id;
    if (!loadGroveRecord(groveId)) {
      return { status: 404, body: errorBody('grove_not_found', `Unknown Grove: ${groveId}`) };
    }
    const projects = listRegisteredProjects(groveId);
    if (projects.length > 0) {
      return {
        status: 409,
        body: {
          ...errorBody(
            'grove_not_empty',
            `Grove has ${projects.length} bound project(s); move or delete them first`,
          ),
          project_count: projects.length,
        },
      };
    }
    try {
      // `force: false` is the explicit, non-destructive path. A `?force=true`
      // query parameter is intentionally not exposed; force-delete is a
      // CLI-side flag, not a URL trick.
      deleteGrove(groveId, { force: false });
      return { status: 204, body: undefined };
    } catch (err) {
      return { status: 500, body: errorBody('delete_failed', (err as Error).message) };
    }
  };
}

export function createMoveProjectHandler(): RouteHandler {
  return async (req) => {
    const targetGroveId = req.params.id;
    const projectId = req.params.projectId;

    const found = findRegisteredProject({ projectId });
    if (!found) {
      return {
        status: 404,
        body: errorBody('project_not_found', `Project ${projectId} is not registered in any Grove`),
      };
    }
    const sourceGroveId = found.grove.id;

    if (sourceGroveId === targetGroveId) {
      return {
        status: 400,
        body: errorBody('same_grove', 'Source and target are the same Grove'),
      };
    }

    if (!loadGroveRecord(targetGroveId)) {
      return {
        status: 404,
        body: errorBody('target_grove_not_found', `Unknown target Grove: ${targetGroveId}`),
      };
    }

    try {
      const result = moveProjectBetweenGroves(sourceGroveId, targetGroveId, projectId);
      return { body: { ok: true, move: result } };
    } catch (err) {
      return { status: 500, body: errorBody('move_failed', (err as Error).message) };
    }
  };
}

function manifestState(project: RegisteredProject): GroveProjectSummary['manifest_state'] {
  let manifest;
  try {
    manifest = loadProjectManifest(resolveProjectVaultDir(project.root));
  } catch {
    // Distinguish "file is malformed" from "file is absent". Returning
    // 'missing' for a parse error sends the user to `myco init`, which
    // would happily overwrite the broken file without surfacing what
    // was wrong; 'invalid' gives the UI a clear path to "open and fix".
    return 'invalid';
  }
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
}
