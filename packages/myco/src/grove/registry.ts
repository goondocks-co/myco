import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { parse, stringify, type TomlTableWithoutBigInt } from 'smol-toml';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { isPlainTable } from '@myco/utils/is-plain-table.js';
import { createMtimeCache } from '@myco/utils/mtime-cache.js';
import { createGroveId, createProjectId, isGroveEraId } from './ids.js';
import { assertSafeProjectRoot, isSafeProjectRoot } from '../vault/resolve.js';
import {
  pathsEquivalent,
  resolveGlobalConfigPath,
  resolveGroveDir,
  resolveGroveMetadataPath,
  resolveProjectVaultDir,
  resolveGroveProjectsPath,
  resolveGroveRegistryDir,
  resolveGroveRegistryPath,
  resolveGroveRootsPath,
  resolveGrovesDir,
  resolveMycoHome,
} from './paths.js';
import { slugifyGroveName } from './ids.js';
import {
  findRegisteredProjectByBinding as findRegisteredProjectByBindingResolve,
  type RegistryResolvedProject,
} from './registry-resolve.js';
import { ensureProjectManifest, loadProjectManifest } from '../config/project-manifest.js';
import { loadMachineConfig } from '../config/loader.js';
import { resolveAttach, type AttachRef, type HostRecord } from '../host/registry.js';
import { isResidencyDivertActive, readResidencyJournal, residencyDirExists, residencyTransitionInFlight } from '../host/residency-journal.js';
import { noticeTeamHostHintOnce } from '../host/hint.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';

export interface GroveRecord {
  id: string;
  name: string;
  slug: string;
  mode: 'local';
  created_at: string;
}

export interface RegisteredProject {
  project_id: string;
  name: string;
  root: string;
  binding_id?: string;
  status: 'active' | 'archived';
  archived_at?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Per-project lifecycle gate persisted in the Grove's `projects.toml`.
 * Long-running ops (move, vacuum) take it; capture and the scheduler
 * refuse work for the project while it's set. File-based so a daemon
 * crash leaves the lock on disk — see `forceResumeProject` and the
 * startup orphan sweep for the recovery path.
 */
export interface PauseInfo {
  /** Epoch seconds when the pause was first claimed. */
  since: number;
  /** Operation class, e.g. `grove-move`, `vacuum`. Free-form short slug. */
  reason: string;
  /** Correlation id for the specific operation that owns this pause. */
  owner_op: string;
}

export type ProjectPauseStatus =
  | { paused: false }
  | { paused: true; reason: string; since: number; owner_op: string; grove_id: string };

export interface RegisterProjectInput {
  projectId: string;
  projectName: string;
  projectRoot: string;
  bindingId?: string;
}

export interface ListRegisteredProjectsOptions {
  includeArchived?: boolean;
}

export interface ResolvedRegisteredProject {
  grove: GroveRecord;
  project: RegisteredProject;
}

export interface FindRegisteredProjectInput {
  projectId: string;
  groveId?: string | null;
  bindingId?: string | null;
  projectRoot?: string | null;
}

/**
 * Shape of `~/.myco/groves/registry.yaml`. Holds the cross-Grove
 * pointer (`default_grove_id`) so the machine-tier `config.yaml` can
 * stay strict (no `.passthrough()`).
 */
interface GroveRegistryDoc {
  default_grove_id?: string;
  [key: string]: unknown;
}

/**
 * Legacy shape for `~/.myco/config.yaml`. Read once during migration to
 * pull `grove.default_grove_id` into the registry file.
 */
interface LegacyGlobalConfigDoc {
  grove?: {
    default_grove_id?: string;
  };
  [key: string]: unknown;
}

const groveDirEntriesCache = createMtimeCache((grovesDir: string): string[] => {
  if (!fs.existsSync(grovesDir)) return [];
  return fs.readdirSync(grovesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
});

const groveRecordCache = createMtimeCache((metadataPath: string): GroveRecord | null => {
  let content: string;
  try {
    content = fs.readFileSync(metadataPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const doc = parse(content) as TomlTableWithoutBigInt;
  const grove = isPlainTable(doc.grove) ? doc.grove as Record<string, unknown> : null;
  if (!grove) return null;
  if (typeof grove.id !== 'string' || typeof grove.name !== 'string' || typeof grove.slug !== 'string') return null;
  return {
    id: grove.id,
    name: grove.name,
    slug: grove.slug,
    mode: 'local',
    created_at: typeof grove.created_at === 'string' ? grove.created_at : new Date(0).toISOString(),
  };
});

const tomlDocCache = createMtimeCache((filePath: string): TomlTableWithoutBigInt => {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed = parse(content);
  return isPlainTable(parsed) ? parsed as TomlTableWithoutBigInt : {};
});

const groveRegistryCache = createMtimeCache((filePath: string): GroveRegistryDoc => {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed = YAML.parse(content) as unknown;
  return isPlainTable(parsed) ? parsed as GroveRegistryDoc : {};
});

const legacyGlobalConfigCache = createMtimeCache((filePath: string): LegacyGlobalConfigDoc => {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed = YAML.parse(content) as unknown;
  return isPlainTable(parsed) ? parsed as LegacyGlobalConfigDoc : {};
});

export function clearGroveRegistryCaches(): void {
  groveDirEntriesCache.clear();
  groveRecordCache.clear();
  tomlDocCache.clear();
  groveRegistryCache.clear();
  legacyGlobalConfigCache.clear();
}

export function listGroves(mycoHome = resolveMycoHome()): GroveRecord[] {
  return groveDirEntriesCache.get(resolveGrovesDir(mycoHome))
    .map((name) => loadGroveRecord(name, mycoHome))
    .filter((record): record is GroveRecord => !!record)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadGroveRecord(groveId: string, mycoHome = resolveMycoHome()): GroveRecord | null {
  // Treat structurally invalid ids the same as "Grove not found" so
  // callers (registry walks, status endpoints) can keep using `null`
  // as the not-found signal without each having to validate first.
  // The structural gate still applies on writes — `resolveGroveDir`
  // rejects malformed ids before any path is constructed.
  if (!isGroveEraId(groveId, 'grove')) return null;
  return groveRecordCache.get(resolveGroveMetadataPath(groveId, mycoHome));
}

/**
 * True when this daemon owns the Grove. Ownership is the home: a daemon
 * runs under one `MYCO_HOME` and only the Groves under
 * `<MYCO_HOME>/groves/` are its own. The predicate re-derives ownership
 * by a home-scoped lookup of the Grove's id — a record that lives in a
 * different home resolves to `null` here and reads as not-owned even if
 * it was loaded from disk elsewhere. On-demand seams — tool-call Grove
 * pivots and the daemon's inbound request resolution — gate cross-Grove
 * access through this before any database is opened or schema-migrated.
 */
export function groveOwnedByThisDaemon(
  grove: Pick<GroveRecord, 'id'>,
  mycoHome = resolveMycoHome(),
): boolean {
  return loadGroveRecord(grove.id, mycoHome) !== null;
}

/**
 * A request resolved to a Grove that lives in a different daemon's home
 * (`<MYCO_HOME>/groves/`). Thrown by daemon-side request resolution when
 * Grove-ownership enforcement is enabled; transports translate it into a
 * 403 `foreign_grove` error so the caller never reaches a database the
 * daemon does not own.
 */
export class ForeignGroveError extends Error {
  constructor(public readonly groveId: string) {
    super(`Grove ${groveId} is served by another daemon`);
    this.name = 'ForeignGroveError';
  }
}

/**
 * A caller named a Grove id that has no record on this machine. Thrown by
 * {@link assertOwnedGrove} so unknown (or junk) ids are refused before any
 * path under `groves/<id>/` is materialized; the daemon transport maps it
 * to a 404 `grove_not_found`.
 */
export class UnknownGroveError extends Error {
  constructor(public readonly groveId: string) {
    super(`Unknown Grove: ${groveId}`);
    this.name = 'UnknownGroveError';
  }
}

/**
 * Thrown by {@link deleteGrove} when the target is the current default
 * Grove. Reassign the default (`setDefaultGrove`) to another Grove first;
 * not bypassed by `force`. The daemon transport maps this to a 409
 * `default_grove_undeletable`.
 */
export class DefaultGroveUndeletableError extends Error {
  constructor(public readonly groveId: string) {
    super(`Grove ${groveId} is the default Grove; reassign the default Grove first`);
    this.name = 'DefaultGroveUndeletableError';
  }
}

/**
 * Thrown by {@link deleteGrove} when the target is the only Grove left in
 * the registry, regardless of what `getDefaultGroveId` reports. Not
 * bypassed by `force`. The daemon transport maps this to a 409
 * `last_grove_undeletable`.
 */
export class LastGroveUndeletableError extends Error {
  constructor(public readonly groveId: string) {
    super(`Grove ${groveId} is the only Grove; at least one Grove must remain`);
    this.name = 'LastGroveUndeletableError';
  }
}

/**
 * Thrown by {@link deleteGrove} when the target is this machine's designated
 * Team Host served Grove (`daemon.host_serve.served_grove_id`, machine
 * tier). Not bypassed by `force` — deleting the one Grove a Team Host serves
 * would silently strand every member's attach ref (server-mode design spec
 * §2: "Grove deletion refuses while the grove is the served grove"). Disable
 * Team Host serving first (`myco-team host disable`), which clears the
 * designation. The daemon transport maps this to a 409
 * `served_grove_undeletable`.
 */
export class ServedGroveUndeletableError extends Error {
  constructor(public readonly groveId: string) {
    super(`Grove ${groveId} is the Team Host served Grove; disable Team Host serving first`);
    this.name = 'ServedGroveUndeletableError';
  }
}

/**
 * Existence + ownership gate for caller-named Grove ids that arrive
 * OUTSIDE the request-context funnel (body `ActionScope.grove_id`, URL
 * `:id` params). Throws {@link UnknownGroveError} when no record exists —
 * so an unknown id can never create `groves/<id>/` as a side effect of a
 * DB open — and {@link ForeignGroveError} when the Grove lives in a
 * different daemon's home. Call it BEFORE any `cache.getDatabase` /
 * `resolveGroveDbPath` on the named Grove.
 */
export function assertOwnedGrove(groveId: string, mycoHome = resolveMycoHome()): GroveRecord {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new UnknownGroveError(groveId);
  return grove;
}

export interface CreateGroveOptions {}

export function createGrove(
  name: string,
  mycoHome = resolveMycoHome(),
  options: CreateGroveOptions = {},
): GroveRecord {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Grove name is required');
  const slug = slugifyGroveName(trimmed);
  const existing = listGroves(mycoHome).find((grove) => grove.slug === slug || grove.name === trimmed);
  if (existing) throw new Error(`Grove already exists: ${existing.name}`);

  const record: GroveRecord = {
    id: createGroveId(),
    name: trimmed,
    slug,
    mode: 'local',
    created_at: new Date().toISOString(),
  };
  writeGroveRecord(record, mycoHome);
  if (!getDefaultGroveId(mycoHome)) setDefaultGrove(record.id, mycoHome);
  return record;
}

/**
 * Ensure a Grove with `groveId` exists in the local registry, lazy-provisioning
 * it from the supplied fallback metadata when it doesn't. Used by activation
 * when a portable `project.toml` carries a `grove.id` that isn't yet
 * registered on this machine — checking out a project bound to another
 * Grove era id should "just work" instead of failing or silently minting a
 * new id. If the supplied slug collides with an existing different Grove,
 * the new Grove gets a numeric suffix and the suffixed slug is reflected
 * in the returned record.
 */
export function ensureGroveExistsLocally(
  groveId: string,
  fallback: { name: string; slug: string },
  mycoHome = resolveMycoHome(),
): GroveRecord {
  const existing = loadGroveRecord(groveId, mycoHome);
  if (existing) return existing;

  const trimmedName = fallback.name.trim();
  if (!trimmedName) throw new Error('Grove name is required');
  const requestedSlug = slugifyGroveName(fallback.slug || trimmedName);
  const slug = uniqueSlug(requestedSlug, mycoHome);

  const record: GroveRecord = {
    id: groveId,
    name: trimmedName,
    slug,
    mode: 'local',
    created_at: new Date().toISOString(),
  };
  writeGroveRecord(record, mycoHome);
  if (!getDefaultGroveId(mycoHome)) setDefaultGrove(record.id, mycoHome);
  return record;
}

function uniqueSlug(base: string, mycoHome: string): string {
  const taken = new Set(listGroves(mycoHome).map((grove) => grove.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate unique Grove slug from base ${base}`);
}

/**
 * Ensure a default Grove exists for this home.
 *
 * Each MYCO_HOME has its own `groves/` tree, so the default Grove is
 * always slug `default` — there is no cross-variant collision to avoid.
 *
 * Called from `runGlobalBootstrap()` — fires at daemon first-start so
 * the default Grove is guaranteed to exist before any hook tries to
 * register a project into it. Idempotent: an existing default Grove is
 * returned unchanged.
 */
export function ensureDefaultGrove(mycoHome = resolveMycoHome()): GroveRecord {
  const slug = 'default';

  // 1. Honor an explicit default pointer when it exists.
  //    Users can `setDefaultGrove(non-default-slug)` and have that decision
  //    survive across daemon restarts.
  const pointedId = getDefaultGroveId(mycoHome);
  if (pointedId) {
    const pointed = loadGroveRecord(pointedId, mycoHome);
    if (pointed) return pointed;
  }

  // 2. No pointer (or it names a missing Grove) — look for an existing
  //    Grove by the canonical slug.
  const matching = listGroves(mycoHome).find((grove) => grove.slug === slug);
  if (matching) {
    if (!pointedId) setDefaultGrove(matching.id, mycoHome);
    return matching;
  }

  // 3. No matching Grove yet — create it.
  const created = createGrove(slug, mycoHome);
  if (!pointedId) setDefaultGrove(created.id, mycoHome);
  return created;
}

/**
 * Read-only default-Grove lookup. Sister of `ensureDefaultGrove`: no
 * side effects, returns null when no matching Grove exists.
 *
 * Used by `ensureProjectRegistered` and any other code path that needs
 * to find the default Grove without creating one. Honors the pointer
 * — honors the pointer then falls back to the canonical slug lookup (`default`).
 */
export function resolveDefaultGrove(
  mycoHome = resolveMycoHome(),
): GroveRecord | null {
  const pointedId = getDefaultGroveId(mycoHome);
  if (pointedId) {
    const pointed = loadGroveRecord(pointedId, mycoHome);
    if (pointed) return pointed;
  }
  return listGroves(mycoHome).find((g) => g.slug === 'default') ?? null;
}

export function resolveGrove(ref: string | undefined, mycoHome = resolveMycoHome()): GroveRecord {
  if (!ref) return ensureDefaultGrove(mycoHome);
  const matches = listGroves(mycoHome).filter((grove) =>
    grove.id === ref || grove.slug === slugifyGroveName(ref) || grove.name === ref,
  );
  if (matches.length === 0) throw new Error(`Unknown Grove: ${ref}`);
  if (matches.length > 1) throw new Error(`Ambiguous Grove: ${ref}`);
  return matches[0];
}

export function getDefaultGroveId(mycoHome = resolveMycoHome()): string | null {
  // Preferred home: ~/.myco/groves/registry.yaml.
  const doc = readGroveRegistry(mycoHome);
  if (typeof doc.default_grove_id === 'string') return doc.default_grove_id;

  // Legacy home: ~/.myco/config.yaml had a `grove:` block. If we still
  // have a value there, surface it AND auto-migrate it to the new file
  // so subsequent reads hit the preferred home and the next config
  // write strips the legacy block.
  const legacy = readLegacyGlobalConfig(mycoHome);
  const legacyId = legacy.grove?.default_grove_id;
  if (typeof legacyId === 'string') {
    writeGroveRegistry(mycoHome, { ...doc, default_grove_id: legacyId });
    return legacyId;
  }
  return null;
}

export function setDefaultGrove(ref: string, mycoHome = resolveMycoHome()): GroveRecord {
  const grove = resolveGroveByIdOrName(ref, mycoHome);
  const doc = readGroveRegistry(mycoHome);
  writeGroveRegistry(mycoHome, { ...doc, default_grove_id: grove.id });
  return grove;
}

export function registerProjectInGrove(
  groveId: string,
  input: RegisterProjectInput,
  mycoHome = resolveMycoHome(),
): RegisteredProject {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new Error(`Unknown Grove: ${groveId}`);

  // Defense in depth: even if a CLI / MCP caller skipped the same check,
  // refuse to register $HOME / `/` / a likely-home-dir as a project root.
  // See `assertSafeProjectRoot` for the rationale.
  assertSafeProjectRoot(input.projectRoot);

  const root = path.resolve(input.projectRoot);
  const now = new Date().toISOString();
  const projectsDoc = readToml(resolveGroveProjectsPath(grove.id, mycoHome));
  const projects = isPlainTable(projectsDoc.projects) ? projectsDoc.projects as Record<string, unknown> : {};
  const existing = isPlainTable(projects[input.projectId])
    ? projects[input.projectId] as Record<string, unknown>
    : {};
  const createdAt = typeof existing.created_at === 'string' ? existing.created_at : now;

  const row: RegisteredProject = {
    project_id: input.projectId,
    name: input.projectName,
    root,
    ...(input.bindingId ? { binding_id: input.bindingId } : {}),
    status: 'active',
    created_at: createdAt,
    updated_at: now,
  };

  projectsDoc.projects = {
    ...projects,
    [input.projectId]: row as unknown as TomlTableWithoutBigInt,
  } as unknown as TomlTableWithoutBigInt;
  writeToml(resolveGroveProjectsPath(grove.id, mycoHome), projectsDoc);

  const rootsDoc = readToml(resolveGroveRootsPath(grove.id, mycoHome));
  rootsDoc.roots = {
    ...(isPlainTable(rootsDoc.roots) ? rootsDoc.roots as Record<string, unknown> : {}),
    [root]: input.projectId,
  } as unknown as TomlTableWithoutBigInt;
  writeToml(resolveGroveRootsPath(grove.id, mycoHome), rootsDoc);

  return row;
}

export function listRegisteredProjects(
  groveId: string,
  mycoHome = resolveMycoHome(),
  options: ListRegisteredProjectsOptions = {},
): RegisteredProject[] {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) return [];
  const projectsDoc = readToml(resolveGroveProjectsPath(grove.id, mycoHome));
  const projects = isPlainTable(projectsDoc.projects) ? projectsDoc.projects as Record<string, unknown> : {};
  return Object.values(projects)
    .filter(isPlainTable)
    .map((row) => normalizeRegisteredProject(row as Record<string, unknown>))
    .filter((row): row is RegisteredProject => !!row)
    .filter((row) => options.includeArchived || row.status !== 'archived');
}

export function archiveProjectInGrove(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): RegisteredProject {
  return updateProjectLifecycle(groveId, projectId, 'archived', mycoHome);
}

export function unarchiveProjectInGrove(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): RegisteredProject {
  return updateProjectLifecycle(groveId, projectId, 'active', mycoHome);
}

function updateProjectLifecycle(
  groveId: string,
  projectId: string,
  status: RegisteredProject['status'],
  mycoHome: string,
): RegisteredProject {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new Error(`Unknown Grove: ${groveId}`);

  const projectsPath = resolveGroveProjectsPath(grove.id, mycoHome);
  const projectsDoc = readToml(projectsPath);
  const projects = isPlainTable(projectsDoc.projects)
    ? projectsDoc.projects as Record<string, unknown>
    : {};
  const raw = isPlainTable(projects[projectId])
    ? { ...(projects[projectId] as Record<string, unknown>) }
    : null;
  if (!raw) throw new Error(`Project ${projectId} is not registered in Grove ${groveId}`);

  const now = new Date().toISOString();
  raw.status = status;
  raw.updated_at = now;
  if (status === 'archived') raw.archived_at = now;
  else delete raw.archived_at;

  projectsDoc.projects = {
    ...projects,
    [projectId]: raw as TomlTableWithoutBigInt,
  } as unknown as TomlTableWithoutBigInt;
  writeToml(projectsPath, projectsDoc);

  const normalized = normalizeRegisteredProject(raw);
  if (!normalized) throw new Error(`Project ${projectId} registry row is invalid after lifecycle update`);
  return normalized;
}

export function listAllRegisteredProjects(
  groveId: string,
  mycoHome = resolveMycoHome(),
): RegisteredProject[] {
  return listRegisteredProjects(groveId, mycoHome, { includeArchived: true });
}

export function getRegisteredProjectInGrove(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
  options: ListRegisteredProjectsOptions = {},
): RegisteredProject | null {
  const projectsDoc = readToml(resolveGroveProjectsPath(groveId, mycoHome));
  const projects = isPlainTable(projectsDoc.projects) ? projectsDoc.projects as Record<string, unknown> : {};
  const row = isPlainTable(projects[projectId])
    ? normalizeRegisteredProject(projects[projectId] as Record<string, unknown>)
    : null;
  if (row?.status === 'archived' && !options.includeArchived) return null;
  return row;
}

export function findRegisteredProject(
  input: FindRegisteredProjectInput,
  mycoHome = resolveMycoHome(),
): ResolvedRegisteredProject | null {
  const projectRoot = input.projectRoot ?? null;
  const groves = input.groveId
    ? [loadGroveRecord(input.groveId, mycoHome)].filter((grove): grove is GroveRecord => !!grove)
    : listGroves(mycoHome);

  for (const grove of groves) {
    const project = getRegisteredProjectInGrove(grove.id, input.projectId, mycoHome);
    if (!project) continue;
    if (input.bindingId && project.binding_id && project.binding_id !== input.bindingId) continue;
    // pathsEquivalent uses inode comparison so case differences on macOS
    // APFS (e.g. registered `~/repos/x` vs daemon-resolved `~/Repos/x`)
    // and symlink chains both compare equal. Bare `path.resolve` would
    // miss case differences and silently return null → daemon falls back
    // to legacy mode → divergent database created.
    if (projectRoot && !pathsEquivalent(project.root, projectRoot)) continue;
    return { grove, project };
  }

  return null;
}

/**
 * Locate a registered project by its filesystem root, across every Grove
 * known to the local registry. Returns the owning Grove + project record
 * when found, or null if the root isn't registered anywhere.
 *
 * Used by the capture path (and any other surface that knows the project's
 * disk location but not its Grove/project IDs) to resolve the global buffer
 * dir without forcing the caller to walk the Grove tree by hand. Comparison
 * goes through `pathsEquivalent` (inode-aware) so macOS APFS case-only diffs
 * and symlink chains both compare equal.
 */
/**
 * If the checkout at `projectRoot` names a project (via its
 * `.myco/project.toml` manifest id) that is attached to a remote host, return
 * that host and the attach ref. Pure disk reads — the project manifest plus
 * the machine-global host registry — so it is safe to call from the client
 * process (hook/tool) and the daemon alike, before any Grove/DB resolution.
 *
 * The Team Host never-materialize invariant hangs off this: every path that
 * would otherwise write local Grove state for the project
 * (`ensureProjectRegistered`, the capture buffer fallback, the CLI migration
 * gate) consults it first and refuses to materialize a local Grove for an
 * attached project.
 */
export function resolveAttachForProjectRoot(
  projectRoot: string,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): { host: HostRecord; ref: AttachRef } | null {
  const manifest = loadProjectManifest(resolveProjectVaultDir(projectRoot));
  const projectId = manifest?.project.id;
  if (!projectId || !isGroveEraId(projectId, 'project')) return null;
  return resolveAttach(projectId, lockNamespace);
}

/**
 * The shared never-materialize gate for registration vectors BEYOND the hook
 * path (`myco init`/activation, the legacy importer, the binding-repair
 * re-register): a local Grove row must not be minted for a project that is
 * already attached to a host (F-3 latent hole — a repair/init re-register of a
 * settled attached project, no transition even in flight) or mid-residency
 * transition. Keyed on the project id alone — both an attach ref and a residency
 * journal are resolvable from it — so a caller with the id can gate before it
 * writes. `ensureProjectRegistered` already inlines both checks for the hot hook
 * path; this is the same policy for the colder vectors.
 */
export function isLocalRegistrationSuppressed(
  projectId: string,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): boolean {
  return residencyTransitionInFlight(projectId)
    || resolveAttach(projectId, lockNamespace) !== null;
}

/**
 * Resolve the LOCAL Grove an attach ref should display under (E-4
 * local-view requirement, decision-ef693c71). Prefers `ref.local_grove_id`
 * when it still names an existing local Grove; falls back to the machine's
 * current default Grove otherwise — covering both a legacy ref (recorded
 * before `local_grove_id` existed) and a dangling one (the chosen Grove was
 * deleted after attach). Pure read: never calls `ensureDefaultGrove` or any
 * other write path, so resolving a ref never has a side effect on the local
 * registry — even when the machine has no Groves at all yet, in which case
 * this returns `null` rather than creating one.
 *
 * Lives here (not `host/registry.ts`, alongside `AttachRef`) because it
 * needs `loadGroveRecord`/`resolveDefaultGrove`, and `host/registry.ts` must
 * stay free of a dependency on this module — this module already imports
 * `host/registry.ts` for {@link resolveAttach}, so the reverse edge would
 * cycle.
 *
 * DISPLAY-ONLY: this never resolves capability config, capture routing, or
 * any other tenancy decision — those stay keyed on `ref.grove_id` (the
 * host's served Grove). Exported for the Groves-page merge to group an
 * attached project's card under the same local Grove this resolves.
 */
export function resolveAttachRefHomeGroveId(
  ref: Pick<AttachRef, 'local_grove_id'>,
  mycoHome = resolveMycoHome(),
): string | null {
  if (ref.local_grove_id && loadGroveRecord(ref.local_grove_id, mycoHome)) {
    return ref.local_grove_id;
  }
  return resolveDefaultGrove(mycoHome)?.id ?? null;
}

/**
 * Synthesize the tenancy an attached project resolves to WITHOUT registering
 * it locally. The real Grove/project records live on the host; this carrier
 * exists only so `ensureProjectRegistered`'s callers see the
 * `{ grove_id, project_id }` pair they read instead of a null. It is never
 * persisted or iterated — no local Grove dir, registry row, roots entry, or
 * DB is created — and the display fields are placeholders because the
 * authoritative record is host-owned.
 */
function attachedRegistration(
  ref: AttachRef,
  projectRoot: string,
): ResolvedRegisteredProject {
  const epoch = new Date(0).toISOString();
  const root = path.resolve(projectRoot);
  return {
    grove: {
      id: ref.grove_id,
      name: ref.grove_id,
      slug: ref.grove_id,
      mode: 'local',
      created_at: epoch,
    },
    project: {
      project_id: ref.project_id,
      name: path.basename(root),
      root,
      status: 'active',
      created_at: epoch,
      updated_at: epoch,
    },
  };
}

/**
 * Synthesize the tenancy capture must DIVERT to while a residency transition is
 * in flight for the checkout at `projectRoot` — the journal's destination
 * `(divert_grove_id, project_id)`, exactly the shape {@link attachedRegistration}
 * gives a settled attach. NO local Grove row is minted or read: the journal is
 * authoritative for the window. Short-circuits on the residency-dir stat so the
 * common no-transition path pays only one `existsSync`. Client-process-safe —
 * pure fs, called on every capture request.
 */
function resolveResidencyDivert(projectRoot: string): ResolvedRegisteredProject | null {
  if (!residencyDirExists()) return null;
  const manifest = loadProjectManifest(resolveProjectVaultDir(projectRoot));
  const projectId = manifest?.project.id;
  if (!projectId || !isGroveEraId(projectId, 'project')) return null;
  const journal = readResidencyJournal(projectId);
  // Divert only during the data-in-motion window: once a detach reaches
  // `rehoming` the flip is done and the local Grove is live, so new capture must
  // resolve there, not keep landing in the host-Grove buffer the sweep is draining.
  if (!journal || !isResidencyDivertActive(journal.phase)) return null;
  const epoch = new Date(0).toISOString();
  const root = path.resolve(projectRoot);
  return {
    grove: {
      id: journal.divert_grove_id,
      name: journal.divert_grove_id,
      slug: journal.divert_grove_id,
      mode: 'local',
      created_at: epoch,
    },
    project: {
      project_id: journal.project_id,
      name: journal.project_name || path.basename(root),
      root,
      status: 'active',
      created_at: epoch,
      updated_at: epoch,
    },
  };
}

/**
 * Auto-register a project under the machine default Grove when the
 * hook layer fires from a real project root that isn't yet known.
 *
 * Returns the resolved registration so callers (event-dispatch in
 * particular) can move straight to writing events without an extra
 * registry walk. Idempotent: an already-registered project returns the
 * existing record.
 *
 * Refuses to register when:
 *   - the project is attached to a remote host; returns the attach tenancy
 *     WITHOUT writing any local Grove state (Team Host never-materialize
 *     invariant).
 *   - the path fails `isSafeProjectRoot` (cwd-fallback paths from a
 *     misfired hook, $HOME-rooted invocations, etc.); returns `null`.
 *   - the machine has no default Grove yet (extremely early bootstrap);
 *     returns `null`.
 *
 * Decision 2 of the plan: silent register, no prompt — discovery via
 * the Groves page in the UI. Per Decision 3, the default Grove is the
 * owner. One narrow exception: a project whose manifest carries a Team
 * Host affiliation hint (`grove.remote`, see `host/hint.ts`) gets a
 * one-time stderr notice on the registration that would otherwise
 * silently give a hosted-in-name project a local Grove row — it does
 * NOT block the registration or change its outcome, only its visibility.
 */
export function ensureProjectRegistered(
  projectRoot: string,
  mycoHome = resolveMycoHome(),
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): ResolvedRegisteredProject | null {
  // Residency-transition divert (Phase F): while a project is mid-move to or
  // from a host, capture must resolve to the journal's destination tenancy, not
  // a local Grove row — a dropped event or a re-minted local row here breaks the
  // migration. This wins over both the local registry row (still present until
  // it is parked) and a not-yet-written attach ref, so it runs first.
  const residencyDivert = resolveResidencyDivert(projectRoot);
  if (residencyDivert) return residencyDivert;

  const existing = findProjectByRoot(projectRoot, mycoHome, { includeArchived: true });
  if (existing?.project.status === 'archived') return null;
  if (existing) return existing;

  // Team Host never-materialize invariant: an attached project's Grove lives
  // on the host, so this checkout must never grow a local Grove registry row.
  // Both client-process callers — DaemonClient.requestHeaders (every request)
  // and the hook buffer fallback via resolveProjectBufferDirFromRoot — funnel
  // through here, so this one gate closes both auto-registration vectors
  // before any local write. It runs before isSafeProjectRoot's git probe so
  // the hosted hot path never pays for a subprocess it would never register
  // from.
  const attach = resolveAttachForProjectRoot(projectRoot, lockNamespace);
  if (attach) return attachedRegistration(attach.ref, projectRoot);

  if (!isSafeProjectRoot(projectRoot)) return null;

  // Each MYCO_HOME owns its own grove tree — look up the default Grove
  // directly by pointer or canonical slug.
  const grove = resolveDefaultGrove(mycoHome);
  if (!grove) return null;

  const projectName = path.basename(path.resolve(projectRoot));
  let manifest = loadProjectManifest(resolveProjectVaultDir(projectRoot));
  // Team Host affiliation hint (prompt-only, see host/hint.ts): `attach` was
  // already confirmed null above, so a project whose manifest carries a
  // `grove.remote` hint is about to get a LOCAL Grove row here despite being
  // meant for a host. This branch runs at most once per project on this
  // machine — every later call finds `existing` above and never reaches
  // here — so the notice is naturally once-ever, not once-per-hook-call.
  noticeTeamHostHintOnce(manifest, manifest?.project.id, lockNamespace);
  if (manifest && !manifest.grove?.binding_id) {
    manifest = ensureProjectManifest(resolveProjectVaultDir(projectRoot), {
      projectName,
      groveId: grove.id,
      groveSlug: grove.slug,
      groveName: grove.name,
    });
  }
  const projectId = manifest?.project.id && isGroveEraId(manifest.project.id, 'project')
    ? manifest.project.id
    : createProjectId();
  registerProjectInGrove(grove.id, {
    projectId,
    projectName,
    projectRoot,
    bindingId: manifest?.grove?.binding_id,
  }, mycoHome);
  return findProjectByRoot(projectRoot, mycoHome);
}

export function findProjectByRoot(
  projectRoot: string,
  mycoHome = resolveMycoHome(),
  options: ListRegisteredProjectsOptions = {},
): ResolvedRegisteredProject | null {
  if (!projectRoot) return null;
  for (const grove of listGroves(mycoHome)) {
    for (const project of listRegisteredProjects(grove.id, mycoHome, options)) {
      if (pathsEquivalent(project.root, projectRoot)) {
        return { grove, project };
      }
    }
  }
  return null;
}

export function projectLifecycleForRoot(
  projectRoot: string,
  mycoHome = resolveMycoHome(),
): 'active' | 'archived' | 'unregistered' {
  const found = findProjectByRoot(projectRoot, mycoHome, { includeArchived: true });
  if (!found) return 'unregistered';
  return found.project.status === 'archived' ? 'archived' : 'active';
}

export function findRegisteredProjectByBinding(
  bindingId: string,
  mycoHome = resolveMycoHome(),
): ResolvedRegisteredProject | null {
  // Delegates to the cycle-safe seam in `registry-resolve.ts`. The shape
  // matches `ResolvedRegisteredProject` field-for-field; the cast is the
  // boundary between the cached registry surface here and the
  // dependency-light loader the manifest layer uses.
  const result = findRegisteredProjectByBindingResolve(bindingId, mycoHome);
  return result as RegistryResolvedProject as ResolvedRegisteredProject | null;
}

/**
 * Mark a project as paused. Idempotent for the same `ownerOp` (refreshes
 * `since` and returns); throws when a different op already holds the lock.
 */
export function pauseProject(
  groveId: string,
  projectId: string,
  reason: string,
  ownerOp: string,
  mycoHome = resolveMycoHome(),
): void {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new Error(`Unknown Grove: ${groveId}`);
  if (!reason.trim()) throw new Error('pauseProject requires a non-empty reason');
  if (!ownerOp.trim()) throw new Error('pauseProject requires a non-empty owner_op');

  const projectsPath = resolveGroveProjectsPath(grove.id, mycoHome);
  const projectsDoc = readToml(projectsPath);
  const projects = isPlainTable(projectsDoc.projects)
    ? projectsDoc.projects as Record<string, unknown>
    : {};
  const entry = isPlainTable(projects[projectId])
    ? { ...(projects[projectId] as Record<string, unknown>) }
    : null;
  if (!entry) {
    throw new Error(`Project ${projectId} is not registered in Grove ${groveId}`);
  }

  const existingPause = readPauseBlock(entry);
  if (existingPause && existingPause.owner_op !== ownerOp) {
    throw new Error(
      `Project ${projectId} is already paused by ${existingPause.owner_op} `
      + `(reason=${existingPause.reason}); cannot re-pause as ${ownerOp}`,
    );
  }

  // Refresh `since` for retries with the same owner so `forceResume`
  // staleness windows reflect the most recent attempt.
  const since = Math.floor(Date.now() / 1000);

  entry.paused = {
    since,
    reason,
    owner_op: ownerOp,
  } as unknown as TomlTableWithoutBigInt;

  projectsDoc.projects = {
    ...projects,
    [projectId]: entry as unknown as TomlTableWithoutBigInt,
  } as unknown as TomlTableWithoutBigInt;
  writeToml(projectsPath, projectsDoc);
}

/**
 * Clear a project's pause when `ownerOp` matches the lock holder.
 * Idempotent on an unpaused project; throws if a different op holds the lock.
 */
export function resumeProject(
  groveId: string,
  projectId: string,
  ownerOp: string,
  mycoHome = resolveMycoHome(),
): void {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new Error(`Unknown Grove: ${groveId}`);

  const projectsPath = resolveGroveProjectsPath(grove.id, mycoHome);
  const projectsDoc = readToml(projectsPath);
  const projects = isPlainTable(projectsDoc.projects)
    ? projectsDoc.projects as Record<string, unknown>
    : {};
  const entry = isPlainTable(projects[projectId])
    ? { ...(projects[projectId] as Record<string, unknown>) }
    : null;
  if (!entry) return;

  const existingPause = readPauseBlock(entry);
  if (!existingPause) return;
  if (existingPause.owner_op !== ownerOp) {
    throw new Error(
      `Project ${projectId} is paused by ${existingPause.owner_op}; `
      + `cannot resume as ${ownerOp}`,
    );
  }

  delete entry.paused;
  projectsDoc.projects = {
    ...projects,
    [projectId]: entry as unknown as TomlTableWithoutBigInt,
  } as unknown as TomlTableWithoutBigInt;
  writeToml(projectsPath, projectsDoc);
}

/**
 * Force-resume a project, bypassing the owner_op check. Used by the
 * startup health sweep to clear orphan pauses.
 *
 * No-op when the project isn't registered (consistent with
 * `resumeProject`'s no-op-on-unpaused behavior).
 */
export function forceResumeProject(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): void {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new Error(`Unknown Grove: ${groveId}`);

  const projectsPath = resolveGroveProjectsPath(grove.id, mycoHome);
  const projectsDoc = readToml(projectsPath);
  const projects = isPlainTable(projectsDoc.projects)
    ? projectsDoc.projects as Record<string, unknown>
    : {};
  const entry = isPlainTable(projects[projectId])
    ? { ...(projects[projectId] as Record<string, unknown>) }
    : null;
  if (!entry) return;

  if (!readPauseBlock(entry)) return;
  delete entry.paused;
  projectsDoc.projects = {
    ...projects,
    [projectId]: entry as unknown as TomlTableWithoutBigInt,
  } as unknown as TomlTableWithoutBigInt;
  writeToml(projectsPath, projectsDoc);
}

/**
 * Cross-Grove lookup: find the pause state for a project by id alone.
 * Returns `{ paused: false }` for unknown projects so call sites at the
 * write/scheduler boundary can fail closed without a separate "registered?"
 * check.
 */
export function isProjectPaused(
  projectId: string,
  mycoHome = resolveMycoHome(),
): ProjectPauseStatus {
  // Scans every Grove: during a move, the project is registered in both
  // source and target for a brief window. Returning at first-hit would let
  // an alphabetically-first unpaused Grove mask a paused entry elsewhere.
  for (const grove of listGroves(mycoHome)) {
    const status = isProjectPausedInGrove(grove.id, projectId, mycoHome);
    if (status.paused) return status;
  }
  return { paused: false };
}

/**
 * Per-Grove pause lookup. Cheaper than `isProjectPaused` when the caller
 * already knows the Grove (e.g. scope iteration) — skips the M×N
 * cross-Grove scan.
 */
export function isProjectPausedInGrove(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): ProjectPauseStatus {
  const projectsDoc = readToml(resolveGroveProjectsPath(groveId, mycoHome));
  const projects = isPlainTable(projectsDoc.projects)
    ? projectsDoc.projects as Record<string, unknown>
    : {};
  const entry = isPlainTable(projects[projectId])
    ? projects[projectId] as Record<string, unknown>
    : null;
  if (!entry) return { paused: false };
  const pause = readPauseBlock(entry);
  if (!pause) return { paused: false };
  return {
    paused: true,
    reason: pause.reason,
    since: pause.since,
    owner_op: pause.owner_op,
    grove_id: groveId,
  };
}

/**
 * Predicate factory for scope iteration: returns `true` when the given
 * scope's project is not paused in its bound Grove.
 */
export function pauseAwareShouldVisit(
  mycoHome = resolveMycoHome(),
): (scope: { projectId: string; grove: { id: string } }) => boolean {
  return (scope) => !isProjectPausedInGrove(scope.grove.id, scope.projectId, mycoHome).paused;
}

/**
 * Remove the project entry from a Grove's `projects.toml`. Throws when
 * the project isn't bound to that Grove — silent no-op would mask move
 * orchestrator bugs that re-deregister an already-detached project.
 *
 * `force: true` — idempotent on a missing entry. Required for the
 * move-orchestrator resume path so a second pass after the source
 * deregister doesn't throw.
 */
export function deregisterProjectInGrove(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
  opts: { force?: boolean } = {},
): void {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new Error(`Unknown Grove: ${groveId}`);

  const projectsPath = resolveGroveProjectsPath(grove.id, mycoHome);
  const projectsDoc = readToml(projectsPath);
  const projects = isPlainTable(projectsDoc.projects)
    ? { ...(projectsDoc.projects as Record<string, unknown>) }
    : {};
  if (!isPlainTable(projects[projectId])) {
    if (opts.force) return;
    throw new Error(`Project ${projectId} is not registered in Grove ${groveId}`);
  }
  const entry = projects[projectId] as Record<string, unknown>;
  const root = typeof entry.root === 'string' ? entry.root : null;
  delete projects[projectId];
  projectsDoc.projects = projects as unknown as TomlTableWithoutBigInt;
  writeToml(projectsPath, projectsDoc);

  if (root) {
    const rootsPath = resolveGroveRootsPath(grove.id, mycoHome);
    const rootsDoc = readToml(rootsPath);
    const roots = isPlainTable(rootsDoc.roots)
      ? { ...(rootsDoc.roots as Record<string, unknown>) }
      : {};
    if (roots[root] === projectId) {
      delete roots[root];
      rootsDoc.roots = roots as unknown as TomlTableWithoutBigInt;
      writeToml(rootsPath, rootsDoc);
    }
  }
}

/**
 * Rename a Grove. Recomputes its slug; if the new slug collides with a
 * different existing Grove, auto-suffixes (`-2`, `-3`, ...). When the
 * slug changes, moves the on-disk Grove directory from
 * `~/.myco/groves/<old-slug>/` to `~/.myco/groves/<new-slug>/` so the
 * SQLite + vectors files (resolved relative to the Grove dir) follow.
 *
 * Returns the updated `GroveRecord`, including the (possibly suffixed)
 * slug.
 */
export function renameGrove(
  groveId: string,
  newName: string,
  mycoHome = resolveMycoHome(),
): GroveRecord {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('Grove name is required');

  const existing = loadGroveRecord(groveId, mycoHome);
  if (!existing) throw new Error(`Unknown Grove: ${groveId}`);

  const requestedSlug = slugifyGroveName(trimmed);
  let nextSlug = requestedSlug;
  if (nextSlug !== existing.slug) {
    const taken = new Set(
      listGroves(mycoHome)
        .filter((grove) => grove.id !== groveId)
        .map((grove) => grove.slug),
    );
    if (taken.has(nextSlug)) {
      let i = 2;
      while (taken.has(`${requestedSlug}-${i}`)) {
        i++;
        if (i >= 1000) {
          throw new Error(`Unable to allocate unique Grove slug from base ${requestedSlug}`);
        }
      }
      nextSlug = `${requestedSlug}-${i}`;
    }
  }

  const updated: GroveRecord = {
    ...existing,
    name: trimmed,
    slug: nextSlug,
  };

  // Persist the metadata file in place. Grove dirs are addressed by
  // `groveId` (not slug) on disk, so renaming the directory is not
  // required for path resolvers — but we keep slug semantics on the
  // `GroveRecord` so callers projecting URL / display slugs see the
  // refreshed value.
  writeGroveRecord(updated, mycoHome);
  return updated;
}

/**
 * Tear down a Grove. Refuses when projects remain bound to it unless
 * `force: true` is passed — moves are the supported path for project
 * relocation, not a "smart" delete.
 *
 * Three additional refusals run before the bound-projects guard and are
 * never bypassed by `force`:
 *   1. Deleting the current default Grove throws
 *      {@link DefaultGroveUndeletableError}.
 *   2. Deleting the last remaining Grove throws
 *      {@link LastGroveUndeletableError}.
 *   3. Deleting this machine's Team Host served Grove throws
 *      {@link ServedGroveUndeletableError}.
 *
 * On success: removes `~/.myco/groves/<groveId>/` (metadata, registry,
 * SQLite, vectors). Clears the cross-Grove default pointer if the deleted
 * Grove was the default.
 *
 * `force: true` discards any per-project pause state on bound projects
 * along with the rest of the Grove dir — pauses live in the Grove's
 * `projects.toml`, which is removed with the directory. `force` bypasses
 * only the bound-projects guard; never the default-Grove or last-Grove
 * refusals.
 */
export function deleteGrove(
  groveId: string,
  opts: { force?: boolean } = {},
  mycoHome = resolveMycoHome(),
): void {
  const existing = loadGroveRecord(groveId, mycoHome);
  if (!existing) throw new Error(`Unknown Grove: ${groveId}`);

  if (getDefaultGroveId(mycoHome) === groveId) {
    throw new DefaultGroveUndeletableError(groveId);
  }

  if (listGroves(mycoHome).length === 1) {
    throw new LastGroveUndeletableError(groveId);
  }

  // Every deletion path (CLI, daemon API, any future lifecycle caller) flows
  // through this one function — the single chokepoint for the guard, never
  // duplicated in a caller. `served_grove_id` is machine tier, independent
  // of which project vault (if any) is asking.
  if (loadMachineConfig(mycoHome).daemon.host_serve.served_grove_id === groveId) {
    throw new ServedGroveUndeletableError(groveId);
  }

  const projects = listRegisteredProjects(groveId, mycoHome);
  if (projects.length > 0 && !opts.force) {
    throw new Error(
      `Grove ${groveId} still has ${projects.length} bound project(s); pass force: true to delete`,
    );
  }

  const groveDir = resolveGroveDir(groveId, mycoHome);
  fs.rmSync(groveDir, { recursive: true, force: true });

  const defaultId = getDefaultGroveId(mycoHome);
  if (defaultId === groveId) {
    const doc = readGroveRegistry(mycoHome);
    const next: GroveRegistryDoc = { ...doc };
    delete next.default_grove_id;
    writeGroveRegistry(mycoHome, next);
  }

  // Drop any cached entries that referenced files under the deleted dir
  // so subsequent reads don't return stale records.
  clearGroveRegistryCaches();
}

function readPauseBlock(entry: Record<string, unknown>): PauseInfo | null {
  const raw = entry.paused;
  if (!isPlainTable(raw)) return null;
  const block = raw as Record<string, unknown>;
  if (
    typeof block.since !== 'number'
    || typeof block.reason !== 'string'
    || typeof block.owner_op !== 'string'
  ) {
    return null;
  }
  return {
    since: block.since,
    reason: block.reason,
    owner_op: block.owner_op,
  };
}

function resolveGroveByIdOrName(ref: string, mycoHome: string): GroveRecord {
  const matches = listGroves(mycoHome).filter((grove) =>
    grove.id === ref || grove.slug === slugifyGroveName(ref) || grove.name === ref,
  );
  if (matches.length === 0) throw new Error(`Unknown Grove: ${ref}`);
  if (matches.length > 1) throw new Error(`Ambiguous Grove: ${ref}`);
  return matches[0];
}

function writeGroveRecord(record: GroveRecord, mycoHome: string): void {
  fs.mkdirSync(resolveGroveRegistryDir(record.id, mycoHome), { recursive: true });
  const doc: TomlTableWithoutBigInt = {
    grove: record as unknown as TomlTableWithoutBigInt,
  };
  const metadataPath = resolveGroveMetadataPath(record.id, mycoHome);
  atomicWriteFileSync(metadataPath, stringify(doc));
  groveRecordCache.invalidate(metadataPath);
  groveDirEntriesCache.invalidate(resolveGrovesDir(mycoHome));
}

function readGroveRegistry(mycoHome: string): GroveRegistryDoc {
  return groveRegistryCache.get(resolveGroveRegistryPath(mycoHome));
}

function writeGroveRegistry(mycoHome: string, doc: GroveRegistryDoc): void {
  const filePath = resolveGroveRegistryPath(mycoHome);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, YAML.stringify(doc));
  groveRegistryCache.invalidate(filePath);
}

/**
 * Read the legacy `~/.myco/config.yaml`. Only used to surface the
 * previous home of `default_grove_id` during the one-shot migration to
 * `groves/registry.yaml`.
 */
function readLegacyGlobalConfig(mycoHome: string): LegacyGlobalConfigDoc {
  return legacyGlobalConfigCache.get(resolveGlobalConfigPath(mycoHome));
}

function readToml(filePath: string): TomlTableWithoutBigInt {
  return tomlDocCache.get(filePath);
}

function writeToml(filePath: string, doc: TomlTableWithoutBigInt): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, stringify(doc));
  tomlDocCache.invalidate(filePath);
}

function normalizeRegisteredProject(row: Record<string, unknown>): RegisteredProject | null {
  if (
    typeof row.project_id !== 'string'
    || typeof row.name !== 'string'
    || typeof row.root !== 'string'
    || typeof row.created_at !== 'string'
    || typeof row.updated_at !== 'string'
  ) {
    return null;
  }
  return {
    project_id: row.project_id,
    name: row.name,
    root: row.root,
    ...(typeof row.binding_id === 'string' ? { binding_id: row.binding_id } : {}),
    status: row.status === 'archived' ? 'archived' : 'active',
    ...(typeof row.archived_at === 'string' ? { archived_at: row.archived_at } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
