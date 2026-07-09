import fs from 'node:fs';
import { parse, type TomlTableWithoutBigInt } from 'smol-toml';
import { isPlainTable } from '@myco/utils/is-plain-table.js';
import { isGroveEraId } from './ids.js';
import {
  resolveGrovesDir,
  resolveGroveMetadataPath,
  resolveGroveProjectsPath,
  resolveMycoHome,
} from './paths.js';

export interface RegistryGroveRecord {
  id: string;
  name: string;
  slug: string;
  mode: 'local';
  created_at: string;
}

export interface RegistryProjectRow {
  project_id: string;
  name: string;
  root: string;
  binding_id?: string;
  created_at: string;
  updated_at: string;
}

export interface RegistryResolvedProject {
  grove: RegistryGroveRecord;
  project: RegistryProjectRow;
}

/**
 * Lightweight registry lookup helpers — no manifest dependency, no caches.
 * Lives outside `registry.ts` so `config/project-manifest.ts` can import a
 * binding lookup synchronously without forming a cycle (`registry.ts`
 * already imports the manifest helpers).
 *
 * Remove the carve-out and inline these back into `registry.ts` when the
 * legacy combined-manifest migration path is dropped from
 * `loadProjectManifest`.
 */
export function findRegisteredProjectByBinding(
  bindingId: string,
  mycoHome = resolveMycoHome(),
): RegistryResolvedProject | null {
  for (const grove of listGrovesUncached(mycoHome)) {
    const project = listRegisteredProjectsUncached(grove.id, mycoHome)
      .find((row) => row.binding_id === bindingId);
    if (project) return { grove, project };
  }
  return null;
}

/**
 * Locate the local Grove registry row for `projectId` across every local
 * Grove, or null when the project has no local row. Disk-read-only and
 * cycle-safe (same carve-out rationale as {@link findRegisteredProjectByBinding}):
 * `host/registry.ts` `attachProject` consults it to refuse attaching a
 * project that still holds local Grove state, without importing the cached
 * `registry.ts` surface (which already imports the host registry).
 */
export function findRegisteredProjectById(
  projectId: string,
  mycoHome = resolveMycoHome(),
): RegistryResolvedProject | null {
  for (const grove of listGrovesUncached(mycoHome)) {
    const project = listRegisteredProjectsUncached(grove.id, mycoHome)
      .find((row) => row.project_id === projectId);
    if (project) return { grove, project };
  }
  return null;
}

function listGrovesUncached(mycoHome: string): RegistryGroveRecord[] {
  const grovesDir = resolveGrovesDir(mycoHome);
  if (!fs.existsSync(grovesDir)) return [];
  const entries = fs.readdirSync(grovesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const records: RegistryGroveRecord[] = [];
  for (const id of entries) {
    if (!isGroveEraId(id, 'grove')) continue;
    const record = readGroveMetadata(id, mycoHome);
    if (record) records.push(record);
  }
  return records;
}

function readGroveMetadata(groveId: string, mycoHome: string): RegistryGroveRecord | null {
  const metadataPath = resolveGroveMetadataPath(groveId, mycoHome);
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
  if (
    typeof grove.id !== 'string'
    || typeof grove.name !== 'string'
    || typeof grove.slug !== 'string'
  ) {
    return null;
  }
  return {
    id: grove.id,
    name: grove.name,
    slug: grove.slug,
    mode: 'local',
    created_at: typeof grove.created_at === 'string' ? grove.created_at : new Date(0).toISOString(),
  };
}

function listRegisteredProjectsUncached(groveId: string, mycoHome: string): RegistryProjectRow[] {
  const projectsPath = resolveGroveProjectsPath(groveId, mycoHome);
  let content: string;
  try {
    content = fs.readFileSync(projectsPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const doc = parse(content) as TomlTableWithoutBigInt;
  const projects = isPlainTable(doc.projects) ? doc.projects as Record<string, unknown> : {};
  const rows: RegistryProjectRow[] = [];
  for (const value of Object.values(projects)) {
    if (!isPlainTable(value)) continue;
    const row = value as Record<string, unknown>;
    if (
      typeof row.project_id !== 'string'
      || typeof row.name !== 'string'
      || typeof row.root !== 'string'
      || typeof row.created_at !== 'string'
      || typeof row.updated_at !== 'string'
    ) {
      continue;
    }
    rows.push({
      project_id: row.project_id,
      name: row.name,
      root: row.root,
      ...(typeof row.binding_id === 'string' ? { binding_id: row.binding_id } : {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }
  return rows;
}
