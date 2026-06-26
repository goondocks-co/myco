/**
 * Tests for the registry-driven team-sync READ path + MCP token provisioning.
 *
 * Phase 2.3: getTeamClient(requestContext) is now registry-aware. When the
 * request carries a projectId that belongs to a team, it resolves the team's
 * per-team client (built from the registry, MCP token and all). Contexts with
 * no project / no team membership fall back to the legacy per-Grove client.
 *
 * Also covers ensureTeamProvisioned (run inside flushPending after a
 * successful handoff): rotate + persist the MCP token into the registry when
 * absent, and never re-rotate when already present.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';

// Tracks rotateMcpToken/getConfig/putConfig calls per worker_url so the
// provisioning assertions can see exactly which worker was reached.
const rotateCalls: string[] = [];
const getConfigCalls: string[] = [];
const putConfigCalls: Array<{ url: string; config: Record<string, string> }> = [];
// Drives whether getConfig() reports an already-provisioned team_name.
let getConfigReturnsName = false;
// Drives whether getConfig() reports the worker-authoritative team_id.
let getConfigTeamId: string | null = null;

const setTeamSyncEnabledMock = vi.fn();

// Mock the per-team client. getMcpToken/getMcpEndpoint reflect the ctor's
// mcpToken so the read-path assertions can verify the registry token flows
// through. enqueueBatch always accepts so flushPending reaches provisioning.
mock.module('@myco/daemon/team-sync.js', () => ({
  TeamSyncClient: class {
    private readonly workerUrl: string;
    private mcpToken: string | null;
    constructor(options: { workerUrl: string; mcpToken?: string }) {
      this.workerUrl = options.workerUrl.replace(/\/+$/, '');
      this.mcpToken = options.mcpToken ?? null;
    }
    connect = vi.fn();
    enqueueBatch = async (records: Array<{ row_id: string }>) => ({
      accepted: records.length,
      rejected: [] as Array<{ id: string }>,
    });
    getMcpToken = () => this.mcpToken;
    getMcpEndpoint = () => (this.mcpToken ? `${this.workerUrl}/mcp` : null);
    rotateMcpToken = async () => {
      rotateCalls.push(this.workerUrl);
      this.mcpToken = `rotated-token-for-${this.workerUrl}`;
      return this.mcpToken;
    };
    getConfig = async () => {
      getConfigCalls.push(this.workerUrl);
      const config: Record<string, string> = {};
      if (getConfigReturnsName) config.team_name = 'Existing Team';
      if (getConfigTeamId) config.team_id = getConfigTeamId;
      return { config };
    };
    putConfig = async (config: Record<string, string>) => {
      putConfigCalls.push({ url: this.workerUrl, config });
      return { updated: Object.keys(config).length };
    };
  },
}));

mock.module('@myco/db/queries/team-sync-state.js', () => ({
  setTeamSyncEnabled: setTeamSyncEnabledMock,
  getTeamSyncEnabled: vi.fn(() => true),
}));

import { initTeamSync } from '@myco/daemon/team-sync-init.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { withDatabase } from '@myco/db/client.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { createGrove, registerProjectInGrove, type GroveRecord } from '@myco/grove/registry.js';
import { enqueueOutbox } from '@myco/db/queries/team-outbox.js';
import { teamRegistry, type TeamRecord } from '@myco/team/registry.js';
import { createTeamId, createProjectId } from '@myco/grove/ids.js';
import { TEAM_MCP_TOKEN_SECRET } from '@myco/constants.js';

describe('team-sync READ path + MCP token from the registry', () => {
  let tmpDir: string;
  let mycoHome: string;
  let bootVaultDir: string;
  let previousMycoHome: string | undefined;
  let previousTeamHome: string | undefined;
  let prevLegacyHomes: string | undefined;
  let logger: DaemonLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-read-'));
    mycoHome = path.join(tmpDir, 'home');
    bootVaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(mycoHome, { recursive: true });
    fs.mkdirSync(path.join(mycoHome, 'service'), { recursive: true });
    fs.mkdirSync(bootVaultDir, { recursive: true });
    previousMycoHome = process.env.MYCO_HOME;
    previousTeamHome = process.env.MYCO_TEAM_HOME;
    prevLegacyHomes = process.env.MYCO_TEAM_LEGACY_HOMES;
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = path.join(mycoHome, 'team-home');
    process.env.MYCO_TEAM_LEGACY_HOMES = '';
    logger = new DaemonLogger(path.join(tmpDir, 'logs'), { level: 'error' });
    rotateCalls.length = 0;
    getConfigCalls.length = 0;
    putConfigCalls.length = 0;
    getConfigReturnsName = false;
    getConfigTeamId = null;
    setTeamSyncEnabledMock.mockReset();
  });

  afterEach(() => {
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    if (previousTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = previousTeamHome;
    if (prevLegacyHomes === undefined) delete process.env.MYCO_TEAM_LEGACY_HOMES;
    else process.env.MYCO_TEAM_LEGACY_HOMES = prevLegacyHomes;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registerTeam(
    name: string,
    grove: GroveRecord,
    projectId: string,
    opts: { mcpToken?: string } = {},
  ): TeamRecord {
    const projectRoot = path.join(tmpDir, 'projects', projectId);
    fs.mkdirSync(projectRoot, { recursive: true });
    registerProjectInGrove(
      grove.id,
      { projectId, projectName: `${name} Project`, projectRoot },
      mycoHome,
    );
    const teamId = createTeamId();
    const record: TeamRecord = {
      team_id: teamId,
      name,
      worker_url: `https://team-${teamId}.example.workers.dev`,
      domain: null,
      mcp_endpoint: null,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: grove.id, project_id: projectId }],
    };
    teamRegistry.save(record);
    teamRegistry.writeSecret(teamId, 'MYCO_TEAM_API_KEY', `secret-${teamId}`);
    if (opts.mcpToken) {
      teamRegistry.writeSecret(teamId, TEAM_MCP_TOKEN_SECRET, opts.mcpToken);
    }
    return record;
  }

  function buildCtx(grove: GroveRecord, projectId: string) {
    return {
      projectRoot: tmpDir,
      projectVaultDir: bootVaultDir,
      projectId,
      groveId: grove.id,
      machineId: 'machine-1',
      sessionId: null,
      databasePath: path.join(mycoHome, 'groves', grove.id, 'myco.db'),
      source: 'explicit',
    } as never;
  }

  function makeTeamSync() {
    return initTeamSync({
      liveConfig: { current: { team: { enabled: false, worker_url: undefined } } } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir: bootVaultDir,
      serverVersion: '1.2.3',
      daemonStateDir: path.join(mycoHome, 'service'),
    });
  }

  it('(4) resolves the project team client whose MCP token + endpoint come from the registry', () => {
    const grove = createGrove('Shared', mycoHome);
    const projectId = createProjectId();
    const team = registerTeam('Team Alpha', grove, projectId, { mcpToken: 'mcp-from-registry' });

    const teamSync = makeTeamSync();
    const client = teamSync.getTeamClient(buildCtx(grove, projectId));

    expect(client).not.toBeNull();
    expect(client!.getMcpToken()).toBe('mcp-from-registry');
    expect(client!.getMcpEndpoint()).toBe(`${team.worker_url}/mcp`);
  });

  it('(4) falls back to legacy (null here) for a context whose project belongs to no team', () => {
    const grove = createGrove('Shared', mycoHome);
    registerTeam('Team Alpha', grove, createProjectId(), { mcpToken: 'mcp-from-registry' });

    const teamSync = makeTeamSync();
    // Unknown project → no registry membership → legacy per-Grove map, which
    // is empty in this fixture → null.
    const client = teamSync.getTeamClient(buildCtx(grove, createProjectId()));
    expect(client).toBeNull();
  });

  it('(3) ensureTeamProvisioned rotates + writes the MCP token when absent (via flushPending)', async () => {
    const grove = createGrove('Shared', mycoHome);
    ensureGroveDatabase(grove.id, mycoHome);
    const cache = new GroveRuntimeCache();
    const projectId = createProjectId();
    const team = registerTeam('Team Alpha', grove, projectId); // no MCP token yet

    const groveDbPath = path.join(mycoHome, 'groves', grove.id, 'myco.db');
    withDatabase(cache.getDatabase(groveDbPath), () => {
      enqueueOutbox({
        table_name: 'spores', row_id: 'spore-a',
        payload: JSON.stringify({ id: 'spore-a', project_id: projectId }),
        machine_id: 'machine-1', project_id: projectId, created_at: 100,
      });
    });

    const teamSync = makeTeamSync();
    await withDatabase(cache.getDatabase(groveDbPath), () =>
      teamSync.flushPending(buildCtx(grove, projectId)),
    );

    // Token was rotated once and persisted into the registry.
    expect(rotateCalls).toEqual([team.worker_url]);
    expect(teamRegistry.readSecrets(team.team_id)[TEAM_MCP_TOKEN_SECRET])
      .toBe(`rotated-token-for-${team.worker_url}`);
    // /config was seeded with both the worker-authoritative team_id and the
    // team name + embedding config — one PUT body per missing key group.
    expect(putConfigCalls).toHaveLength(2);
    const configs = putConfigCalls.map((c) => c.config);
    expect(configs.some((c) => c.team_id === team.team_id)).toBe(true);
    expect(configs.some((c) =>
      c.team_name === 'Team Alpha'
      && c.embedding_model === '@cf/baai/bge-m3'
      && c.embedding_dimensions === '1024',
    )).toBe(true);

    cache.closeAll();
  });

  it('(3) ensureTeamProvisioned does not re-rotate when the token already exists', async () => {
    const grove = createGrove('Shared', mycoHome);
    ensureGroveDatabase(grove.id, mycoHome);
    const cache = new GroveRuntimeCache();
    const projectId = createProjectId();
    // Token already present + config already provisioned (team_name AND the
    // worker-authoritative team_id) → fully idempotent, nothing re-seeded.
    const provisioned = registerTeam('Team Alpha', grove, projectId, { mcpToken: 'already-here' });
    getConfigReturnsName = true;
    getConfigTeamId = provisioned.team_id;

    const groveDbPath = path.join(mycoHome, 'groves', grove.id, 'myco.db');
    withDatabase(cache.getDatabase(groveDbPath), () => {
      enqueueOutbox({
        table_name: 'spores', row_id: 'spore-a',
        payload: JSON.stringify({ id: 'spore-a', project_id: projectId }),
        machine_id: 'machine-1', project_id: projectId, created_at: 100,
      });
    });

    const teamSync = makeTeamSync();
    await withDatabase(cache.getDatabase(groveDbPath), () =>
      teamSync.flushPending(buildCtx(grove, projectId)),
    );

    expect(rotateCalls).toEqual([]); // never re-rotated
    expect(putConfigCalls).toHaveLength(0); // never re-seeded
    // The pre-existing token is untouched.
    const team = teamRegistry.list()[0];
    expect(teamRegistry.readSecrets(team.team_id)[TEAM_MCP_TOKEN_SECRET])
      .toBe('already-here');

    cache.closeAll();
  });
});
