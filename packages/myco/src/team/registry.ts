import fs from 'node:fs';
import path from 'node:path';

import {
  readSecrets as readSecretsFile,
  writeSecret as writeSecretFile,
} from '../config/secrets.js';
import {
  resolveTeamsDir,
  resolveTeamDir,
  resolveTeamConfigPath,
} from '../grove/paths.js';

export interface TeamProjectRef {
  grove_id: string;
  project_id: string;
}

export interface TeamRecord {
  team_id: string;
  name: string;
  worker_url: string;
  domain: string | null;
  mcp_endpoint: string | null;
  created_at: string;
  projects: TeamProjectRef[];
}

export interface TeamDeploymentRecord {
  team_id: string;
  worker_name: string;
  worker_url: string;
  package_version: string;
  created_at: string;
  last_upgraded: string;
  config_version: number;
}

function resolveTeamDeploymentPath(teamId: string): string {
  return path.join(resolveTeamDir(teamId), 'deployment.json');
}

function list(): TeamRecord[] {
  const teamsDir = resolveTeamsDir();
  if (!fs.existsSync(teamsDir)) return [];
  const results: TeamRecord[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(teamsDir, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(teamsDir, entry.name, 'team.json');
    try { results.push(JSON.parse(fs.readFileSync(configPath, 'utf-8')) as TeamRecord); }
    catch { /* missing/unparseable — skip */ }
  }
  return results;
}

/**
 * Discriminated variant of `list()`. Returns `{ resolved: false }` when the
 * teams directory exists but cannot be read (e.g. ENOTDIR during a migration
 * window). Callers that must distinguish "confirmed no teams" from "couldn't
 * determine" should use this instead of `list()`.
 *
 * `resolved: true` is returned for both "directory does not exist" (confirmed
 * no teams — the directory is created on first join) and "directory readable"
 * (zero or more teams). `resolved: false` means the directory exists but the
 * read failed; the result is indeterminate and callers must not treat it as
 * an empty team set.
 */
export type TeamListResult = { resolved: true; teams: TeamRecord[] } | { resolved: false };

function listResolved(): TeamListResult {
  const teamsDir = resolveTeamsDir();
  if (!fs.existsSync(teamsDir)) return { resolved: true, teams: [] };
  const results: TeamRecord[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(teamsDir, { withFileTypes: true }); }
  catch { return { resolved: false }; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(teamsDir, entry.name, 'team.json');
    try { results.push(JSON.parse(fs.readFileSync(configPath, 'utf-8')) as TeamRecord); }
    catch { /* missing/unparseable — skip */ }
  }
  return { resolved: true, teams: results };
}

function get(teamId: string): TeamRecord | null {
  try { return JSON.parse(fs.readFileSync(resolveTeamConfigPath(teamId), 'utf-8')) as TeamRecord; }
  catch { return null; }
}

function save(record: TeamRecord): void {
  const teamDir = resolveTeamDir(record.team_id);
  fs.mkdirSync(teamDir, { recursive: true });
  const configPath = resolveTeamConfigPath(record.team_id);
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
  fs.renameSync(tmpPath, configPath);
}

function remove(teamId: string): void {
  fs.rmSync(resolveTeamDir(teamId), { recursive: true, force: true });
}

function membershipByProject(): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of list()) for (const ref of record.projects) map.set(ref.project_id, record.team_id);
  return map;
}

function projectsForTeam(teamId: string): TeamProjectRef[] { return get(teamId)?.projects ?? []; }

function readSecrets(teamId: string): Record<string, string> { return readSecretsFile(resolveTeamDir(teamId)); }

function writeSecret(teamId: string, key: string, value: string): void {
  writeSecretFile(resolveTeamDir(teamId), key, value);
}

function readDeployment(teamId: string): TeamDeploymentRecord | null {
  try { return JSON.parse(fs.readFileSync(resolveTeamDeploymentPath(teamId), 'utf-8')) as TeamDeploymentRecord; }
  catch { return null; }
}

function saveDeployment(record: TeamDeploymentRecord): void {
  const teamDir = resolveTeamDir(record.team_id);
  fs.mkdirSync(teamDir, { recursive: true });
  const deploymentPath = resolveTeamDeploymentPath(record.team_id);
  const tmpPath = deploymentPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
  fs.renameSync(tmpPath, deploymentPath);
}

function removeDeployment(teamId: string): void {
  fs.rmSync(resolveTeamDeploymentPath(teamId), { force: true });
}

export function withProjectAdded(record: TeamRecord, ref: TeamProjectRef): TeamRecord {
  if (record.projects.some(p => p.project_id === ref.project_id)) return record;
  return { ...record, projects: [...record.projects, ref] };
}

export function withProjectRemoved(record: TeamRecord, projectId: string): TeamRecord {
  return { ...record, projects: record.projects.filter(p => p.project_id !== projectId) };
}

export const teamRegistry = {
  list, listResolved, get, save, remove, membershipByProject, projectsForTeam,
  readSecrets, writeSecret, readDeployment, saveDeployment, removeDeployment,
};
