import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { aggregateTeamSyncRows, aggregateTeamPending } from '@myco/daemon/team-sync-counts.js';
import { computeProjectScopedDrift } from '@myco/daemon/api/team-connect.js';
import { openDatabase } from '@myco/db/client.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { createGrove, type GroveRecord } from '@myco/grove/registry.js';

const MACHINE_ID = 'machine-test';

/**
 * Regression coverage for the cross-grove team-count bug: a team is
 * machine-wide, so its projects can live in different groves — each with its
 * own SQLite DB. Counting from a single grove-scoped handle undercounts the
 * others and reads a phantom cloud delta. `aggregateTeamSyncRows` must sum
 * across exactly the groves that own a team project, honoring project and
 * machine scoping and skipping non-team groves.
 */
describe('aggregateTeamSyncRows', () => {
  let workDir: string;
  let mycoHome: string;
  let previousMycoHome: string | undefined;
  let logger: DaemonLogger;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-sync-counts-'));
    mycoHome = path.join(workDir, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    logger = new DaemonLogger(path.join(workDir, 'logs'), { level: 'error' });
  });

  afterEach(() => {
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function createGroveWithDb(name: string): GroveRecord {
    const grove = createGrove(name, mycoHome);
    ensureGroveDatabase(grove.id, mycoHome);
    return grove;
  }

  /** Seed `count` observed rows into a grove's own DB for (project, machine). */
  function seedRows(groveId: string, projectId: string, machineId: string, count: number): void {
    const db = openDatabase(resolveGroveDbPath(groveId, mycoHome));
    try {
      const insert = db.prepare(
        `INSERT INTO knowledge_release_state
           (project_id, machine_id, identity_key, namespace, record_id, state, confidence, checked_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'present', 'high', 0, 0)`,
      );
      for (let i = 0; i < count; i += 1) {
        // identity_key is UNIQUE; namespace it by grove/project/machine/index.
        insert.run(projectId, machineId, `${groveId}:${projectId}:${machineId}:${i}`, 'test', `rec-${i}`);
      }
    } finally {
      db.close();
    }
  }

  /** Seed `count` unsent outbox rows into a grove's DB for a project. */
  function seedOutbox(groveId: string, projectId: string, count: number): void {
    const db = openDatabase(resolveGroveDbPath(groveId, mycoHome));
    try {
      const insert = db.prepare(
        `INSERT INTO team_outbox (table_name, row_id, payload, machine_id, project_id, created_at)
         VALUES ('spores', ?, '{}', ?, ?, 0)`,
      );
      for (let i = 0; i < count; i += 1) insert.run(`${groveId}:${projectId}:${i}`, MACHINE_ID, projectId);
    } finally {
      db.close();
    }
  }

  it('sums a team\'s rows across every owning grove, ignoring other groves/projects/machines', async () => {
    const groveA = createGroveWithDb('Default');
    const groveB = createGroveWithDb('OSS');
    const groveC = createGroveWithDb('Unrelated');

    // Team spans groveA + groveB. groveC is not part of the team.
    seedRows(groveA.id, 'proj-a', MACHINE_ID, 3);
    seedRows(groveB.id, 'proj-b', MACHINE_ID, 2);
    // Decoys that must NOT be counted:
    seedRows(groveB.id, 'proj-other', MACHINE_ID, 5); // non-team project in a team grove
    seedRows(groveB.id, 'proj-b', 'other-machine', 4); // team project but different machine
    seedRows(groveC.id, 'proj-c', MACHINE_ID, 7); // project in a non-team grove

    const cache = new GroveRuntimeCache();
    try {
      const result = await aggregateTeamSyncRows(cache, logger, MACHINE_ID, [
        { grove_id: groveA.id, project_id: 'proj-a' },
        { grove_id: groveB.id, project_id: 'proj-b' },
      ]);

      // 3 (groveA/proj-a) + 2 (groveB/proj-b) — decoys excluded.
      expect(result.tables.knowledge_release_state).toBe(5);
      expect(result.grovesServed).toBe(2);
      expect(result.pending).toBe(0);
    } finally {
      cache.closeAll();
    }
  });

  it('reports grovesServed=0 when this home serves none of the team\'s groves', async () => {
    createGroveWithDb('Local');
    const cache = new GroveRuntimeCache();
    try {
      const result = await aggregateTeamSyncRows(cache, logger, MACHINE_ID, [
        { grove_id: 'grove_ffffffffffffffffffffffffffffffff', project_id: 'proj-x' },
      ]);
      expect(result.grovesServed).toBe(0);
      expect(result.tables.knowledge_release_state).toBe(0);
      expect(result.pending).toBe(0);
    } finally {
      cache.closeAll();
    }
  });

  it('counts only served groves when a team project lives in a grove absent from this home', async () => {
    const groveA = createGroveWithDb('Default');
    seedRows(groveA.id, 'proj-a', MACHINE_ID, 5);
    const cache = new GroveRuntimeCache();
    try {
      const result = await aggregateTeamSyncRows(cache, logger, MACHINE_ID, [
        { grove_id: groveA.id, project_id: 'proj-a' },
        { grove_id: 'grove_ffffffffffffffffffffffffffffffff', project_id: 'proj-absent' },
      ]);
      expect(result.grovesServed).toBe(1);
      expect(result.tables.knowledge_release_state).toBe(5);
    } finally {
      cache.closeAll();
    }
  });

  it('yields zero drift for a two-grove team whose cloud received all its rows', async () => {
    // The regression this fix guards: with grove-scoped local counting, a team
    // spanning two groves read a phantom positive delta from any single grove.
    const groveA = createGroveWithDb('Default');
    const groveB = createGroveWithDb('OSS');
    seedRows(groveA.id, 'proj-a', MACHINE_ID, 4);
    seedRows(groveB.id, 'proj-b', MACHINE_ID, 3);

    const cache = new GroveRuntimeCache();
    try {
      const local = await aggregateTeamSyncRows(cache, logger, MACHINE_ID, [
        { grove_id: groveA.id, project_id: 'proj-a' },
        { grove_id: groveB.id, project_id: 'proj-b' },
      ]);
      expect(local.grovesServed).toBe(2);
      expect(local.tables.knowledge_release_state).toBe(7);

      // Cloud (machine_tables) holds exactly this machine's rows across both
      // groves. The cross-grove local total must match it → zero drift.
      const cloud = { ...local.tables };
      const drift = computeProjectScopedDrift(local.tables, cloud);
      const totalDelta = drift.reduce((sum, d) => sum + Math.abs(d.delta), 0);
      expect(totalDelta).toBe(0);
    } finally {
      cache.closeAll();
    }
  });

  it('sums pending outbox rows across owning groves (pending-only fan-out)', async () => {
    const groveA = createGroveWithDb('Default');
    const groveB = createGroveWithDb('OSS');
    seedOutbox(groveA.id, 'proj-a', 2);
    seedOutbox(groveB.id, 'proj-b', 3);
    seedOutbox(groveB.id, 'proj-other', 9); // non-team project — excluded

    const cache = new GroveRuntimeCache();
    try {
      const pending = await aggregateTeamPending(cache, logger, [
        { grove_id: groveA.id, project_id: 'proj-a' },
        { grove_id: groveB.id, project_id: 'proj-b' },
      ]);
      expect(pending).toBe(5);
    } finally {
      cache.closeAll();
    }
  });
});
