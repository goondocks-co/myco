/**
 * Integration tests for the registry-driven team-sync DRAIN routing.
 *
 * flushPending no longer pushes every pending outbox row through a single
 * per-Grove client. Instead it consults the team registry and routes each
 * row to the worker of the team that owns its project:
 *
 *   - project_id belongs to a team   → that team's worker
 *   - project_id belongs to no team  → DROP (markSent, never sent)
 *   - project_id == null (machine-    → fan out to EVERY team this Grove
 *     scoped, e.g. team_members)        participates in
 *
 * The registry — not the Grove config — is the participation gate: a Grove
 * syncs iff at least one of its projects is a member of some team.
 *
 * See plan: Phase 2.2 daemon per-project sync gating + drain routing.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';

// Records every enqueueBatch call keyed by team tag (parsed from worker_url),
// so each assertion can see exactly which rows reached which team's worker.
const enqueueByTeam = new Map<string, Array<{ table_name: string; row_id: string }>>();
const setTeamSyncEnabledMock = vi.fn();

// Mock the per-team client. getOrBuildTeamClient constructs this with the
// team's worker_url, shaped `https://team-<teamId>...` in the fixtures below,
// so we can route each enqueueBatch back to its originating team.
mock.module('@myco/daemon/team-sync.js', () => ({
  TeamSyncClient: class {
    private readonly teamTag: string;
    constructor(options: { workerUrl: string }) {
      const match = options.workerUrl.match(/team-([^.]+)/);
      this.teamTag = match ? match[1] : 'unknown';
    }
    connect = vi.fn();
    enqueueBatch = async (records: Array<{ table_name: string; row_id: string }>) => {
      const list = enqueueByTeam.get(this.teamTag) ?? [];
      for (const r of records) list.push({ table_name: r.table_name, row_id: r.row_id });
      enqueueByTeam.set(this.teamTag, list);
      return { accepted: records.length, rejected: [] as Array<{ id: string }> };
    };
    getCollectiveStatus = vi.fn();
    getMcpToken = vi.fn(() => null);
    getMcpEndpoint = vi.fn(() => null);
  },
}));

// flushPending writes this Grove's team_sync_state flag via the real query
// layer. The grove DB here is a real SQLite handle, but spy on the flag write
// so we can assert the participation gate directly.
mock.module('@myco/db/queries/team-sync-state.js', () => ({
  setTeamSyncEnabled: setTeamSyncEnabledMock,
  getTeamSyncEnabled: vi.fn(() => true),
}));

import { initTeamSync } from '@myco/daemon/team-sync-init.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { withDatabase } from '@myco/db/client.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { createGrove, type GroveRecord } from '@myco/grove/registry.js';
import { enqueueOutbox, listPending } from '@myco/db/queries/team-outbox.js';
import { teamRegistry, type TeamRecord } from '@myco/team/registry.js';
import { createTeamId, createProjectId } from '@myco/grove/ids.js';

describe('team-sync DRAIN routing from the registry', () => {
  let tmpDir: string;
  let mycoHome: string;
  let bootVaultDir: string;
  let previousMycoHome: string | undefined;
  let logger: DaemonLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-routing-'));
    mycoHome = path.join(tmpDir, 'home');
    bootVaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(mycoHome, { recursive: true });
    fs.mkdirSync(path.join(mycoHome, 'service'), { recursive: true });
    fs.mkdirSync(bootVaultDir, { recursive: true });
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    logger = new DaemonLogger(path.join(tmpDir, 'logs'), { level: 'error' });
    enqueueByTeam.clear();
    setTeamSyncEnabledMock.mockReset();
  });

  afterEach(() => {
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registerTeam(name: string, grove: GroveRecord, projectId: string): TeamRecord {
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
    teamRegistry.save(record, mycoHome);
    teamRegistry.writeSecret(teamId, 'MYCO_TEAM_API_KEY', `secret-${teamId}`, mycoHome);
    return record;
  }

  function groveDbPath(grove: GroveRecord): string {
    return path.join(mycoHome, 'groves', grove.id, 'myco.db');
  }

  function seed(grove: GroveRecord, cache: GroveRuntimeCache, fn: () => void): void {
    withDatabase(cache.getDatabase(groveDbPath(grove)), fn);
  }

  function pendingCount(grove: GroveRecord, cache: GroveRuntimeCache): number {
    return withDatabase(cache.getDatabase(groveDbPath(grove)), () => listPending().length);
  }

  function buildGroveCtx(grove: GroveRecord) {
    return {
      projectRoot: tmpDir,
      projectVaultDir: bootVaultDir,
      projectId: 'placeholder',
      groveId: grove.id,
      machineId: 'machine-1',
      sessionId: null,
      databasePath: groveDbPath(grove),
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

  it('routes each project row to its team, drops non-member rows, fans out machine-scoped rows', async () => {
    const grove = createGrove('Shared', mycoHome);
    ensureGroveDatabase(grove.id, mycoHome);
    const cache = new GroveRuntimeCache();

    // projA → teamA, projB → teamB; both projects live in the same Grove.
    const projA = createProjectId();
    const projB = createProjectId();
    const projC = createProjectId(); // member of NO team
    const teamA = registerTeam('Team Alpha', grove, projA);
    const teamB = registerTeam('Team Bravo', grove, projB);

    seed(grove, cache, () => {
      enqueueOutbox({
        table_name: 'spores', row_id: 'spore-a',
        payload: JSON.stringify({ id: 'spore-a', project_id: projA }),
        machine_id: 'machine-1', project_id: projA, created_at: 100,
      });
      enqueueOutbox({
        table_name: 'spores', row_id: 'spore-b',
        payload: JSON.stringify({ id: 'spore-b', project_id: projB }),
        machine_id: 'machine-1', project_id: projB, created_at: 101,
      });
      enqueueOutbox({
        table_name: 'spores', row_id: 'spore-c',
        payload: JSON.stringify({ id: 'spore-c', project_id: projC }),
        machine_id: 'machine-1', project_id: projC, created_at: 102,
      });
      // Machine-scoped row: no project_id → fan out to every participating team.
      enqueueOutbox({
        table_name: 'team_members', row_id: 'machine-1',
        payload: JSON.stringify({ id: 'machine-1', machine_id: 'machine-1' }),
        machine_id: 'machine-1', project_id: null, created_at: 103,
      });
    });

    expect(pendingCount(grove, cache)).toBe(4);

    const teamSync = makeTeamSync();
    const result = await withDatabase(cache.getDatabase(groveDbPath(grove)), () =>
      teamSync.flushPending(buildGroveCtx(grove)),
    );

    // Participation gate: this Grove feeds two teams → enabled = true.
    expect(setTeamSyncEnabledMock).toHaveBeenCalledWith(true);

    // teamA got the projA spore; teamB got the projB spore.
    const aRows = enqueueByTeam.get(teamA.team_id) ?? [];
    const bRows = enqueueByTeam.get(teamB.team_id) ?? [];
    expect(aRows.some((r) => r.row_id === 'spore-a')).toBe(true);
    expect(aRows.some((r) => r.row_id === 'spore-b')).toBe(false);
    expect(bRows.some((r) => r.row_id === 'spore-b')).toBe(true);
    expect(bRows.some((r) => r.row_id === 'spore-a')).toBe(false);

    // projC (non-member) was dropped: never sent to any team's worker.
    for (const rows of enqueueByTeam.values()) {
      expect(rows.some((r) => r.row_id === 'spore-c')).toBe(false);
    }

    // team_members (null project_id) fanned out to BOTH teams.
    expect(aRows.some((r) => r.table_name === 'team_members')).toBe(true);
    expect(bRows.some((r) => r.table_name === 'team_members')).toBe(true);

    // The outbox fully drained: 2 routed + 1 dropped + 1 fanned-out, all cleared.
    expect(pendingCount(grove, cache)).toBe(0);
    expect(result.error).toBeUndefined();
    // 2 project rows + 1 fanned-out row marked sent = 3 handed off.
    expect(result.handedOff).toBe(3);

    cache.closeAll();
  });

  it('sets enabled false and sends nothing when the Grove has no member projects', async () => {
    const grove = createGrove('Lonely', mycoHome);
    ensureGroveDatabase(grove.id, mycoHome);
    const cache = new GroveRuntimeCache();

    // A team exists, but its project lives in a DIFFERENT grove — this Grove
    // participates in nothing.
    const otherGrove = createGrove('Elsewhere', mycoHome);
    registerTeam('Team Elsewhere', otherGrove, createProjectId());

    seed(grove, cache, () => {
      enqueueOutbox({
        table_name: 'spores', row_id: 'spore-x',
        payload: JSON.stringify({ id: 'spore-x' }),
        machine_id: 'machine-1', project_id: createProjectId(), created_at: 200,
      });
    });
    expect(pendingCount(grove, cache)).toBe(1);

    const teamSync = makeTeamSync();
    const result = await withDatabase(cache.getDatabase(groveDbPath(grove)), () =>
      teamSync.flushPending(buildGroveCtx(grove)),
    );

    expect(setTeamSyncEnabledMock).toHaveBeenCalledWith(false);
    expect(result.handedOff).toBe(0);
    expect(result.batches).toBe(0);
    // Nothing was sent to any worker.
    expect(enqueueByTeam.size).toBe(0);
    // Non-participating Grove leaves its outbox untouched (not dropped).
    expect(pendingCount(grove, cache)).toBe(1);

    cache.closeAll();
  });
});
