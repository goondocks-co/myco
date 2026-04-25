import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PROJECTS_PATH, ensureHubDir } from './paths.js';
import { readDaemonJson, readRuntimeCommand, isVault, type ProjectRecord } from './discovery.js';

const RegistrationSchema = z.object({
  name: z.string().optional(),
  projectRoot: z.string(),
  vaultDir: z.string(),
  machineId: z.string(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  pid: z.number().int().positive().nullable().optional(),
  version: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  runtimeCommand: z.string().nullable().optional(),
});

export type ProjectRegistration = z.infer<typeof RegistrationSchema>;

const ProjectsFileSchema = z.object({
  version: z.literal(1),
  projects: z.array(z.object({
    id: z.string(),
    name: z.string(),
    projectRoot: z.string(),
    vaultDir: z.string(),
    machineId: z.string(),
    source: z.enum(['registration', 'daemon-api', 'process-scan', 'unknown']).optional().default('unknown'),
    preferredPort: z.number().int().min(1).max(65535).nullable(),
    runtimeCommand: z.string().nullable(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
  })),
});

interface ProjectsFile {
  version: 1;
  projects: ProjectRecord[];
}

export function upsertProjectRegistration(
  raw: ProjectRegistration,
  source: ProjectRecord['source'] = 'registration',
): ProjectRecord {
  const registration = RegistrationSchema.parse(raw);
  const now = new Date().toISOString();
  const file = readProjectsFile();
  const id = projectId(registration);
  const existing = file.projects.find((project) => project.id === id);

  const record: ProjectRecord = {
    id,
    name: registration.name?.trim() || path.basename(registration.projectRoot),
    projectRoot: registration.projectRoot,
    vaultDir: registration.vaultDir,
    machineId: registration.machineId,
    source,
    preferredPort: registration.port ?? existing?.preferredPort ?? readDaemonJson(registration.vaultDir)?.port ?? null,
    runtimeCommand: registration.runtimeCommand ?? readRuntimeCommand(registration.vaultDir) ?? existing?.runtimeCommand ?? null,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
  };

  file.projects = [
    ...file.projects.filter((project) => project.id !== id),
    record,
  ].sort((a, b) => a.name.localeCompare(b.name) || a.projectRoot.localeCompare(b.projectRoot));
  writeProjectsFile(file);
  return record;
}

export function listKnownProjects(): ProjectRecord[] {
  const file = readProjectsFile();
  const projects = file.projects.filter((project) => isVault(project.vaultDir));
  if (projects.length !== file.projects.length) {
    writeProjectsFile({ ...file, projects });
  }
  return projects
    .map((project) => ({
      ...project,
      source: project.source ?? 'unknown',
      preferredPort: readDaemonJson(project.vaultDir)?.port ?? project.preferredPort,
      runtimeCommand: readRuntimeCommand(project.vaultDir) ?? project.runtimeCommand,
    }));
}

export function getKnownProject(id: string): ProjectRecord | null {
  return listKnownProjects().find((project) => project.id === id) ?? null;
}

export function removeKnownProject(id: string): boolean {
  const file = readProjectsFile();
  const nextProjects = file.projects.filter((project) => project.id !== id);
  if (nextProjects.length === file.projects.length) return false;
  writeProjectsFile({ ...file, projects: nextProjects });
  return true;
}

function readProjectsFile(): ProjectsFile {
  try {
    const parsed = ProjectsFileSchema.parse(JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8')));
    return parsed;
  } catch {
    return { version: 1, projects: [] };
  }
}

function writeProjectsFile(file: ProjectsFile): void {
  ensureHubDir();
  fs.writeFileSync(PROJECTS_PATH, JSON.stringify(file, null, 2) + '\n', 'utf-8');
}

function projectId(registration: Pick<ProjectRegistration, 'name' | 'projectRoot' | 'vaultDir' | 'machineId'>): string {
  const name = slug(registration.name || path.basename(registration.projectRoot)) || 'project';
  const machine = slug(registration.machineId).slice(0, 16) || 'machine';
  const suffix = crypto.createHash('sha256').update(registration.vaultDir).digest('hex').slice(0, 8);
  return `${name}-${machine}-${suffix}`;
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
