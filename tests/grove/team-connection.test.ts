import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadTeamConnectionConfig,
  readTeamConnectionSecrets,
  resolveTeamConnectionStore,
  updateTeamConnectionConfig,
  writeTeamConnectionSecret,
} from '@myco/grove/team-connection.js';
import { createGrove } from '@myco/grove/registry.js';
import { TEAM_API_KEY_SECRET } from '@myco/constants.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';

describe('Grove team connection storage', () => {
  let tmpDir: string;
  let mycoHome: string;
  let vaultDir: string;
  let context: MycoRequestContext;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-grove-team-'));
    mycoHome = path.join(tmpDir, 'home');
    vaultDir = path.join(tmpDir, 'project', '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nteam:\n  enabled: false\n', 'utf-8');
    const grove = createGrove('Shared Grove', mycoHome);
    context = {
      projectRoot: path.join(tmpDir, 'project'),
      projectId: 'proj_test',
      groveId: grove.id,
      machineId: 'machine_test',
      sessionId: null,
      projectVaultDir: vaultDir,
      databasePath: path.join(mycoHome, 'groves', grove.id, 'myco.db'),
      source: 'headers',
    };
    process.env.MYCO_HOME = mycoHome;
  });

  afterEach(() => {
    delete process.env.MYCO_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores Grove-era Team connection state under the Grove directory', () => {
    const team = updateTeamConnectionConfig(vaultDir, context, {
      enabled: true,
      worker_url: 'https://team.example.workers.dev',
    });
    writeTeamConnectionSecret(vaultDir, context, TEAM_API_KEY_SECRET, 'secret');

    const store = resolveTeamConnectionStore(vaultDir, context);
    expect(store.scope).toBe('grove');
    expect(store.configPath).toContain(path.join(mycoHome, 'groves', context.groveId!));
    expect(team.enabled).toBe(true);
    expect(loadTeamConnectionConfig(vaultDir, context).worker_url).toBe('https://team.example.workers.dev');
    expect(readTeamConnectionSecrets(vaultDir, context)[TEAM_API_KEY_SECRET]).toBe('secret');
    expect(fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf-8')).toContain('enabled: false');
  });
});
