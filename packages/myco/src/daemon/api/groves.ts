import { loadProjectManifest } from '@myco/config/project-manifest.js';
import { resolveMycoHome, resolveProjectVaultDir, resolveServiceDirName } from '@myco/grove/paths.js';
import {
  createGrove,
  deleteGrove,
  findRegisteredProject,
  getDefaultGroveId,
  getRegisteredProjectInGrove,
  listGroves,
  listRegisteredProjects,
  loadGroveRecord,
  renameGrove,
  setDefaultGrove,
  type DaemonVariant,
  type GroveRecord,
  type RegisteredProject,
} from '@myco/grove/registry.js';
import { moveProjectBetweenGroves } from '@myco/grove/move.js';
import {
  archiveProject,
  deleteProjectPermanently,
  unarchiveProject,
} from '@myco/grove/project-lifecycle.js';
import { projectUrlSlug } from '@myco/grove/ids.js';
import type { RouteHandler } from '@myco/daemon/router.js';
import { errorBody } from './error-envelope.js';

function daemonVariant(daemonStateDir: string): DaemonVariant {
  return resolveServiceDirName(daemonStateDir, resolveMycoHome());
}

export interface GroveProjectSummary {
  project_id: string;
  name: string;
  slug: string;
  root: string;
  binding_id: string | null;
  status: 'active' | 'archived';
  archived_at: string | null;
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

export function createListGrovesHandler(scope: ServedGroveScope, daemonStateDir: string): RouteHandler {
  return async (req) => ({
    body: listGroveSummaries(scope, daemonVariant(daemonStateDir), {
      includeArchived: req.query.include_archived === 'true',
    }),
  });
}

export function createListGroveProjectsHandler(scope: ServedGroveScope, daemonStateDir: string): RouteHandler {
  return async (req) => {
    const groveId = req.params.id;
    const summaries = listGroveSummaries(scope, daemonVariant(daemonStateDir));
    const grove = summaries.groves.find((row) => row.id === groveId || row.slug === groveId);
    if (!grove) return { status: 404, body: { error: 'grove_not_found' } };
    return { body: { projects: grove.projects } };
  };
}

export function listGroveSummaries(
  scope: ServedGroveScope = { groveIds: null },
  servedBy?: DaemonVariant,
  options: { includeArchived?: boolean } = {},
): GrovesResponse {
  const defaultGroveId = getDefaultGroveId();
  const allGroves = servedBy ? listGroves(undefined, { servedBy }) : listGroves();
  const filtered = scope.groveIds
    ? allGroves.filter((grove) => scope.groveIds!.includes(grove.id))
    : allGroves;
  const groves = filtered.map((grove) => {
    const projects = listRegisteredProjects(grove.id, undefined, {
      includeArchived: options.includeArchived,
    })
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
    status: project.status,
    archived_at: project.archived_at ?? null,
    created_at: project.created_at,
    updated_at: project.updated_at,
    manifest_state: manifestState(project),
  };
}

export function createArchiveProjectHandler(daemonStateDir: string): RouteHandler {
  return async (req) => projectLifecycle(req.params.id, req.params.projectId, daemonStateDir, 'archive');
}

export function createUnarchiveProjectHandler(daemonStateDir: string): RouteHandler {
  return async (req) => projectLifecycle(req.params.id, req.params.projectId, daemonStateDir, 'unarchive');
}

export function createDeleteProjectHandler(daemonStateDir: string): RouteHandler {
  return async (req) => {
    const groveId = req.params.id;
    const projectId = req.params.projectId;
    const servedBy = daemonVariant(daemonStateDir);
    const grove = loadGroveRecord(groveId);
    if (!grove || grove.served_by !== servedBy) {
      return { status: 404, body: errorBody('grove_not_found', `Unknown Grove: ${groveId}`) };
    }
    const project = getProjectForLifecycle(groveId, projectId);
    if (!project) {
      return { status: 404, body: errorBody('project_not_found', `Project ${projectId} is not registered in Grove ${groveId}`) };
    }

    const body = (req.body ?? {}) as { confirmation_name?: unknown };
    if (body.confirmation_name !== project.name) {
      return {
        status: 400,
        body: errorBody('confirmation_name_mismatch', `Type ${project.name} to permanently delete this project`),
      };
    }

    try {
      return { body: { ok: true, delete: deleteProjectPermanently(groveId, projectId) } };
    } catch (err) {
      return { status: 500, body: errorBody('project_delete_failed', (err as Error).message) };
    }
  };
}

function projectLifecycle(
  groveId: string,
  projectId: string,
  daemonStateDir: string,
  action: 'archive' | 'unarchive',
) {
  const servedBy = daemonVariant(daemonStateDir);
  const grove = loadGroveRecord(groveId);
  if (!grove || grove.served_by !== servedBy) {
    return { status: 404, body: errorBody('grove_not_found', `Unknown Grove: ${groveId}`) };
  }
  const project = getProjectForLifecycle(groveId, projectId);
  if (!project) {
    return { status: 404, body: errorBody('project_not_found', `Project ${projectId} is not registered in Grove ${groveId}`) };
  }
  try {
    const result = action === 'archive'
      ? archiveProject(groveId, projectId)
      : unarchiveProject(groveId, projectId);
    return { body: { ok: true, project: result } };
  } catch (err) {
    return { status: 500, body: errorBody(`project_${action}_failed`, (err as Error).message) };
  }
}

function getProjectForLifecycle(groveId: string, projectId: string): RegisteredProject | null {
  return getRegisteredProjectInGrove(groveId, projectId, undefined, { includeArchived: true });
}

function projectSlug(project: RegisteredProject): string {
  return projectUrlSlug(project.name, project.project_id);
}

export function createCreateGroveHandler(daemonStateDir: string): RouteHandler {
  return async (req) => {
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return { status: 400, body: errorBody('name_required', 'Grove name is required') };
    }
    try {
      const grove = createGrove(name, undefined, { servedBy: daemonVariant(daemonStateDir) });
      return {
        status: 201,
        body: {
          id: grove.id,
          slug: grove.slug,
          name: grove.name,
          mode: grove.mode,
          served_by: grove.served_by,
          created_at: grove.created_at,
        },
      };
    } catch (err) {
      return { status: 500, body: errorBody('create_failed', (err as Error).message) };
    }
  };
}

export function createRenameGroveHandler(daemonStateDir: string): RouteHandler {
  return async (req) => {
    const groveId = req.params.id;
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return { status: 400, body: errorBody('name_required', 'Grove name is required') };
    }
    const existing = loadGroveRecord(groveId);
    if (!existing || existing.served_by !== daemonVariant(daemonStateDir)) {
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

export function createDeleteGroveHandler(daemonStateDir: string): RouteHandler {
  return async (req) => {
    const groveId = req.params.id;
    const existing = loadGroveRecord(groveId);
    if (!existing || existing.served_by !== daemonVariant(daemonStateDir)) {
      return { status: 404, body: errorBody('grove_not_found', `Unknown Grove: ${groveId}`) };
    }
    const projects = listRegisteredProjects(groveId, undefined, { includeArchived: true });
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

export function createMoveProjectHandler(daemonStateDir: string): RouteHandler {
  return async (req) => {
    const targetGroveId = req.params.id;
    const projectId = req.params.projectId;
    const servedBy = daemonVariant(daemonStateDir);

    const found = findRegisteredProject({ projectId });
    if (!found) {
      return {
        status: 404,
        body: errorBody('project_not_found', `Project ${projectId} is not registered in any Grove`),
      };
    }
    const sourceGroveId = found.grove.id;

    // Source must be served by this daemon — leak nothing about Groves
    // owned by a different daemon. Treat as project_not_found from this
    // daemon's perspective.
    if (found.grove.served_by !== servedBy) {
      return {
        status: 404,
        body: errorBody('project_not_found', `Project ${projectId} is not registered in any Grove`),
      };
    }

    if (sourceGroveId === targetGroveId) {
      return {
        status: 400,
        body: errorBody('same_grove', 'Source and target are the same Grove'),
      };
    }

    const target = loadGroveRecord(targetGroveId);
    if (!target || target.served_by !== servedBy) {
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

export function createSetDefaultGroveHandler(daemonStateDir: string): RouteHandler {
  return async (req) => {
    const groveId = req.params.id;
    const grove = loadGroveRecord(groveId);
    if (!grove || grove.served_by !== daemonVariant(daemonStateDir)) {
      return { status: 404, body: errorBody('grove_not_found', `Unknown Grove: ${groveId}`) };
    }
    try {
      const updated = setDefaultGrove(groveId);
      return {
        body: {
          id: updated.id,
          slug: updated.slug,
          name: updated.name,
          is_default: true,
        },
      };
    } catch (err) {
      return { status: 500, body: errorBody('set_default_failed', (err as Error).message) };
    }
  };
}

function manifestState(project: RegisteredProject): GroveProjectSummary['manifest_state'] {
  let manifest;
  try {
    manifest = loadProjectManifest(resolveProjectVaultDir(project.root));
  } catch {
    // Distinguish "file is malformed" from "file is absent". Returning
    // 'missing' for a parse error would send the user down the
    // auto-registration path, which would happily overwrite the broken
    // file without surfacing what was wrong; 'invalid' gives the UI a
    // clear path to "open and fix".
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
