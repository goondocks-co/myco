import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify, type TomlTableWithoutBigInt } from 'smol-toml';
import { z } from 'zod';
import { createGroveBindingId, createProjectId } from '@myco/grove/ids.js';
import {
  resolveProjectLocalManifestPath,
  resolveProjectManifestPath,
} from '@myco/grove/paths.js';
import { findRegisteredProjectByBinding } from '@myco/grove/registry-resolve.js';
import { ensureVaultGitignoreCurrent } from '@myco/vault/gitignore.js';
import { isPlainTable } from '@myco/utils/is-plain-table.js';
import { createMtimeCache } from '@myco/utils/mtime-cache.js';

const SECRET_KEY_RE = /(secret|token|password|credential|api[_-]?key)/i;

/**
 * Schema for the project's `project.toml`. Carries portable identity
 * (`project.id`, `project.name`) and the portable Grove identity
 * (`grove.id`, `grove.slug`, `grove.name`) — all of which are safe to
 * commit. The per-machine binding (binding_id, mode) lives in
 * `project.local.toml` (see `ProjectLocalManifestSchema`).
 *
 * `binding_id`, `slug`, `mode`, `remote` remain accepted as optional fields
 * during the WB1→WB2 transition: legacy callers (activation,
 * request-context, binding) still read these off `manifest.grove`. The
 * migration path on disk strips them; this carve-out only keeps the
 * in-memory type compatible until consumers move to
 * `loadProjectLocalManifest`. Remove the optional legacy keys when no
 * caller reads `manifest.grove?.binding_id` any more.
 */
export const ProjectManifestSchema = z.object({
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
  }),
  grove: z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    binding_id: z.string().min(1).optional(),
    mode: z.enum(['local']).default('local'),
    remote: z.object({
      provider: z.string().min(1).optional(),
      remote_id: z.string().min(1).optional(),
    }).optional(),
  }).optional(),
});

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export const ProjectLocalManifestSchema = z.object({
  grove_binding: z.object({
    binding_id: z.string().min(1),
    mode: z.literal('local'),
    local_db_path: z.string().min(1).optional(),
  }).optional(),
});

export type ProjectLocalManifest = z.infer<typeof ProjectLocalManifestSchema>;

export interface EnsureProjectManifestOptions {
  projectName: string;
  groveSlug?: string;
  groveBindingId?: string;
}

const manifestCache = createMtimeCache((manifestPath: string): ProjectManifest | null => {
  let content: string;
  try {
    content = fs.readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = parse(content) as Record<string, unknown>;
  assertNoSecretLikeKeys(parsed);

  const groveRaw = parsed.grove as Record<string, unknown> | undefined;
  const isOldShape = !!groveRaw
    && (groveRaw.binding_id !== undefined || groveRaw.mode !== undefined)
    && groveRaw.id === undefined;

  let manifest: ProjectManifest | null = null;
  if (isOldShape) {
    manifest = migrateCombinedManifest(manifestPath, parsed);
  }
  if (!manifest) manifest = ProjectManifestSchema.parse(parsed);

  return overlayLocalBinding(manifest, manifestPath);
});

/**
 * Overlay the per-machine binding (`grove.binding_id`, `grove.mode`) from
 * `project.local.toml` onto the in-memory manifest view. Keeps existing
 * call sites that read `manifest.grove?.binding_id` working transparently
 * through the WB1→WB2 transition, even though the binding has moved off
 * disk into `project.local.toml`.
 *
 * Remove this overlay (and the legacy `binding_id`/`mode` fields on
 * `ProjectManifestSchema`) once every consumer reads `loadProjectLocalManifest`.
 */
function overlayLocalBinding(
  manifest: ProjectManifest,
  manifestPath: string,
): ProjectManifest {
  const vaultDir = path.dirname(manifestPath);
  const localPath = path.join(vaultDir, 'project.local.toml');
  if (!fs.existsSync(localPath)) return manifest;
  const local = localManifestCache.get(localPath);
  const binding = local?.grove_binding;
  if (!binding) return manifest;
  return {
    ...manifest,
    grove: {
      ...(manifest.grove ?? { mode: 'local' }),
      binding_id: binding.binding_id,
      mode: binding.mode,
    },
  };
}

const localManifestCache = createMtimeCache((manifestPath: string): ProjectLocalManifest | null => {
  let content: string;
  try {
    content = fs.readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = parse(content);
  return ProjectLocalManifestSchema.parse(parsed);
});

/**
 * Read the project manifest with `grove.binding_id` and `grove.mode`
 * reconstituted from `project.local.toml` via `overlayLocalBinding` (the
 * single source of truth for those fields). Binding-resolution callers
 * MUST go through this function — never `loadProjectLocalManifest`
 * directly — so legacy and post-migration vaults present an identical
 * shape. Remove this carve-out once activation writes the binding only
 * into `project.local.toml` and `ProjectManifestSchema` drops the legacy
 * `binding_id` / `mode` fields (WB2).
 */
export function loadProjectManifest(projectVaultDir: string): ProjectManifest | null {
  return manifestCache.get(resolveProjectManifestPath(projectVaultDir));
}

export function loadProjectLocalManifest(projectVaultDir: string): ProjectLocalManifest | null {
  return localManifestCache.get(resolveProjectLocalManifestPath(projectVaultDir));
}

export function clearProjectManifestCache(): void {
  manifestCache.clear();
  localManifestCache.clear();
}

export function parseProjectManifest(content: string): ProjectManifest {
  const parsed = parse(content);
  assertNoSecretLikeKeys(parsed);
  return ProjectManifestSchema.parse(parsed);
}

export function saveProjectManifest(projectVaultDir: string, manifest: ProjectManifest): void {
  const manifestPath = resolveProjectManifestPath(projectVaultDir);
  const existing = readTomlDocument(manifestPath);
  assertNoSecretLikeKeys(manifest);
  const validated = ProjectManifestSchema.parse(manifest);

  const doc: TomlTableWithoutBigInt = {
    ...existing,
    project: {
      ...(isPlainTable(existing.project) ? existing.project : {}),
      ...validated.project,
    },
  };

  if (validated.grove) {
    doc.grove = compactTable(mergeGroveTable(existing.grove, validated.grove));
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  atomicWriteFileSync(manifestPath, stringify(doc));
  manifestCache.invalidate(manifestPath);
}

export function saveProjectLocalManifest(
  projectVaultDir: string,
  manifest: ProjectLocalManifest,
): void {
  const filePath = resolveProjectLocalManifestPath(projectVaultDir);
  const validated = ProjectLocalManifestSchema.parse(manifest);
  const doc: TomlTableWithoutBigInt = {};
  if (validated.grove_binding) {
    doc.grove_binding = compactTable(validated.grove_binding as unknown as TomlTableWithoutBigInt);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, stringify(doc));
  localManifestCache.invalidate(filePath);
}

export function ensureProjectManifest(
  projectVaultDir: string,
  options: EnsureProjectManifestOptions,
): ProjectManifest {
  const existing = loadProjectManifest(projectVaultDir);
  if (existing) {
    if (options.groveSlug && !existing.grove?.binding_id) {
      const updated: ProjectManifest = {
        ...existing,
        grove: {
          ...existing.grove,
          binding_id: options.groveBindingId ?? createGroveBindingId(),
          slug: existing.grove?.slug ?? options.groveSlug,
          mode: existing.grove?.mode ?? 'local',
        },
      };
      saveProjectManifest(projectVaultDir, updated);
      return updated;
    }
    return existing;
  }

  const manifest: ProjectManifest = {
    project: {
      id: createProjectId(),
      name: options.projectName,
    },
    grove: options.groveSlug
      ? {
        binding_id: options.groveBindingId ?? createGroveBindingId(),
        slug: options.groveSlug,
        mode: 'local',
      }
      : undefined,
  };
  saveProjectManifest(projectVaultDir, manifest);
  return manifest;
}

function migrateCombinedManifest(
  manifestPath: string,
  parsed: Record<string, unknown>,
): ProjectManifest | null {
  const groveRaw = parsed.grove as Record<string, unknown> | undefined;
  const bindingId = typeof groveRaw?.binding_id === 'string' ? groveRaw.binding_id : null;
  if (!bindingId) return null;

  const resolved = findRegisteredProjectByBinding(bindingId);
  if (!resolved) return null;

  const projectRaw = parsed.project as Record<string, unknown> | undefined;
  if (!projectRaw || typeof projectRaw.id !== 'string') return null;

  const vaultDir = path.dirname(manifestPath);
  const localDbPath = typeof groveRaw?.local_db_path === 'string' ? groveRaw.local_db_path : undefined;
  const mode: 'local' = 'local';

  const newDoc: TomlTableWithoutBigInt = {
    project: {
      ...projectRaw,
    } as TomlTableWithoutBigInt,
    grove: {
      id: resolved.grove.id,
      slug: resolved.grove.slug,
      name: resolved.grove.name,
    } as TomlTableWithoutBigInt,
  };

  if (groveRaw?.remote && isPlainTable(groveRaw.remote)) {
    (newDoc.grove as TomlTableWithoutBigInt).remote = groveRaw.remote as TomlTableWithoutBigInt;
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  atomicWriteFileSync(manifestPath, stringify(newDoc));

  const localPath = path.join(vaultDir, 'project.local.toml');
  const localDoc: TomlTableWithoutBigInt = {
    grove_binding: compactTable({
      binding_id: bindingId,
      mode,
      ...(localDbPath ? { local_db_path: localDbPath } : {}),
    } as TomlTableWithoutBigInt),
  };
  atomicWriteFileSync(localPath, stringify(localDoc));
  localManifestCache.invalidate(localPath);

  ensureVaultGitignoreCurrent(vaultDir);

  return ProjectManifestSchema.parse(newDoc);
}

function readTomlDocument(filePath: string): TomlTableWithoutBigInt {
  if (!fs.existsSync(filePath)) return {};
  const parsed = parse(fs.readFileSync(filePath, 'utf-8'));
  if (!isPlainTable(parsed)) return {};
  return parsed as TomlTableWithoutBigInt;
}

function atomicWriteFileSync(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, contents, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function mergeGroveTable(
  existing: unknown,
  grove: NonNullable<ProjectManifest['grove']>,
): TomlTableWithoutBigInt {
  const existingTable = isPlainTable(existing) ? existing as TomlTableWithoutBigInt : {};
  const table: TomlTableWithoutBigInt = {
    ...existingTable,
    mode: grove.mode,
  };
  if (grove.id) table.id = grove.id;
  if (grove.name) table.name = grove.name;
  if (grove.binding_id) table.binding_id = grove.binding_id;
  if (grove.slug) table.slug = grove.slug;
  if (grove.remote) {
    table.remote = {
      ...(isPlainTable(existingTable.remote) ? existingTable.remote as TomlTableWithoutBigInt : {}),
      ...grove.remote,
    };
  }
  return table;
}

function compactTable(table: TomlTableWithoutBigInt): TomlTableWithoutBigInt {
  const compacted: TomlTableWithoutBigInt = {};
  for (const [key, value] of Object.entries(table)) {
    if (value === undefined) continue;
    if (isPlainTable(value)) {
      compacted[key] = compactTable(value as TomlTableWithoutBigInt);
    } else {
      compacted[key] = value;
    }
  }
  return compacted;
}

function assertNoSecretLikeKeys(value: unknown, pathParts: string[] = []): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (SECRET_KEY_RE.test(key)) {
      throw new Error(`project.toml must not contain secret-like field: ${nextPath.join('.')}`);
    }
    assertNoSecretLikeKeys(child, nextPath);
  }
}
