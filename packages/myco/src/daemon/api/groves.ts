import { CAPABILITIES, capabilityEnabled } from '@myco/config/capabilities.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { loadProjectManifest } from '@myco/config/project-manifest.js';
import type { CapabilityId } from '@myco/config/scope.js';
import { resolveMycoHome, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { projectTreeAvailable } from '@myco/vault/resolve.js';
import {
  createGrove,
  DefaultGroveUndeletableError,
  deleteGrove,
  findRegisteredProject,
  getDefaultGroveId,
  getRegisteredProjectInGrove,
  LastGroveUndeletableError,
  listGroves,
  listRegisteredProjects,
  loadGroveRecord,
  renameGrove,
  resolveAttachRefHomeGroveId,
  ServedGroveUndeletableError,
  setDefaultGrove,
  type GroveRecord,
  type RegisteredProject,
} from '@myco/grove/registry.js';
import { readHostRegistry, type AttachRef, type HostRecord } from '@myco/host/registry.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { moveProjectBetweenGroves } from '@myco/grove/move.js';
import {
  archiveProject,
  deleteProjectPermanently,
  unarchiveProject,
} from '@myco/grove/project-lifecycle.js';
import { projectUrlSlug } from '@myco/grove/ids.js';
import { ProjectGroveMissingError, resolveProjectTenancy } from '@myco/grove/project-tenancy.js';
import type { RouteHandler } from '@myco/daemon/router.js';
import { errorBody } from './error-envelope.js';

export interface GroveProjectSummary {
  project_id: string;
  name: string;
  slug: string;
  /** Registered checkout root for a local project; `null` for an attached
   *  project whose ref carries no recorded root. */
  root: string | null;
  binding_id: string | null;
  status: 'active' | 'archived';
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  manifest_state: 'present' | 'missing' | 'invalid' | 'mismatch';
  /** Per-capability master-gate booleans for a LOCAL project. Omitted for an
   *  attached project — capabilities are host-authoritative, never computed
   *  member-side; consumers guard on presence and render no local strip. */
  capabilities?: Record<CapabilityId, boolean>;
  /**
   * Team Host attach discriminator: present (and always `true`) ONLY on a
   * project served by a remote host, appended into the member-chosen local
   * Grove section (E-4 local-view requirement). Display-only — the
   * authoritative Grove/project record is host-owned; nothing here enters
   * scope iteration, capture routing, or any write path.
   */
  attached?: true;
  /** The host serving an attached project (attach discriminator). */
  host_id?: string;
  /** The host's display label for an attached project (attach discriminator). */
  host_label?: string;
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

/** Grove tenancy projection exposed via the opt-in `include=grove`. */
export interface ProjectTenancyGrove {
  id: string;
  name: string;
  slug: string;
}

/** Tenancy keys added to a project summary when requested via `include`. */
export interface ProjectTenancyMetadata {
  grove?: ProjectTenancyGrove;
  team?: { team_id: string } | null;
}

type TenancyInclude = 'grove' | 'team';

function parseTenancyInclude(raw: string | undefined): Set<TenancyInclude> {
  const includes = new Set<TenancyInclude>();
  if (!raw) return includes;
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (token === 'grove' || token === 'team') includes.add(token);
  }
  return includes;
}

/**
 * Source the requested tenancy keys for a project from the single tenancy
 * authority (`resolveProjectTenancy`) rather than re-deriving from the registry.
 * A grove-less project (the authority throws `ProjectGroveMissingError`) yields
 * no tenancy keys for that row instead of failing the whole list response.
 */
function tenancyMetadata(
  projectId: string,
  includes: Set<TenancyInclude>,
): ProjectTenancyMetadata {
  if (includes.size === 0) return {};
  try {
    const tenancy = resolveProjectTenancy(projectId);
    const metadata: ProjectTenancyMetadata = {};
    if (includes.has('grove')) {
      metadata.grove = {
        id: tenancy.grove.id,
        name: tenancy.grove.name,
        slug: tenancy.grove.slug,
      };
    }
    if (includes.has('team')) metadata.team = tenancy.team;
    return metadata;
  } catch (err) {
    if (err instanceof ProjectGroveMissingError) return {};
    throw err;
  }
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

/** Structural logger seam — mirrors `session-completion.ts`'s
 *  `SessionCompletionDeps.logger`: a narrow shape so tests can pass a plain
 *  recording fake without constructing a real `DaemonLogger`. */
export type GrovesLogger = { warn(kind: string, message: string, data?: Record<string, unknown>): void };

export function createListGrovesHandler(scope: ServedGroveScope, _daemonStateDir: string, logger?: GrovesLogger): RouteHandler {
  return async (req) => ({
    body: listGroveSummaries(scope, {
      includeArchived: req.query.include_archived === 'true',
    }, logger),
  });
}

export function createListGroveProjectsHandler(scope: ServedGroveScope, _daemonStateDir: string, logger?: GrovesLogger): RouteHandler {
  return async (req) => {
    const groveId = req.params.id;
    const summaries = listGroveSummaries(scope, {}, logger);
    const grove = summaries.groves.find((row) => row.id === groveId || row.slug === groveId);
    if (!grove) return { status: 404, body: { error: 'grove_not_found' } };
    const includes = parseTenancyInclude(req.query.include);
    if (includes.size === 0) return { body: { projects: grove.projects } };
    const projects = grove.projects.map((project) => ({
      ...project,
      ...tenancyMetadata(project.project_id, includes),
    }));
    return { body: { projects } };
  };
}

export function listGroveSummaries(
  scope: ServedGroveScope = { groveIds: null },
  options: { includeArchived?: boolean } = {},
  logger?: GrovesLogger,
): GrovesResponse {
  const mycoHome = resolveMycoHome();
  const defaultGroveId = getDefaultGroveId(mycoHome);
  const allGroves = listGroves(mycoHome);
  const filtered = scope.groveIds
    ? allGroves.filter((grove) => scope.groveIds!.includes(grove.id))
    : allGroves;

  // Local rows first, and collect their ids: a local row always wins a
  // collision with an attached ref (see attachedProjectSummariesByGrove).
  const localByGrove = new Map<string, GroveProjectSummary[]>();
  const localProjectIds = new Set<string>();
  for (const grove of filtered) {
    const projects = listRegisteredProjects(grove.id, mycoHome, {
      includeArchived: options.includeArchived,
    })
      .map((project) => serializeProject(project, grove.id));
    localByGrove.set(grove.id, projects);
    for (const project of projects) localProjectIds.add(project.project_id);
  }

  // Attached projects, grouped by the LOCAL Grove each displays under. PURE
  // disk reads (host registry + local manifests) — no host is dialed, so a
  // down/unreachable host has no effect on this endpoint.
  const attachedByGrove = attachedProjectSummariesByGrove(mycoHome, localProjectIds, logger);

  const groves = filtered.map((grove) => {
    const local = localByGrove.get(grove.id) ?? [];
    const attached = attachedByGrove.get(grove.id) ?? [];
    const projects = [...local, ...attached];
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

const ATTACHED_EPOCH_ISO = new Date(0).toISOString();

/**
 * Attached projects grouped by the LOCAL Grove they display under (E-4
 * local-view requirement). The Grove is resolved by `resolveAttachRefHomeGroveId`
 * — the ref's `local_grove_id` when it still names an existing Grove, else the
 * machine default. A `null` home (no Groves at all — bootstrap-only) skips the
 * entry; there is nothing to display under and the Groves list is empty anyway.
 *
 * PURE LOCAL DISK READS: `readHostRegistry` plus each ref's local `project.toml`.
 * No host is dialed here, by construction — an unreachable host cannot affect
 * the Groves endpoint.
 */
function attachedProjectSummariesByGrove(
  mycoHome: string,
  localProjectIds: ReadonlySet<string>,
  logger?: GrovesLogger,
): Map<string, GroveProjectSummary[]> {
  const byGrove = new Map<string, GroveProjectSummary[]>();
  for (const host of readHostRegistry()) {
    for (const ref of host.projects) {
      // Never-materialize invariant: an attached project has no local Grove
      // row. If one exists anyway (a bug elsewhere), prefer the local row and
      // skip the attached copy rather than render the project twice.
      if (localProjectIds.has(ref.project_id)) {
        logger?.warn(
          LOG_KINDS.GROVES_ATTACHED_COLLISION,
          'Attached project also has a local Grove row — showing the local row, skipping the attached entry '
          + '(never-materialize invariant violated elsewhere)',
          { project_id: ref.project_id, host_id: host.host_id },
        );
        continue;
      }
      const homeGroveId = resolveAttachRefHomeGroveId(ref, mycoHome);
      if (!homeGroveId) continue;
      const summary = attachedProjectSummary(ref, host);
      const existing = byGrove.get(homeGroveId);
      if (existing) existing.push(summary);
      else byGrove.set(homeGroveId, [summary]);
    }
  }
  // Deterministic order within a section: attached entries carry no activity,
  // so sort by name then id (the switcher then floats active local projects
  // above them by recency; attached entries, activity 0, stay last).
  for (const list of byGrove.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name) || a.project_id.localeCompare(b.project_id));
  }
  return byGrove;
}

/**
 * Build a display-only summary for an attached project. Local-lifecycle fields
 * carry fail-closed neutral values (no binding, active, epoch timestamps,
 * `manifest_state: 'present'` so no local fix-it prompt); `capabilities` is
 * omitted (host-authoritative). The attach discriminator (`attached`/`host_id`/
 * `host_label`) marks the row for the UI.
 */
function attachedProjectSummary(ref: AttachRef, host: HostRecord): GroveProjectSummary {
  const name = attachedProjectName(ref);
  return {
    project_id: ref.project_id,
    name,
    // Same slugging as a local row (`projectUrlSlug`), so `findSelection` /
    // deep links resolve an attached entry identically. The project-id hash
    // suffix both stabilizes and disambiguates same-named projects.
    slug: projectUrlSlug(name, ref.project_id),
    root: ref.root ?? null,
    binding_id: null,
    status: 'active',
    archived_at: null,
    created_at: ATTACHED_EPOCH_ISO,
    updated_at: ATTACHED_EPOCH_ISO,
    manifest_state: 'present',
    attached: true,
    host_id: host.host_id,
    host_label: host.label,
  };
}

/**
 * Display name for an attached project: the local checkout's `project.toml`
 * name when the ref carries a readable root, else a deterministic name derived
 * from the project id (`proj_<32hex>` → `Project <first 8 hex>`) so a rootless
 * or corrupt-manifest ref still gets a stable, human label.
 */
function attachedProjectName(ref: AttachRef): string {
  if (ref.root) {
    try {
      const manifest = loadProjectManifest(resolveProjectVaultDir(ref.root));
      const name = manifest?.project?.name?.trim();
      if (name) return name;
    } catch {
      // Unreadable / corrupt manifest — fall through to the id-derived name.
    }
  }
  return `Project ${ref.project_id.replace(/^proj_/, '').slice(0, 8)}`;
}

/**
 * Resolve per-capability master-gate booleans for a project. Uses
 * `capabilityEnabled` as the single gate predicate — fail-closed: a
 * broken or unloadable vault yields capture-only (all false) rather than
 * all-true, so badges reflect the fail-closed runtime behavior.
 */
function resolveCapabilities(projectRoot: string, groveId: string): Record<CapabilityId, boolean> {
  const capIds = Object.keys(CAPABILITIES) as CapabilityId[];
  let config = null;
  try {
    const vaultDir = resolveProjectVaultDir(projectRoot);
    // A Team Host serving this project for a member has no local working
    // tree — degrade to machine+grove tiers (empty project tier) instead of
    // throwing "myco.yaml not found" (same signal + mechanism as `task-scheduling.ts`).
    // Without this, a served project's capabilities always render all-false
    // (the fail-closed catch below) instead of the machine+grove merge.
    const treeAvailable = projectTreeAvailable(vaultDir);
    config = loadMergedConfig(vaultDir, { groveId, projectTierOptional: !treeAvailable });
  } catch {
    // Unloadable config → capabilityEnabled(null, …) returns false (fail-closed).
  }
  return Object.fromEntries(
    capIds.map((id) => [id, capabilityEnabled(config, id)]),
  ) as Record<CapabilityId, boolean>;
}

function serializeProject(project: RegisteredProject, groveId: string): GroveProjectSummary {
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
    capabilities: resolveCapabilities(project.root, groveId),
  };
}

export function createArchiveProjectHandler(_daemonStateDir: string): RouteHandler {
  return async (req) => projectLifecycle(req.params.id, req.params.projectId, 'archive');
}

export function createUnarchiveProjectHandler(_daemonStateDir: string): RouteHandler {
  return async (req) => projectLifecycle(req.params.id, req.params.projectId, 'unarchive');
}

export function createDeleteProjectHandler(_daemonStateDir: string): RouteHandler {
  return async (req) => {
    const groveId = req.params.id;
    const projectId = req.params.projectId;
    const grove = loadGroveRecord(groveId);
    if (!grove) {
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
  action: 'archive' | 'unarchive',
) {
  const grove = loadGroveRecord(groveId);
  if (!grove) {
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

export function createCreateGroveHandler(_daemonStateDir: string): RouteHandler {
  return async (req) => {
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return { status: 400, body: errorBody('name_required', 'Grove name is required') };
    }
    try {
      const grove = createGrove(name, undefined);
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

export function createRenameGroveHandler(_daemonStateDir: string): RouteHandler {
  return async (req) => {
    const groveId = req.params.id;
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return { status: 400, body: errorBody('name_required', 'Grove name is required') };
    }
    const existing = loadGroveRecord(groveId);
    if (!existing) {
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

export function createDeleteGroveHandler(_daemonStateDir: string): RouteHandler {
  return async (req) => {
    const groveId = req.params.id;
    const existing = loadGroveRecord(groveId);
    if (!existing) {
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
      if (err instanceof DefaultGroveUndeletableError) {
        return { status: 409, body: errorBody('default_grove_undeletable', err.message) };
      }
      if (err instanceof LastGroveUndeletableError) {
        return { status: 409, body: errorBody('last_grove_undeletable', err.message) };
      }
      if (err instanceof ServedGroveUndeletableError) {
        return { status: 409, body: errorBody('served_grove_undeletable', err.message) };
      }
      return { status: 500, body: errorBody('delete_failed', (err as Error).message) };
    }
  };
}

export function createMoveProjectHandler(_daemonStateDir: string): RouteHandler {
  return async (req) => {
    const targetGroveId = req.params.id;
    const projectId = req.params.projectId;

    // `findRegisteredProject` walks only this daemon's home
    // (`<MYCO_HOME>/groves/`), so a foreign-home project is never found —
    // it is project_not_found from this daemon's perspective.
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

    const target = loadGroveRecord(targetGroveId);
    if (!target) {
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

export function createSetDefaultGroveHandler(_daemonStateDir: string): RouteHandler {
  return async (req) => {
    const groveId = req.params.id;
    const grove = loadGroveRecord(groveId);
    if (!grove) {
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
