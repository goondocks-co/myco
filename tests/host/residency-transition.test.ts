/**
 * Residency attach transition (Phase F) — the daemon-only "backup, then move"
 * orchestrator. Covers the parking sequence outcome, the protocol gate, crash-
 * resume idempotency, and the opposite-transition block on attach/detach.
 *
 * Hermetic: per-test MYCO_HOME (Grove registry) + MYCO_TEAM_HOME (journal) +
 * an in-memory source-Grove DB (the `withGroveDb` seam resolves to it).
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
import { createGroveId, createHostId, createProjectId, projectScope, type GroveProjectId } from '@myco/grove/ids.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import { clearGroveRegistryCaches, createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { findRegisteredProjectById } from '@myco/grove/registry-resolve.js';
import { getHost, resolveAttach, type HostRecord } from '@myco/host/registry.js';
import { attachCommand, detachCommand } from '@myco/host/attach-command.js';
import { membershipErrorCode } from '@myco/host/membership-error.js';
import { beginAttachResidency, completeAttachParking, type ResidencyDaemonDeps } from '@myco/host/residency-transition.js';
import { readResidencyJournal, startResidencyJournal, advanceResidencyPhase } from '@myco/host/residency-journal.js';
import { listPendingForProject } from '@myco/db/queries/team-outbox.js';

let home: string;
let teamHome: string;
let savedTeamHome: string | undefined;
let savedHome: string | undefined;

function deps(): ResidencyDaemonDeps {
  return {
    machineId: 'local',
    mycoHome: home,
    // The in-memory singleton stands in for the source Grove DB; getDatabase()
    // inside the transition helpers already resolves to it.
    withGroveDb: <T,>(_groveId: string, fn: (db: Database) => T): T => fn(getDatabase()),
  };
}

function makeHost(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    host_id: createHostId(),
    label: 'Mac Studio',
    overlay_address: '100.64.0.1:7433',
    protocol_version: 3,
    served_grove_id: createGroveId(),
    created_at: new Date().toISOString(),
    projects: [],
    ...overrides,
  };
}

function makeCheckout(projectId: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-residency-tx-proj-'));
  const vaultDir = resolveProjectVaultDir(root);
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'project.toml'), stringify({ project: { id: projectId, name: 'demo' } }), 'utf-8');
  clearProjectManifestCache();
  return root;
}

function seedProjectRows(projectId: string): void {
  const db = getDatabase();
  db.run('PRAGMA foreign_keys = OFF');
  try {
    db.prepare(
      `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id)
       VALUES ('sp_tx', ?, 'user', 'decision', 'c', 1, 'local')`,
    ).run(projectId);
    db.prepare(
      `INSERT INTO content_claims (id, artifact_kind, artifact_id, generation, project_id, claimed_by, claimed_at, expires_at, state, machine_id)
       VALUES ('cc_tx', 'skill', 'skill_a', 1, ?, 'user', 1, 9999999999, 'active', 'local')`,
    ).run(projectId);
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

beforeEach(() => {
  cleanTestDb();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-residency-tx-home-'));
  teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-residency-tx-team-'));
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

describe('beginAttachResidency', () => {
  test('runs the full parking sequence: backup, park, attach ref, backfill, release claims, → pushing', () => {
    const source = createGrove('Source', home);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    registerProjectInGrove(source.id, { projectId, projectName: 'demo', projectRoot: root }, home);
    seedProjectRows(projectId);
    const host = makeHost();
    writeHostRecordFixture(host);

    const result = beginAttachResidency(
      { hostId: host.host_id, host, projectId, sourceGroveId: source.id, root, mycoHome: home },
      deps(),
    );

    // Journal committed to pushing, with a recorded backup.
    const journal = readResidencyJournal(projectId);
    expect(journal?.phase).toBe('pushing');
    expect(journal?.backup_ref).toBeTruthy();
    expect(fs.existsSync(journal!.backup_ref!)).toBe(true);

    // Local row parked; attach ref recorded against the host's served Grove.
    expect(findRegisteredProjectById(projectId, home)).toBeNull();
    const attach = resolveAttach(projectId);
    expect(attach?.host.host_id).toBe(host.host_id);
    expect(attach?.ref.grove_id).toBe(host.served_grove_id);

    // Rows enqueued; the active content claim released.
    expect(listPendingForProject(projectId).length).toBeGreaterThanOrEqual(1);
    const claim = getDatabase().prepare(`SELECT state FROM content_claims WHERE id = 'cc_tx'`).get() as { state: string };
    expect(claim.state).toBe('released');

    expect(result.groveId).toBe(host.served_grove_id!);
    expect(result.alreadyAttached).toBe(false);
  });

  test('kicks an immediate drain pass on begin (live-forward, not left to the housekeeping round-robin)', () => {
    const source = createGrove('Source', home);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    registerProjectInGrove(source.id, { projectId, projectName: 'demo', projectRoot: root }, home);
    seedProjectRows(projectId);
    const host = makeHost();
    writeHostRecordFixture(host);

    let kicked = 0;
    beginAttachResidency(
      { hostId: host.host_id, host, projectId, sourceGroveId: source.id, root, mycoHome: home },
      { ...deps(), kickResidencyDrain: () => { kicked += 1; } },
    );

    expect(kicked).toBe(1);
  });

  test('protocol gate: a host below the residency protocol refuses AND clears the journal (nothing moved)', () => {
    const source = createGrove('Source', home);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    registerProjectInGrove(source.id, { projectId, projectName: 'demo', projectRoot: root }, home);
    seedProjectRows(projectId);
    const host = makeHost({ protocol_version: 2 }); // predates the residency protocol
    writeHostRecordFixture(host);

    let code: string | null = null;
    try {
      beginAttachResidency({ hostId: host.host_id, host, projectId, sourceGroveId: source.id, root, mycoHome: home }, deps());
    } catch (err) {
      code = membershipErrorCode(err);
    }
    expect(code).toBe('residency_requires_host_update');

    // Journal cleared; the local row is intact and no attach ref was written.
    expect(readResidencyJournal(projectId)).toBeNull();
    expect(findRegisteredProjectById(projectId, home)).not.toBeNull();
    expect(resolveAttach(projectId)).toBeNull();
  });

  test('crash-resume: completeAttachParking is idempotent (re-drive heals without duplicating work)', () => {
    const source = createGrove('Source', home);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    registerProjectInGrove(source.id, { projectId, projectName: 'demo', projectRoot: root }, home);
    seedProjectRows(projectId);
    const host = makeHost();
    writeHostRecordFixture(host);

    beginAttachResidency({ hostId: host.host_id, host, projectId, sourceGroveId: source.id, root, mycoHome: home }, deps());
    const pendingAfterFirst = listPendingForProject(projectId).length;

    // Simulate a crash that left the journal back at parking, then re-drive.
    advanceResidencyPhase(projectId, 'parking');
    completeAttachParking(readResidencyJournal(projectId)!, deps());

    expect(readResidencyJournal(projectId)?.phase).toBe('pushing');
    // No duplicate enqueue, still a single attach ref.
    expect(listPendingForProject(projectId).length).toBe(pendingAfterFirst);
    expect(getHost(host.host_id)?.projects).toHaveLength(1);
  });
});

describe('opposite-transition block', () => {
  test('attachCommand refuses when a residency journal is already in flight', () => {
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    const host = makeHost();
    writeHostRecordFixture(host);
    startResidencyJournal({
      direction: 'attach', phase: 'pushing', host_id: host.host_id, project_id: projectId,
      divert_grove_id: host.served_grove_id!, source_grove_id: createGroveId(), project_name: 'demo',
      root, backup_ref: '/b.sql', cursors: {},
    });

    try {
      attachCommand({ projectPath: root, hostId: host.host_id, mycoHome: home });
      throw new Error('expected refusal');
    } catch (err) {
      expect(membershipErrorCode(err)).toBe('residency_transition_in_flight');
    }
  });

  test('detachCommand refuses when a residency journal is already in flight', () => {
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    startResidencyJournal({
      direction: 'attach', phase: 'pushing', host_id: createHostId(), project_id: projectId,
      divert_grove_id: createGroveId(), source_grove_id: createGroveId(), project_name: 'demo',
      root, backup_ref: '/b.sql', cursors: {},
    });

    try {
      detachCommand({ projectPath: root });
      throw new Error('expected refusal');
    } catch (err) {
      expect(membershipErrorCode(err)).toBe('residency_transition_in_flight');
    }
  });
});
