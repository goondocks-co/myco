import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify, type TomlTableWithoutBigInt } from 'smol-toml';
import { z } from 'zod';
import { createGroveBindingId, createProjectId } from '@myco/grove/ids.js';
import { resolveProjectManifestPath } from '@myco/grove/paths.js';
import { isPlainTable } from '@myco/utils/is-plain-table.js';
import { createMtimeCache } from '@myco/utils/mtime-cache.js';

const SECRET_KEY_RE = /(secret|token|password|credential|api[_-]?key)/i;

export const ProjectManifestSchema = z.object({
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
  }),
  grove: z.object({
    binding_id: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    mode: z.enum(['local']).default('local'),
    remote: z.object({
      provider: z.string().min(1).optional(),
      remote_id: z.string().min(1).optional(),
    }).optional(),
  }).optional(),
});

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

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
  return parseProjectManifest(content);
});

export function loadProjectManifest(projectVaultDir: string): ProjectManifest | null {
  return manifestCache.get(resolveProjectManifestPath(projectVaultDir));
}

export function clearProjectManifestCache(): void {
  manifestCache.clear();
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
  fs.writeFileSync(manifestPath, stringify(doc), 'utf-8');
  manifestCache.invalidate(manifestPath);
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

function readTomlDocument(filePath: string): TomlTableWithoutBigInt {
  if (!fs.existsSync(filePath)) return {};
  const parsed = parse(fs.readFileSync(filePath, 'utf-8'));
  if (!isPlainTable(parsed)) return {};
  return parsed as TomlTableWithoutBigInt;
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

