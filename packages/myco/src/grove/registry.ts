import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { parse, stringify, type TomlTableWithoutBigInt } from 'smol-toml';
import { createGroveId } from './ids.js';
import {
  resolveGlobalConfigPath,
  resolveGroveDir,
  resolveGroveMetadataPath,
  resolveGroveProjectsPath,
  resolveGroveRegistryDir,
  resolveGroveRootsPath,
  resolveGrovesDir,
  resolveMycoHome,
} from './paths.js';
import { slugifyGroveName } from './ids.js';

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

export interface RegisterProjectInput {
  projectId: string;
  projectName: string;
  projectRoot: string;
  bindingId?: string;
}

interface GlobalConfigDoc {
  grove?: {
    default_grove_id?: string;
  };
  [key: string]: unknown;
}

export function listGroves(mycoHome = resolveMycoHome()): GroveRecord[] {
  const grovesDir = resolveGrovesDir(mycoHome);
  if (!fs.existsSync(grovesDir)) return [];
  return fs.readdirSync(grovesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadGroveRecord(entry.name, mycoHome))
    .filter((record): record is GroveRecord => !!record)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadGroveRecord(groveId: string, mycoHome = resolveMycoHome()): GroveRecord | null {
  const metadataPath = resolveGroveMetadataPath(groveId, mycoHome);
  if (!fs.existsSync(metadataPath)) return null;
  const doc = parse(fs.readFileSync(metadataPath, 'utf-8')) as TomlTableWithoutBigInt;
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
  const doc = readGlobalConfig(mycoHome);
  return typeof doc.grove?.default_grove_id === 'string' ? doc.grove.default_grove_id : null;
}

export function setDefaultGrove(ref: string, mycoHome = resolveMycoHome()): GroveRecord {
  const grove = resolveGroveByIdOrName(ref, mycoHome);
  const doc = readGlobalConfig(mycoHome);
  doc.grove = { ...(isPlainTable(doc.grove) ? doc.grove : {}), default_grove_id: grove.id };
  writeGlobalConfig(mycoHome, doc);
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
  fs.writeFileSync(resolveGroveMetadataPath(record.id, mycoHome), stringify(doc), 'utf-8');
}

function readGlobalConfig(mycoHome: string): GlobalConfigDoc {
  const filePath = resolveGlobalConfigPath(mycoHome);
  if (!fs.existsSync(filePath)) return {};
  const parsed = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  if (!isPlainTable(parsed)) return {};
  return parsed as GlobalConfigDoc;
}

function writeGlobalConfig(mycoHome: string, doc: GlobalConfigDoc): void {
  fs.mkdirSync(mycoHome, { recursive: true });
  fs.writeFileSync(resolveGlobalConfigPath(mycoHome), YAML.stringify(doc), 'utf-8');
}

function readToml(filePath: string): TomlTableWithoutBigInt {
  if (!fs.existsSync(filePath)) return {};
  const parsed = parse(fs.readFileSync(filePath, 'utf-8'));
  return isPlainTable(parsed) ? parsed as TomlTableWithoutBigInt : {};
}

function writeToml(filePath: string, doc: TomlTableWithoutBigInt): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringify(doc), 'utf-8');
}

function isPlainTable(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
