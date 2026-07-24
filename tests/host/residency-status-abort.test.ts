/**
 * Residency status + abort (Phase F T6). Pins the frozen `residency-status`
 * body shape and the abort matrix per phase/direction.
 */
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase, type Database } from '@myco/db/client.js';
import { clearProjectManifestCache } from '@myco/config/project-manifest.js';
import { createGroveId, createHostId, createProjectId } from '@myco/grove/ids.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import { clearGroveRegistryCaches, createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { findRegisteredProjectById } from '@myco/grove/registry-resolve.js';
import { createHostRegistryOperations, type HostRecord } from '@myco/host/registry.js';
import { membershipErrorCode } from '@myco/host/membership-error.js';
import { abortResidency, residencyStatus, type ResidencyDaemonDeps } from '@myco/host/residency-transition.js';
import {
  appendResidencyStagingRows,
  listResidencyStagingTables,
  readResidencyJournal,
  startResidencyJournal,
} from '@myco/host/residency-journal.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const { attachProject, resolveAttach } = createHostRegistryOperations(testPerUserLockNamespace);

let home: string;
let teamHome: string;
let savedTeamHome: string | undefined;
let savedHome: string | undefined;

function baseDeps(): ResidencyDaemonDeps {
  return {
    machineId: 'local',
    mycoHome: home,
    withGroveDb: <T,>(_g: string, fn: (db: Database) => T): T => fn(getDatabase()),
    lockNamespace: testPerUserLockNamespace,
  };
}

function makeHost(): HostRecord {
  return {
    host_id: createHostId(), label: 'h', overlay_address: '100.64.0.1:7433',
    protocol_version: 3, served_grove_id: createGroveId(), created_at: new Date().toISOString(), projects: [],
  };
}

function makeCheckout(projectId: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-abort-proj-'));
  const vaultDir = resolveProjectVaultDir(root);
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'project.toml'), stringify({ project: { id: projectId, name: 'demo' } }), 'utf-8');
  clearProjectManifestCache();
  return root;
}

function seedPendingOutbox(projectId: string, rowId: string): void {
  getDatabase().prepare(
    `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, project_id, created_at)
     VALUES ('spores', ?, 'upsert', '{}', 'local', ?, 1)`,
  ).run(rowId, projectId);
}

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

beforeEach(() => {
  cleanTestDb();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-abort-home-'));
  teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-abort-team-'));
  savedTeamHome = process.env.MYCO_TEAM_HOME;
  savedHome = process.env.MYCO_HOME;
  process.env.MYCO_TEAM_HOME = teamHome;
  process.env.MYCO_HOME = home;
  clearGroveRegistryCaches();
  clearProjectManifestCache();
});

afterEach(() => {
  if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeamHome;
  if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(teamHome, { recursive: true, force: true });
  clearGroveRegistryCaches();
  clearProjectManifestCache();
});

function attachJournal(projectId: string, source: string, host: HostRecord, root: string, phase: 'parking' | 'pushing') {
  startResidencyJournal({
    direction: 'attach', phase, host_id: host.host_id, project_id: projectId,
    divert_grove_id: host.served_grove_id!, source_grove_id: source, project_name: 'demo', root,
    backup_ref: '/b.sql', cursors: {},
  });
}

function detachJournal(projectId: string, host: HostRecord, root: string, phase: 'pulling' | 'applying' | 'rehoming', targetGrove: string) {
  startResidencyJournal({
    direction: 'detach', phase, host_id: host.host_id, project_id: projectId,
    divert_grove_id: host.served_grove_id!, source_grove_id: host.served_grove_id!, target_grove_id: targetGrove,
    project_name: 'demo', root, backup_ref: null, cursors: { pull: 'done' },
  });
}

describe('residencyStatus — frozen body shape', () => {
  test('no journal → {in_flight:false}', () => {
    expect(residencyStatus(createProjectId(), baseDeps())).toEqual({ in_flight: false });
  });

  test('attach pushing → in_flight with rows_pending = pending outbox count', () => {
    const source = createGrove('Source', home);
    const host = makeHost();
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachJournal(projectId, source.id, host, root, 'pushing');
    seedPendingOutbox(projectId, 'sp1');
    seedPendingOutbox(projectId, 'sp2');

    expect(residencyStatus(projectId, baseDeps())).toEqual({
      in_flight: true, direction: 'attach', phase: 'pushing', rows_pending: 2, last_error: null,
    });
  });

  test('detach pulling → rows_pending null', () => {
    const host = makeHost();
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    detachJournal(projectId, host, root, 'pulling', createGroveId());

    expect(residencyStatus(projectId, baseDeps())).toEqual({
      in_flight: true, direction: 'detach', phase: 'pulling', rows_pending: null, last_error: null,
    });
  });
});

describe('abortResidency — the abort matrix', () => {
  test('attach (pushing): restores the parked local registration, drops the ref, clears the journal + pending rows', () => {
    const source = createGrove('Source', home);
    const host = makeHost();
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    // Pushing state: ref recorded, local row parked (absent), rows queued.
    attachProject(host.host_id, { grove_id: host.served_grove_id!, project_id: projectId, root }, home);
    seedPendingOutbox(projectId, 'sp1');
    attachJournal(projectId, source.id, host, root, 'pushing');

    expect(abortResidency(projectId, baseDeps())).toEqual({ ok: true });

    expect(findRegisteredProjectById(projectId, home)?.grove.id).toBe(source.id); // restored
    expect(resolveAttach(projectId)).toBeNull(); // ref dropped
    expect(readResidencyJournal(projectId)).toBeNull(); // journal cleared
    expect(getDatabase().prepare(`SELECT COUNT(*) AS n FROM team_outbox WHERE project_id = ? AND sent_at IS NULL`).get(projectId)).toEqual({ n: 0 });
  });

  test('detach (pulling): clears the journal + staging, ref stays (still attached)', () => {
    const host = makeHost();
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachProject(host.host_id, { grove_id: host.served_grove_id!, project_id: projectId, root }, home);
    detachJournal(projectId, host, root, 'pulling', createGroveId());
    appendResidencyStagingRows(projectId, [{ table: 'spores', row: { id: 'sp1' } }]);

    expect(abortResidency(projectId, baseDeps())).toEqual({ ok: true });

    expect(readResidencyJournal(projectId)).toBeNull();
    expect(listResidencyStagingTables(projectId)).toEqual([]);
    expect(resolveAttach(projectId)).not.toBeNull(); // still attached — nothing flipped
  });

  test('detach (applying): refuses residency_abort_too_late (flip already happened)', () => {
    const host = makeHost();
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    detachJournal(projectId, host, root, 'applying', createGroveId());

    try {
      abortResidency(projectId, baseDeps());
      throw new Error('expected refusal');
    } catch (err) {
      expect(membershipErrorCode(err)).toBe('residency_abort_too_late');
    }
    expect(readResidencyJournal(projectId)?.phase).toBe('applying'); // untouched
  });

  test('detach (rehoming): refuses residency_abort_too_late', () => {
    const host = makeHost();
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    detachJournal(projectId, host, root, 'rehoming', createGroveId());

    try {
      abortResidency(projectId, baseDeps());
      throw new Error('expected refusal');
    } catch (err) {
      expect(membershipErrorCode(err)).toBe('residency_abort_too_late');
    }
  });

  test('a successful abort kicks a drain pass (so any other in-flight transition resumes promptly)', () => {
    const source = createGrove('Source', home);
    const host = makeHost();
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachProject(host.host_id, { grove_id: host.served_grove_id!, project_id: projectId, root }, home);
    attachJournal(projectId, source.id, host, root, 'pushing');

    let kicked = 0;
    abortResidency(projectId, { ...baseDeps(), kickResidencyDrain: () => { kicked += 1; } });

    expect(kicked).toBe(1);
  });

  test('no in-flight transition: refuses residency_abort_too_late', () => {
    try {
      abortResidency(createProjectId(), baseDeps());
      throw new Error('expected refusal');
    } catch (err) {
      expect(membershipErrorCode(err)).toBe('residency_abort_too_late');
    }
  });
});
