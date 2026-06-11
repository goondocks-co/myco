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
  currentDaemonVariant,
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
  daemonVariantFromEnvValue,
} from './paths.js';
import { slugifyGroveName } from './ids.js';
import {
  findRegisteredProjectByBinding as findRegisteredProjectByBindingResolve,
  type RegistryResolvedProject,
} from './registry-resolve.js';
import { ensureProjectManifest, loadProjectManifest } from '../config/project-manifest.js';

export type DaemonVariant = 'service' | 'service-dev';

export interface GroveRecord {
  id: string;
  name: string;
  slug: string;
  mode: 'local';
  created_at: string;
  /**
   * Which daemon's service dir owns this Grove. Reads default to
   * `'service'` for records that omit the field.
   */
  served_by: DaemonVariant;
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
  const servedBy: DaemonVariant = grove.served_by === 'service-dev' ? 'service-dev' : 'service';
  return {
    id: grove.id,
    name: grove.name,
    slug: grove.slug,
    mode: 'local',
    created_at: typeof grove.created_at === 'string' ? grove.created_at : new Date(0).toISOString(),
    served_by: servedBy,
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

export interface ListGrovesOptions {
  /**
   * Restrict to Groves owned by a specific service dir. Omit to enumerate
   * every Grove on disk — only the registry-advertisement endpoint and the
   * one-shot deploy migration script should pass nothing.
   */
  servedBy?: DaemonVariant;
}

export function listGroves(
  mycoHome = resolveMycoHome(),
  options: ListGrovesOptions = {},
): GroveRecord[] {
  const all = groveDirEntriesCache.get(resolveGrovesDir(mycoHome))
    .map((name) => loadGroveRecord(name, mycoHome))
    .filter((record): record is GroveRecord => !!record);
  const filtered = options.servedBy
    ? all.filter((g) => g.served_by === options.servedBy)
    : all;
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
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
 * True when this process's daemon variant owns the Grove. Reads always
 * normalize `served_by` to `'service' | 'service-dev'` (legacy records
 * without the field read as `'service'`), so plain equality is the whole
 * ownership predicate. On-demand seams — tool-call Grove pivots and the
 * daemon's inbound request resolution — gate cross-Grove access through
 * this before any database is opened or schema-migrated.
 */
export function groveServedByThisDaemon(
  grove: Pick<GroveRecord, 'served_by'>,
  variant: DaemonVariant = currentDaemonVariant(),
): boolean {
  return grove.served_by === variant;
}

/**
 * A request resolved to a Grove that is served by the other daemon
 * variant. Thrown by daemon-side request resolution when Grove-ownership
 * enforcement is enabled; transports translate it into a 403
 * `foreign_grove` error so the caller never reaches a database the
 * daemon does not own. Crossing the boundary deliberately is what
 * `myco grove claim` is for.
 */
export class ForeignGroveError extends Error {
  constructor(
    public readonly groveId: string,
    public readonly servedBy: DaemonVariant,
  ) {
    super(
      `Grove ${groveId} is served by another daemon (${servedBy}); `
      + 'claim it first (myco grove claim)',
    );
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
 * Existence + ownership gate for caller-named Grove ids that arrive
 * OUTSIDE the request-context funnel (body `ActionScope.grove_id`, URL
 * `:id` params). Throws {@link UnknownGroveError} when no record exists —
 * so an unknown id can never create `groves/<id>/` as a side effect of a
 * DB open — and {@link ForeignGroveError} when the Grove is served by the
 * other daemon variant. Call it BEFORE any `cache.getDatabase` /
 * `resolveGroveDbPath` on the named Grove.
 */
export function assertOwnedGrove(groveId: string, mycoHome = resolveMycoHome()): GroveRecord {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new UnknownGroveError(groveId);
  if (!groveServedByThisDaemon(grove)) {
    throw new ForeignGroveError(grove.id, grove.served_by);
  }
  return grove;
}

export interface CreateGroveOptions {
  servedBy?: DaemonVariant;
}

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
    served_by: options.servedBy ?? 'service',
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
    served_by: 'service',
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
 * Ensure a default Grove exists matching the requested variant.
 *
 * Variant-aware: dev daemons and prod daemons each need their own
 * default Grove with the matching `served_by` so the cross-variant
 * walker boundary (R3.0) and rebind filter both keep working. A single
 * machine can host both — they get distinct slugs (`default` for prod,
 * `default-dev` for dev) so they coexist in the registry.
 *
 * The pointer `default_grove_id` always names the variant's own
 * default — for a dev daemon, it's the dev Grove; for prod, it's the
 * prod Grove. Variant lookup is filtered by `served_by`, NOT by the
 * pointer, so the pointer can safely co-exist between variants.
 *
 * Called from `runGlobalBootstrap()` — fires at daemon first-start so
 * the default Grove is guaranteed to exist before any hook tries to
 * register a project into it. Idempotent: an existing matching default
 * Grove is returned unchanged.
 */
export function ensureDefaultGrove(
  mycoHome = resolveMycoHome(),
  options: { servedBy?: 'service' | 'service-dev' } = {},
): GroveRecord {
  const servedBy = options.servedBy ?? 'service';
  const slug = servedBy === 'service-dev' ? 'default-dev' : 'default';

  // 1. Honor an explicit default pointer when it names a Grove matching
  //    the current variant. Users can `setDefaultGrove(non-default-slug)`
  //    and have that decision survive across daemon restarts.
  const pointedId = getDefaultGroveId(mycoHome);
  if (pointedId) {
    const pointed = loadGroveRecord(pointedId, mycoHome);
    if (pointed && pointed.served_by === servedBy) return pointed;
  }

  // 2. No pointer (or it names a wrong-variant Grove) — look for a
  //    variant-matching Grove by its canonical slug.
  const matching = listGroves(mycoHome, { servedBy }).find(
    (grove) => grove.slug === slug,
  );
  if (matching) {
    // Promote to the default pointer when there's no pointer at all,
    // OR the existing pointer is for a different variant (preserves
    // intentional cross-variant pointer assignment).
    const pointedRecord = pointedId ? loadGroveRecord(pointedId, mycoHome) : null;
    if (!pointedRecord || pointedRecord.served_by !== servedBy) {
      setDefaultGrove(matching.id, mycoHome);
    }
    return matching;
  }

  // 3. No matching Grove yet — create it.
  const created = createGrove(slug, mycoHome, { servedBy });
  // Promote to the default pointer when there's no pointer at all OR
  // the existing pointer names a wrong-variant Grove. Symmetric with
  // step 2's promotion logic — the just-created Grove is the right
  // owner of the pointer for this variant. (Coexisting dev+prod
  // installs see the pointer thrash on each daemon boot; that's
  // expected, and variant-aware project resolution must not depend
  // on the pointer alone — see `resolveDefaultGroveForVariant`.)
  const pointedRecord = pointedId ? loadGroveRecord(pointedId, mycoHome) : null;
  if (!pointedRecord || pointedRecord.served_by !== servedBy) {
    setDefaultGrove(created.id, mycoHome);
  }
  return created;
}

/**
 * Read-only variant-aware default-Grove lookup. Sister of
 * `ensureDefaultGrove`: no side effects, returns null when no
 * matching Grove exists.
 *
 * Used by `ensureProjectRegistered` and any other code path that
 * needs to find "this variant's default Grove" without creating one.
 * Honors the pointer when it matches the variant, otherwise falls
 * back to the canonical slug lookup (`default` for prod, `default-dev`
 * for dev). NEVER returns a wrong-variant Grove — the cross-variant
 * boundary that `firstProjectVaultFromRegistry` enforces at the vault
 * resolver layer applies here too.
 */
export function resolveDefaultGroveForVariant(
  mycoHome = resolveMycoHome(),
  options: { servedBy?: 'service' | 'service-dev' } = {},
): GroveRecord | null {
  const servedBy = options.servedBy ?? 'service';
  const pointedId = getDefaultGroveId(mycoHome);
  if (pointedId) {
    const pointed = loadGroveRecord(pointedId, mycoHome);
    if (pointed && pointed.served_by === servedBy) return pointed;
  }
  const slug = servedBy === 'service-dev' ? 'default-dev' : 'default';
  return listGroves(mycoHome, { servedBy }).find((g) => g.slug === slug) ?? null;
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
 * Auto-register a project under the machine default Grove when the
 * hook layer fires from a real project root that isn't yet known.
 *
 * Returns the resolved registration so callers (event-dispatch in
 * particular) can move straight to writing events without an extra
 * registry walk. Idempotent: an already-registered project returns the
 * existing record.
 *
 * Refuses to register when:
 *   - the path fails `isSafeProjectRoot` (cwd-fallback paths from a
 *     misfired hook, $HOME-rooted invocations, etc.); returns `null`.
 *   - the machine has no default Grove yet (extremely early bootstrap);
 *     returns `null`.
 *
 * Decision 2 of the plan: silent register, no prompt — discovery via
 * the Groves page in the UI. Per Decision 3, the default Grove is the
 * owner.
 */
export function ensureProjectRegistered(
  projectRoot: string,
  mycoHome = resolveMycoHome(),
): ResolvedRegisteredProject | null {
  const existing = findProjectByRoot(projectRoot, mycoHome, { includeArchived: true });
  if (existing?.project.status === 'archived') return null;
  if (existing) return existing;
  if (!isSafeProjectRoot(projectRoot)) return null;

  // Variant-aware default Grove lookup. `getDefaultGroveId()` is
  // variant-blind by design (the pointer is shared between dev and
  // prod on coexisting installs); reading it directly would let a
  // wrong-variant pointer steal projects from another variant's
  // Grove. `resolveDefaultGroveForVariant` honors the pointer only
  // when its target matches the current variant, otherwise falls
  // back to the canonical slug lookup.
  const servedBy = daemonVariantFromEnvValue(process.env.MYCO_SERVICE_VARIANT);
  const grove = resolveDefaultGroveForVariant(mycoHome, { servedBy });
  if (!grove) return null;

  const projectName = path.basename(path.resolve(projectRoot));
  let manifest = loadProjectManifest(resolveProjectVaultDir(projectRoot));
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
 * Set a Grove's `served_by` daemon variant. Atomic write via the
 * shared `writeGroveRecord` path. Used by the dogfood claim/release
 * workflow to flip ownership between the production daemon and the
 * dev daemon.
 */
export function setGroveServedBy(
  groveId: string,
  servedBy: DaemonVariant,
  mycoHome = resolveMycoHome(),
): GroveRecord {
  if (servedBy !== 'service' && servedBy !== 'service-dev') {
    throw new Error(`Invalid served_by variant: ${servedBy}`);
  }
  const existing = loadGroveRecord(groveId, mycoHome);
  if (!existing) throw new Error(`Unknown Grove: ${groveId}`);
  const updated: GroveRecord = { ...existing, served_by: servedBy };
  writeGroveRecord(updated, mycoHome);
  return updated;
}

/**
 * Tear down a Grove. Refuses when projects remain bound to it unless
 * `force: true` is passed — moves are the supported path for project
 * relocation, not a "smart" delete.
 *
 * On success: removes `~/.myco/groves/<groveId>/` (metadata, registry,
 * SQLite, vectors). Clears the cross-Grove default pointer if the
 * deleted Grove was the default.
 *
 * Note: `force: true` discards any per-project pause state on bound
 * projects along with the rest of the Grove dir — pauses live in the
 * Grove's `projects.toml`, which is removed with the directory.
 */
export function deleteGrove(
  groveId: string,
  opts: { force?: boolean } = {},
  mycoHome = resolveMycoHome(),
): void {
  const existing = loadGroveRecord(groveId, mycoHome);
  if (!existing) throw new Error(`Unknown Grove: ${groveId}`);

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
