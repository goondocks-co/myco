import fs from 'node:fs';
import path from 'node:path';

import {
  readSecrets as readSecretsFile,
  writeSecret as writeSecretFile,
} from '../config/secrets.js';
import {
  resolveMycoHome,
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

function list(mycoHome = resolveMycoHome()): TeamRecord[] {
  const teamsDir = resolveTeamsDir(mycoHome);
  if (!fs.existsSync(teamsDir)) return [];

  const results: TeamRecord[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(teamsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(teamsDir, entry.name, 'team.json');
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      results.push(JSON.parse(raw) as TeamRecord);
    } catch {
      // Missing or unparseable — skip silently
    }
  }

  return results;
}

function get(teamId: string, mycoHome = resolveMycoHome()): TeamRecord | null {
  const configPath = resolveTeamConfigPath(teamId, mycoHome);
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as TeamRecord;
  } catch {
    return null;
  }
}

function save(record: TeamRecord, mycoHome = resolveMycoHome()): void {
  const teamDir = resolveTeamDir(record.team_id, mycoHome);
  fs.mkdirSync(teamDir, { recursive: true });

  const configPath = resolveTeamConfigPath(record.team_id, mycoHome);
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
  fs.renameSync(tmpPath, configPath);
}

function remove(teamId: string, mycoHome = resolveMycoHome()): void {
  fs.rmSync(resolveTeamDir(teamId, mycoHome), { recursive: true, force: true });
}

function membershipByProject(mycoHome = resolveMycoHome()): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of list(mycoHome)) {
    for (const ref of record.projects) {
      map.set(ref.project_id, record.team_id);
    }
  }
  return map;
}

function projectsForTeam(teamId: string, mycoHome = resolveMycoHome()): TeamProjectRef[] {
  return get(teamId, mycoHome)?.projects ?? [];
}

function readSecrets(teamId: string, mycoHome = resolveMycoHome()): Record<string, string> {
  return readSecretsFile(resolveTeamDir(teamId, mycoHome));
}

function writeSecret(teamId: string, key: string, value: string, mycoHome = resolveMycoHome()): void {
  writeSecretFile(resolveTeamDir(teamId, mycoHome), key, value);
}

export const teamRegistry = {
  list,
  get,
  save,
  remove,
  membershipByProject,
  projectsForTeam,
  readSecrets,
  writeSecret,
};
