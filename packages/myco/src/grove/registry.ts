import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { parse, stringify, type TomlTableWithoutBigInt } from 'smol-toml';
import { isPlainTable } from '@myco/utils/is-plain-table.js';
import { createMtimeCache } from '@myco/utils/mtime-cache.js';
import { createGroveId, isGroveEraId } from './ids.js';
import {
  pathsEquivalent,
  resolveGlobalConfigPath,
  resolveGroveDir,
  resolveGroveMetadataPath,
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
 * Legacy shape for `~/.myco/config.yaml` — the registry block used to
 * live here as `grove.default_grove_id`. Kept so the migration path
 * can read it once and copy the value into the new file.
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

export function createGrove(name: string, mycoHome = resolveMycoHome()): GroveRecord {
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

export function ensureDefaultGrove(mycoHome = resolveMycoHome()): GroveRecord {
  const defaultId = getDefaultGroveId(mycoHome);
  if (defaultId) {
    const existing = loadGroveRecord(defaultId, mycoHome);
    if (existing) return existing;
  }

  const existingDefault = listGroves(mycoHome).find((grove) => grove.slug === 'default');
  if (existingDefault) {
    setDefaultGrove(existingDefault.id, mycoHome);
    return existingDefault;
  }

  const created = createGrove('default', mycoHome);
  setDefaultGrove(created.id, mycoHome);
  return created;
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
): RegisteredProject[] {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) return [];
  const projectsDoc = readToml(resolveGroveProjectsPath(grove.id, mycoHome));
  const projects = isPlainTable(projectsDoc.projects) ? projectsDoc.projects as Record<string, unknown> : {};
  return Object.values(projects)
    .filter(isPlainTable)
    .map((row) => normalizeRegisteredProject(row as Record<string, unknown>))
    .filter((row): row is RegisteredProject => !!row);
}

export function getRegisteredProjectInGrove(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): RegisteredProject | null {
  const projectsDoc = readToml(resolveGroveProjectsPath(groveId, mycoHome));
  const projects = isPlainTable(projectsDoc.projects) ? projectsDoc.projects as Record<string, unknown> : {};
  const row = isPlainTable(projects[projectId])
    ? normalizeRegisteredProject(projects[projectId] as Record<string, unknown>)
    : null;
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
 *
 * Persisted via the same atomic temp+rename path as the rest of `projects.toml`,
 * so a daemon crash leaves the pause on disk for the next process to see.
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
 * Escape hatch for the startup orphan sweep — clears `paused` regardless
 * of who owns the lock. Used when the prior daemon died holding the pause.
 */
export function forceResumeProject(
  groveId: string,
  projectId: string,
  reason: string,
  mycoHome = resolveMycoHome(),
): void {
  const grove = loadGroveRecord(groveId, mycoHome);
  if (!grove) throw new Error(`Unknown Grove: ${groveId}`);
  void reason;

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
  const groves = listGroves(mycoHome);
  for (const grove of groves) {
    const projectsDoc = readToml(resolveGroveProjectsPath(grove.id, mycoHome));
    const projects = isPlainTable(projectsDoc.projects)
      ? projectsDoc.projects as Record<string, unknown>
      : {};
    const entry = isPlainTable(projects[projectId])
      ? projects[projectId] as Record<string, unknown>
      : null;
    if (!entry) continue;
    const pause = readPauseBlock(entry);
    if (!pause) return { paused: false };
    return {
      paused: true,
      reason: pause.reason,
      since: pause.since,
      owner_op: pause.owner_op,
      grove_id: grove.id,
    };
  }
  return { paused: false };
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
  fs.writeFileSync(metadataPath, stringify(doc), 'utf-8');
  groveRecordCache.invalidate(metadataPath);
  groveDirEntriesCache.invalidate(resolveGrovesDir(mycoHome));
}

function readGroveRegistry(mycoHome: string): GroveRegistryDoc {
  return groveRegistryCache.get(resolveGroveRegistryPath(mycoHome));
}

function writeGroveRegistry(mycoHome: string, doc: GroveRegistryDoc): void {
  const filePath = resolveGroveRegistryPath(mycoHome);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(doc), 'utf-8');
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
  fs.writeFileSync(filePath, stringify(doc), 'utf-8');
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

