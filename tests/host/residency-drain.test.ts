/**
 * Residency drain (Phase F) — ships a `pushing` transition and, on full ack,
 * purges the local rows. Covers the push wire (per-table batches, adoption on
 * the first batch only, correct tenancy), the ack discipline (markSent /
 * markSourceRowsSynced), failure-does-not-advance, and delete-after-ack
 * (ZERO project rows across every scoped table, no delete tombstones, other
 * projects untouched, journal cleared).
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
import { GROVE_PROJECT_SCOPED_TABLES } from '@myco/db/schema-ddl.js';
import { createGroveId, createHostId, createProjectId } from '@myco/grove/ids.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import { clearGroveRegistryCaches, createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { findRegisteredProjectById } from '@myco/grove/registry-resolve.js';
import { type HostRecord } from '@myco/host/registry.js';
import { abortResidency, beginAttachResidency, type ResidencyDaemonDeps } from '@myco/host/residency-transition.js';
import {
  countResidencyInFlight,
  createResidencyKicker,
  runResidencyTransitions,
  type ResidencyPostTransport,
  type ResolveResidencyTarget,
} from '@myco/host/residency-drain.js';
import { readResidencyJournal } from '@myco/host/residency-journal.js';
import { listPendingForProject } from '@myco/db/queries/team-outbox.js';
import type { RemoteTarget } from '@myco/host/routing.js';
import type { GroveProjectId } from '@myco/grove/ids.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

let home: string;
let teamHome: string;
let savedTeamHome: string | undefined;
let savedHome: string | undefined;

function baseDeps(): ResidencyDaemonDeps {
  return {
    machineId: 'local',
    mycoHome: home,
    lockNamespace: testPerUserLockNamespace,
    withGroveDb: <T,>(_groveId: string, fn: (db: Database) => T): T => fn(getDatabase()),
  };
}

function makeHost(): HostRecord {
  return {
    host_id: createHostId(),
    label: 'Mac Studio',
    overlay_address: '100.64.0.1:7433',
    protocol_version: 3,
    served_grove_id: createGroveId(),
    created_at: new Date().toISOString(),
    projects: [],
  };
}

function makeCheckout(projectId: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-residency-drain-proj-'));
  const vaultDir = resolveProjectVaultDir(root);
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'project.toml'), stringify({ project: { id: projectId, name: 'demo' } }), 'utf-8');
  clearProjectManifestCache();
  return root;
}

/** Seed a representative spread of project-scoped tables (incl. a FK-NOT-NULL
 *  table, sidecar tables, and a publication). FK off so seeding needs no parents. */
function seedProjectRows(projectId: string, suffix: string): void {
  const db = getDatabase();
  db.run('PRAGMA foreign_keys = OFF');
  try {
    db.prepare(`INSERT INTO sessions (id, agent, started_at, created_at, project_id, machine_id) VALUES (?, 'claude-code', 1, 1, ?, 'local')`).run(`sess_${suffix}`, projectId);
    db.prepare(`INSERT INTO prompt_batches (id, project_id, session_id, created_at, machine_id) VALUES (?, ?, ?, 1, 'local')`).run(`pbatch_${suffix}`, projectId, `sess_${suffix}`);
    db.prepare(`INSERT INTO activities (project_id, session_id, prompt_batch_id, tool_name, timestamp, created_at) VALUES (?, ?, ?, 'Read', 1, 1)`).run(projectId, `sess_${suffix}`, `pbatch_${suffix}`);
    db.prepare(`INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id) VALUES (?, ?, 'user', 'decision', 'c', 1, 'local')`).run(`sp_${suffix}`, projectId);
    db.prepare(`INSERT INTO plans (id, logical_key, project_id, created_at, machine_id) VALUES (?, 'lk', ?, 1, 'local')`).run(`plan_${suffix}`, projectId);
    db.prepare(`INSERT INTO entities (id, project_id, agent_id, type, name, first_seen, last_seen, machine_id) VALUES (?, ?, 'user', 'file', 'n', 1, 1, 'local')`).run(`ent_${suffix}`, projectId);
    db.prepare(`INSERT INTO entity_mentions (project_id, entity_id, note_id, note_type, agent_id, machine_id) VALUES (?, ?, ?, 'session', 'user', 'local')`).run(projectId, `ent_${suffix}`, `note_${suffix}`);
    db.prepare(`INSERT INTO skill_records (id, project_id, agent_id, name, display_name, description, path, created_at, updated_at) VALUES (?, ?, 'user', 'n', 'N', 'd', 'p', 1, 1)`).run(`skill_${suffix}`, projectId);
    db.prepare(`INSERT INTO content_publications (artifact_kind, artifact_id, published_generation, published_at, published_by, machine_id) VALUES ('skill', ?, 1, 1, 'user', 'local')`).run(`skill_${suffix}`);
    // WITHOUT ROWID tables — a rowid-keyed delete cannot even prepare against
    // these, so the purge must reach them via a plain project_id delete.
    db.prepare(`INSERT INTO canopy_entries (project_id, machine_id, path, content_hash, size_bytes, token_estimate, line_count, mechanical_updated_at) VALUES (?, 'local', ?, 'h', 1, 1, 1, 1)`).run(projectId, `p/${suffix}`);
    db.prepare(`INSERT INTO canopy_maps (project_id, machine_id, content, inputs_hash, generated_at, token_estimate) VALUES (?, 'local', 'c', 'h', 1, 1)`).run(projectId);
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}

function countProjectRows(projectId: string): number {
  const db = getDatabase();
  let total = 0;
  for (const table of GROVE_PROJECT_SCOPED_TABLES) {
    try {
      total += (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(projectId) as { n: number }).n;
    } catch { /* table absent in this schema — skip */ }
  }
  return total;
}

/** Begin a transition for a fresh project, returning its ids + host. */
function beginTransition(): { projectId: string; host: HostRecord; source: { id: string } } {
  const source = createGrove('Source', home);
  const projectId = createProjectId();
  const root = makeCheckout(projectId);
  registerProjectInGrove(source.id, { projectId, projectName: 'demo', projectRoot: root }, home);
  seedProjectRows(projectId, 'a');
  const host = makeHost();
  writeHostRecordFixture(host);
  beginAttachResidency({ hostId: host.host_id, host, projectId, sourceGroveId: source.id, root, mycoHome: home }, baseDeps());
  return { projectId, host, source };
}

function targetResolver(): ResolveResidencyTarget {
  return (hostId, groveId, projectId): RemoteTarget => ({
    projectId: projectId as GroveProjectId,
    groveId,
    host: { host_id: hostId, label: 'h', overlay_address: '100.64.0.1:7433', protocol_version: 3 },
    bearer: 'bearer',
  });
}

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

beforeEach(() => {
  cleanTestDb();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-residency-drain-home-'));
  teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-residency-drain-team-'));
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

describe('residency drain — push + delete-after-ack', () => {
  test('ships per-table batches (adoption once, correct tenancy), then purges locally and finishes', async () => {
    const { projectId, host } = beginTransition();
    // A second project's rows must survive the purge.
    const otherProject = createProjectId();
    seedProjectRows(otherProject, 'b');
    const otherRowsBefore = countProjectRows(otherProject);

    expect(countResidencyInFlight()).toBe(1);

    const requests: { target: RemoteTarget; table: string; hasAdoption: boolean; machineId: string }[] = [];
    const transport: ResidencyPostTransport = async (target, body, machineId) => {
      requests.push({ target, table: body.table, hasAdoption: body.adoption !== undefined, machineId });
      return { status: 200, applied: body.rows.length };
    };

    await runResidencyTransitions({ ...baseDeps(), transport, resolveHostTarget: targetResolver() });

    // Adoption rode exactly one (the first) batch, with the project name.
    expect(requests.filter((r) => r.hasAdoption)).toHaveLength(1);
    expect(requests[0].hasAdoption).toBe(true);
    // Every batch carried the host's served-Grove tenancy + this machine.
    for (const r of requests) {
      expect(r.target.groveId).toBe(host.served_grove_id);
      expect(r.target.projectId).toBe(projectId);
      expect(r.machineId).toBe('local');
    }
    // Sidecars were shipped as their own tables.
    expect(requests.map((r) => r.table)).toContain('entity_mentions');
    expect(requests.map((r) => r.table)).toContain('content_publications');

    // Purge: zero project rows across EVERY scoped table; journal cleared.
    expect(countProjectRows(projectId)).toBe(0);
    // Explicitly pin the WITHOUT ROWID tables the rowid-keyed delete skipped.
    const canopyEntries = getDatabase().prepare(`SELECT COUNT(*) AS n FROM canopy_entries WHERE project_id = ?`).get(projectId) as { n: number };
    const canopyMaps = getDatabase().prepare(`SELECT COUNT(*) AS n FROM canopy_maps WHERE project_id = ?`).get(projectId) as { n: number };
    expect(canopyEntries.n).toBe(0);
    expect(canopyMaps.n).toBe(0);
    expect(readResidencyJournal(projectId)).toBeNull();
    expect(countResidencyInFlight()).toBe(0);

    // The delete triggers did NOT enqueue tombstones (membership empty post-v72).
    const tombstones = getDatabase().prepare(
      `SELECT COUNT(*) AS n FROM team_outbox WHERE operation = 'delete' AND project_id = ?`,
    ).get(projectId) as { n: number };
    expect(tombstones.n).toBe(0);

    // The other project is completely untouched, publications included.
    expect(countProjectRows(otherProject)).toBe(otherRowsBefore);
    const otherPub = getDatabase().prepare(`SELECT COUNT(*) AS n FROM content_publications WHERE artifact_id = 'skill_b'`).get() as { n: number };
    expect(otherPub.n).toBe(1);
  });

  test('an empty-history project still ships one adoption-only request so the host learns its name', async () => {
    // A registry row but zero sync-eligible rows: nothing to backfill, so no
    // batch would otherwise carry the adoption.
    const source = createGrove('Source', home);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    registerProjectInGrove(source.id, { projectId, projectName: 'demo', projectRoot: root }, home);
    const host = makeHost();
    writeHostRecordFixture(host);
    beginAttachResidency({ hostId: host.host_id, host, projectId, sourceGroveId: source.id, root, mycoHome: home }, baseDeps());

    const requests: { table: string; rowCount: number; adoption?: { project_name: string } }[] = [];
    const transport: ResidencyPostTransport = async (_target, body) => {
      requests.push({ table: body.table, rowCount: body.rows.length, adoption: body.adoption });
      return { status: 200, applied: body.rows.length };
    };

    await runResidencyTransitions({ ...baseDeps(), transport, resolveHostTarget: targetResolver() });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({ table: 'sessions', rowCount: 0, adoption: { project_name: 'demo' } });
    expect(readResidencyJournal(projectId)).toBeNull(); // transition completed
  });

  test('a failed push does not advance: the journal stays pushing and the local rows survive', async () => {
    const { projectId } = beginTransition();
    const rowsBefore = countProjectRows(projectId);
    const pendingBefore = listPendingForProject(projectId).length;

    const transport: ResidencyPostTransport = async () => ({ status: 503, applied: 0 });
    await runResidencyTransitions({ ...baseDeps(), transport, resolveHostTarget: targetResolver() });

    const journal = readResidencyJournal(projectId);
    expect(journal?.phase).toBe('pushing');
    expect(journal?.last_error).toBeTruthy();
    expect(countProjectRows(projectId)).toBe(rowsBefore); // nothing deleted
    expect(listPendingForProject(projectId).length).toBe(pendingBefore); // nothing marked sent
  });

  test('ack discipline: outbox rows are marked sent + synced before a later sidecar failure blocks the delete', async () => {
    const { projectId } = beginTransition();

    // Succeed on outbox tables, fail on the sidecar streams.
    const transport: ResidencyPostTransport = async (_target, body) =>
      body.table === 'entity_mentions' || body.table === 'content_publications'
        ? { status: 500, applied: 0 }
        : { status: 200, applied: body.rows.length };

    await runResidencyTransitions({ ...baseDeps(), transport, resolveHostTarget: targetResolver() });

    // Outbox fully drained (markSent) and its source rows stamped synced.
    expect(listPendingForProject(projectId)).toHaveLength(0);
    const spore = getDatabase().prepare(`SELECT synced_at FROM spores WHERE id = 'sp_a'`).get() as { synced_at: number | null };
    expect(spore.synced_at).not.toBeNull();

    // But the sidecar failure blocked the delete: rows survive, journal pushing.
    expect(countProjectRows(projectId)).toBeGreaterThan(0);
    expect(readResidencyJournal(projectId)?.phase).toBe('pushing');
  });
});

describe('residency drain — abort races the drain', () => {
  test('an abort mid-push makes delete-after-ack skip: the restored project keeps its rows', async () => {
    const { projectId, source } = beginTransition(); // pushing: rows seeded + queued, local row parked
    const rowsBefore = countProjectRows(projectId);
    const deps = baseDeps();

    // A concurrent Cancel fires during the first ship's await — restores the
    // local registration, drops the ref + queued rows, clears the journal.
    let aborted = false;
    const racingTransport: ResidencyPostTransport = async (_target, body) => {
      if (!aborted) { abortResidency(projectId, deps); aborted = true; }
      return { status: 200, applied: body.rows.length };
    };

    await runResidencyTransitions({ ...deps, transport: racingTransport, resolveHostTarget: targetResolver(), applyStagedRows: () => {} });

    // deleteAfterAck re-confirmed the (now-cleared) journal and skipped — the
    // project the abort restored still has all its rows.
    expect(countProjectRows(projectId)).toBe(rowsBefore);
    expect(findRegisteredProjectById(projectId, home)?.grove.id).toBe(source.id); // restored by abort
    expect(readResidencyJournal(projectId)).toBeNull(); // aborted
  });
});

describe('createResidencyKicker — single-flight + coalesce', () => {
  test('run() never overlaps and coalesces a burst of concurrent runs into ONE follow-up pass', async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    const runPass = async () => { calls += 1; if (calls === 1) await firstGate; };
    const { run } = createResidencyKicker(runPass, (fn) => fn());

    const first = run(); // pass 1 starts, awaits the gate
    await Promise.resolve();
    expect(calls).toBe(1);

    const second = run(); // in-flight → coalesces (pending), no new pass
    const third = run();
    await Promise.resolve();
    expect(calls).toBe(1); // still exactly one pass running, no overlap

    releaseFirst(); // pass 1 finishes → ONE follow-up for the coalesced kicks
    await Promise.all([first, second, third]);
    expect(calls).toBe(2); // two passes total, not four
  });

  test('kick() schedules a run via the injected scheduler, not synchronously', async () => {
    let calls = 0;
    let scheduled: (() => void) | null = null;
    const { kick } = createResidencyKicker(async () => { calls += 1; }, (fn) => { scheduled = fn; });

    kick();
    expect(calls).toBe(0); // deferred to the scheduler, not run inline
    scheduled!();
    await Promise.resolve();
    expect(calls).toBe(1);
  });
});
