/**
 * Residency detach, member side — the HYBRID delivery (artifact fetch →
 * restore → flip → re-home → goodbye). Covers the detachCommand begin path +
 * its refusals, the full drain round trip against a REAL artifact (built by
 * the real backup engine, digest-verified), transfer-contract refusals
 * (digest mismatch, host errors), crash-resume at the restoring phase, the
 * retired-phase refusal, abort-before-flip, goodbye durability (marker retry),
 * suppression-divert through the window, and the failure-honesty surfaces
 * (fresh-phase stamps, stall notification) carried over from the pre-hybrid
 * drain.
 *
 * The artifact server and goodbye sink are injected seams; the restore runs
 * through the REAL backup engine into the ambient test DB.
 */
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';
import { Database as BunDatabase } from 'bun:sqlite';

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase, type Database } from '@myco/db/client.js';
import { clearProjectManifestCache } from '@myco/config/project-manifest.js';
import { createSchema } from '@myco/db/schema.js';
import { createGroveId, createHostId, createProjectId, assertGroveProjectId, type GroveProjectId } from '@myco/grove/ids.js';
import { resolveProjectBufferDir, resolveProjectVaultDir } from '@myco/grove/paths.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  ensureProjectRegistered,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { findRegisteredProjectById } from '@myco/grove/registry-resolve.js';
import { createHostRegistryOperations, type AttachRef, type HostRecord } from '@myco/host/registry.js';
import {
  detachCommand as detachCommandWith,
  type BeginDetachResidency,
} from '@myco/host/attach-command.js';
import { membershipErrorCode } from '@myco/host/membership-error.js';
import { abortResidency, beginDetachResidency, type ResidencyDaemonDeps } from '@myco/host/residency-transition.js';
import {
  readResidencyJournal,
  startResidencyJournal,
  writeResidencyJournal,
} from '@myco/host/residency-journal.js';
import {
  countResidencyInFlight,
  runResidencyTransitions,
  type DetachArtifactClient,
  type DetachGoodbyeTransport,
  type ResolveResidencyTarget,
} from '@myco/host/residency-drain.js';
import { neutralizeArtifactLineage } from '@myco/host/routed-residency-detach.js';
import { DETACH_ARTIFACT_TABLES, createBackup, projectScope } from '@myco/backup/engine.js';
import type { RemoteTarget } from '@myco/host/routing.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const { attachProject, resolveAttach } = createHostRegistryOperations(testPerUserLockNamespace);
const detachCommand = (options: Parameters<typeof detachCommandWith>[0]) =>
  detachCommandWith(options, testPerUserLockNamespace);

let home: string;
let teamHome: string;
let savedTeamHome: string | undefined;
let savedHome: string | undefined;

function baseDeps(): ResidencyDaemonDeps {
  return {
    machineId: 'local',
    mycoHome: home,
    withGroveDb: <T,>(_groveId: string, fn: (db: Database) => T): T => fn(getDatabase()),
    lockNamespace: testPerUserLockNamespace,
  };
}

function makeHost(protocol = 3): HostRecord {
  return {
    host_id: createHostId(),
    label: 'Mac Studio',
    host_url: 'https://host-a.tailnet.ts.net:8443',
    protocol_version: protocol,
    served_grove_id: createGroveId(),
    created_at: new Date().toISOString(),
    projects: [],
  };
}

function makeCheckout(projectId: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-detach-proj-'));
  const vaultDir = resolveProjectVaultDir(root);
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'project.toml'), stringify({ project: { id: projectId, name: 'demo' } }), 'utf-8');
  clearProjectManifestCache();
  return root;
}

const injectedBeginDetach: BeginDetachResidency = (ctx) => beginDetachResidency(ctx, baseDeps());

function targetResolver(protocol = 3): ResolveResidencyTarget {
  return (hostId, groveId, projectId): RemoteTarget => ({
    projectId: projectId as GroveProjectId,
    groveId,
    host: { host_id: hostId, label: 'h', host_url: 'https://host-a.tailnet.ts.net:8443', protocol_version: protocol },
    bearer: 'bearer',
  });
}

/** Build a REAL detach artifact (via the real backup engine) from rows seeded
 *  into a throwaway source DB, and serve it through the prepare/chunk client
 *  seam. `tamperArtifact` mutates the content BEFORE hashing (digest still
 *  matches — for restore-failure tests); `tamperSha` breaks the advertised
 *  digest (for transfer-contract tests). `chunkBytes` forces multi-chunk
 *  transfers. */
function artifactServer(
  projectId: string,
  seed: (db: BunDatabase) => void,
  opts: { tamperArtifact?: (a: string) => string; tamperSha?: string; chunkBytes?: number; prepareStatus?: number } = {},
): { client: DetachArtifactClient; prepares: number; chunks: number[] } {
  const state = { artifact: null as string | null, sha: '', size: 0 };
  const tracker = { client: undefined as unknown as DetachArtifactClient, prepares: 0, chunks: [] as number[] };
  const build = (): void => {
    const src = new BunDatabase(':memory:');
    createSchema(src, 'host');
    src.run('PRAGMA foreign_keys = OFF');
    seed(src);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-artifact-srv-'));
    try {
      const dump = createBackup(src, dir, 'host-machine', projectScope(assertGroveProjectId(projectId)), 'detach', DETACH_ARTIFACT_TABLES);
      let artifact = neutralizeArtifactLineage(fs.readFileSync(dump, 'utf-8'));
      if (opts.tamperArtifact) artifact = opts.tamperArtifact(artifact);
      state.artifact = artifact;
      state.sha = opts.tamperSha ?? createHash('sha256').update(artifact, 'utf-8').digest('hex');
      state.size = Buffer.byteLength(artifact, 'utf-8');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  tracker.client = {
    prepare: async () => {
      tracker.prepares += 1;
      if (opts.prepareStatus && opts.prepareStatus !== 200) {
        return { status: opts.prepareStatus, ready: false, sha256: null, size: null };
      }
      if (state.artifact === null) build();
      return { status: 200, ready: true, sha256: state.sha, size: state.size };
    },
    chunk: async (_t, _m, offset, sha256) => {
      tracker.chunks.push(offset);
      if (state.artifact === null || sha256 !== state.sha) {
        return { status: 200, chunk: null, next_offset: null, restart: true };
      }
      const bytes = Buffer.from(state.artifact, 'utf-8');
      const len = Math.min(opts.chunkBytes ?? bytes.length, bytes.length - offset);
      const next = offset + len < bytes.length ? offset + len : null;
      return { status: 200, chunk: bytes.subarray(offset, offset + len), next_offset: next, restart: false };
    },
  };
  return tracker;
}

function goodbyeSink(status = 200): { transport: DetachGoodbyeTransport; calls: number[]; setStatus: (s: number) => void } {
  const calls: number[] = [];
  let current = status;
  return {
    transport: async () => { calls.push(current); return { status: current }; },
    calls,
    setStatus: (s: number) => { current = s; },
  };
}

/** Attach a project to `host` (records the ref, no local row). */
function attachRef(host: HostRecord, projectId: string, root: string, localGroveId: string): void {
  const ref: AttachRef = { grove_id: host.served_grove_id!, project_id: projectId, root, local_grove_id: localGroveId };
  attachProject(host.host_id, ref, home);
}

function seedDivertedBuffer(host: HostRecord, projectId: string, sessionId: string): string {
  const dir = resolveProjectBufferDir(host.served_grove_id!, projectId, home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '{"event":"x"}\n', 'utf-8');
  return file;
}

function seedSessionRow(db: BunDatabase, id: string, projectId: string, machineId: string): void {
  db.prepare(
    `INSERT INTO sessions (id, agent, project_id, started_at, status, created_at, machine_id)
     VALUES (?, 'claude', ?, 1, 'active', 1, ?)`,
  ).run(id, projectId, machineId);
}

function seedSporeRow(db: BunDatabase, id: string, projectId: string, machineId: string): void {
  db.prepare(
    `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id)
     VALUES (?, ?, 'myco-agent', 'decision', 'from-host', 1, ?)`,
  ).run(id, projectId, machineId);
}

function localCount(table: string, id: string): number {
  return (getDatabase().prepare(`SELECT COUNT(*) c FROM ${table} WHERE id = ?`).get(id) as { c: number }).c;
}

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });

beforeEach(() => {
  cleanTestDb();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-detach-home-'));
  teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-detach-team-'));
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

/** Begin a detach via the real command; returns ids + local grove. */
function beginDetach(): { projectId: string; localId: string; host: HostRecord; root: string } {
  const local = createGrove('Local', home);
  const host = makeHost(3);
  writeHostRecordFixture(host);
  const projectId = createProjectId();
  const root = makeCheckout(projectId);
  attachRef(host, projectId, root, local.id);
  detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach });
  return { projectId, localId: local.id, host, root };
}

// ---------------------------------------------------------------------------
// (1) Begin path + refusals
// ---------------------------------------------------------------------------

describe('detachCommand — begin path validation', () => {
  test('with the daemon capability + a ready host, opens a fetching journal (ref not yet flipped)', () => {
    const { projectId, localId } = beginDetach();
    const journal = readResidencyJournal(projectId);
    expect(journal?.direction).toBe('detach');
    expect(journal?.phase).toBe('fetching');
    expect(journal?.target_grove_id).toBe(localId);
    expect(resolveAttach(projectId)).not.toBeNull(); // the drain flips later
  });

  test('a rootless legacy ref refuses up-front with residency_detach_needs_root', () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    const projectId = createProjectId();
    writeHostRecordFixture({ ...host, projects: [{ grove_id: host.served_grove_id!, project_id: projectId, local_grove_id: local.id }] });
    const root = makeCheckout(projectId);

    try {
      detachCommand({ projectPath: root, projectId, beginDetachResidency: injectedBeginDetach });
      throw new Error('expected refusal');
    } catch (err) {
      expect(membershipErrorCode(err)).toBe('residency_detach_needs_root');
    }
    expect(readResidencyJournal(projectId)).toBeNull();
  });

  test('a host below the residency protocol refuses with residency_pull_unavailable (ref untouched)', () => {
    const local = createGrove('Local', home);
    const host = makeHost(2);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachRef(host, projectId, root, local.id);

    try {
      detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach });
      throw new Error('expected refusal');
    } catch (err) {
      expect(membershipErrorCode(err)).toBe('residency_pull_unavailable');
    }
    expect(resolveAttach(projectId)).not.toBeNull();
    expect(readResidencyJournal(projectId)).toBeNull();
  });

  test('allow_no_pull against an old host runs a plain detach: ref removed, no journal', () => {
    createGrove('Local', home);
    const host = makeHost(2);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachRef(host, projectId, root, createGroveId());

    const result = detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach, allowNoPull: true });
    expect(result.detachedFromHostId).toBe(host.host_id);
    expect(resolveAttach(projectId)).toBeNull();
    expect(readResidencyJournal(projectId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (2) The hybrid round trip
// ---------------------------------------------------------------------------

describe('detach drain — hybrid round trip', () => {
  test('fetches the artifact, restores, flips, re-homes, says goodbye, and finishes', async () => {
    const { projectId, localId, host } = beginDetach();
    const bufferFile = seedDivertedBuffer(host, projectId, 'sess_div');
    expect(countResidencyInFlight()).toBe(1);

    const server = artifactServer(projectId, (db) => {
      seedSessionRow(db, 's_team', projectId, 'member-b'); // another member's session — the WHOLE project comes back
      seedSporeRow(db, 'sp_team', projectId, 'host-machine');
    });
    const goodbye = goodbyeSink();

    await runResidencyTransitions({
      ...baseDeps(),
      detachArtifactClient: server.client,
      detachGoodbyeTransport: goodbye.transport,
      resolveHostTarget: targetResolver(),
    });

    // Restored: the team's knowledge landed locally, whatever machine wrote it.
    expect(localCount('sessions', 's_team')).toBe(1);
    expect(localCount('spores', 'sp_team')).toBe(1);
    // Flip: ref removed, local Grove row re-materialized.
    expect(resolveAttach(projectId)).toBeNull();
    expect(findRegisteredProjectById(projectId, home)?.grove.id).toBe(localId);
    // Re-home: the diverted buffer file moved to the local Grove buffer dir.
    expect(fs.existsSync(bufferFile)).toBe(false);
    expect(fs.existsSync(path.join(resolveProjectBufferDir(localId, projectId, home), 'sess_div.jsonl'))).toBe(true);
    // Goodbye delivered once; journal cleared; nothing in flight.
    expect(goodbye.calls).toHaveLength(1);
    expect(readResidencyJournal(projectId)).toBeNull();
    expect(countResidencyInFlight()).toBe(0);
  });

  test('the artifact survives as a real backup in the target grove backup dir', async () => {
    const { projectId, localId } = beginDetach();
    const server = artifactServer(projectId, (db) => { seedSporeRow(db, 'sp1', projectId, 'm'); });
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: server.client,
      detachGoodbyeTransport: goodbyeSink().transport, resolveHostTarget: targetResolver(),
    });
    const backupDir = path.join(home, 'groves', localId, 'backups');
    const artifacts = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => f.includes('__detach-')) : [];
    expect(artifacts.length).toBe(1);
  });

  test('an existing newer local row survives the restore of an older team snapshot (local wins)', async () => {
    const { projectId } = beginDetach();
    const db = getDatabase();
    db.run('PRAGMA foreign_keys = OFF');
    try {
      db.prepare(
        `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id)
         VALUES ('sp_live', ?, 'myco-agent', 'decision', 'fresh-local', 1, 'local')`,
      ).run(projectId);
    } finally { db.run('PRAGMA foreign_keys = ON'); }

    const server = artifactServer(projectId, (db) => {
      db.prepare(
        `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id)
         VALUES ('sp_live', ?, 'myco-agent', 'decision', 'stale-host-copy', 1, 'member-b')`,
      ).run(projectId);
    });
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: server.client,
      detachGoodbyeTransport: goodbyeSink().transport, resolveHostTarget: targetResolver(),
    });
    const content = (getDatabase().prepare(`SELECT content FROM spores WHERE id = 'sp_live'`).get() as { content: string }).content;
    expect(content).toBe('fresh-local'); // INSERT OR IGNORE — existing rows win
  });
});

// ---------------------------------------------------------------------------
// (3) Transfer contract + failure honesty
// ---------------------------------------------------------------------------

describe('detach drain — transfer contract + failure honesty', () => {
  test('a digest mismatch is refused whole — journal stays fetching, then a clean fetch converges', async () => {
    const { projectId } = beginDetach();
    const bad = artifactServer(projectId, (db) => { seedSporeRow(db, 'sp1', projectId, 'm'); }, { tamperSha: 'f'.repeat(64) });
    const goodbye = goodbyeSink();

    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: bad.client,
      detachGoodbyeTransport: goodbye.transport, resolveHostTarget: targetResolver(),
    });
    const journal = readResidencyJournal(projectId);
    expect(journal?.phase).toBe('fetching');
    expect(journal?.last_error).toContain('digest');
    expect(localCount('spores', 'sp1')).toBe(0); // nothing durable happened
    expect(resolveAttach(projectId)).not.toBeNull();

    const good = artifactServer(projectId, (db) => { seedSporeRow(db, 'sp1', projectId, 'm'); });
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: good.client,
      detachGoodbyeTransport: goodbye.transport, resolveHostTarget: targetResolver(),
    });
    expect(localCount('spores', 'sp1')).toBe(1);
    expect(readResidencyJournal(projectId)).toBeNull();
  });

  test('a host error stays in fetching with a stamped failure', async () => {
    const { projectId } = beginDetach();
    const failing = artifactServer(projectId, () => {}, { prepareStatus: 500 }).client;
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: failing,
      detachGoodbyeTransport: goodbyeSink().transport, resolveHostTarget: targetResolver(),
    });
    const journal = readResidencyJournal(projectId);
    expect(journal?.phase).toBe('fetching');
    expect(journal?.last_error).toContain('500');
  });

  test('a host below the residency protocol stamps last_error instead of skipping silently', async () => {
    const { projectId } = beginDetach();
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: artifactServer(projectId, () => {}).client,
      detachGoodbyeTransport: goodbyeSink().transport, resolveHostTarget: targetResolver(2),
    });
    const journal = readResidencyJournal(projectId);
    expect(journal?.phase).toBe('fetching');
    expect(journal?.last_error).toContain('below the residency protocol');
  });

  test('a missing host record stamps last_error instead of skipping silently', async () => {
    const { projectId } = beginDetach();
    const gone: ResolveResidencyTarget = () => null;
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: artifactServer(projectId, () => {}).client,
      detachGoodbyeTransport: goodbyeSink().transport, resolveHostTarget: gone,
    });
    expect(readResidencyJournal(projectId)?.last_error).toContain('host record');
  });

  test('a failed restore keeps the durable phase at restoring — never regressed to fetching', async () => {
    const { projectId } = beginDetach();
    const server = artifactServer(projectId, (db) => { seedSporeRow(db, 'sp1', projectId, 'm'); });
    const goodbye = goodbyeSink();

    const broken = artifactServer(projectId, (db) => { seedSporeRow(db, 'sp1', projectId, 'm'); },
      { tamperArtifact: (a) => a + '\nINSERT INTO no_such_table (x) VALUES (1);\n' });
    await runResidencyTransitions({
      ...baseDeps(),
      detachArtifactClient: broken.client,
      detachGoodbyeTransport: goodbye.transport,
      resolveHostTarget: targetResolver(),
    });
    const journal = readResidencyJournal(projectId);
    expect(journal?.phase).toBe('restoring'); // NOT fetching — the artifact landed; the restore is what failed
    expect(journal?.last_error).toBeTruthy();
    expect(localCount('spores', 'sp1')).toBe(0); // atomic restore: nothing partial

    // Repair the artifact file in place; the retry converges from `restoring`.
    const artifactPath = readResidencyJournal(projectId)!.backup_ref!;
    fs.writeFileSync(artifactPath, fs.readFileSync(artifactPath, 'utf-8').replace(/\nINSERT INTO no_such_table[^\n]*\n/, '\n'), 'utf-8');
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: server.client,
      detachGoodbyeTransport: goodbye.transport, resolveHostTarget: targetResolver(),
    });
    expect(localCount('spores', 'sp1')).toBe(1);
    expect(readResidencyJournal(projectId)).toBeNull();
  });

  test('a lost artifact at restoring goes BACK to fetching rather than wedging', async () => {
    const { projectId } = beginDetach();
    const journal = readResidencyJournal(projectId)!;
    writeResidencyJournal({ ...journal, phase: 'restoring', backup_ref: '/nowhere/gone.sql' });
    const server = artifactServer(projectId, (db) => { seedSporeRow(db, 'sp2', projectId, 'm'); });
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: server.client,
      detachGoodbyeTransport: goodbyeSink().transport, resolveHostTarget: targetResolver(),
    });
    // First pass re-routes to fetching; a second pass completes the round trip.
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: server.client,
      detachGoodbyeTransport: goodbyeSink().transport, resolveHostTarget: targetResolver(),
    });
    expect(localCount('spores', 'sp2')).toBe(1);
    expect(readResidencyJournal(projectId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (4) Retired phases + abort
// ---------------------------------------------------------------------------

describe('detach drain — retired phases + abort', () => {
  test('a pulling journal from an older build is refused with guidance, never progressed', async () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    startResidencyJournal({
      direction: 'detach', phase: 'pulling', host_id: host.host_id, project_id: projectId,
      divert_grove_id: host.served_grove_id!, source_grove_id: host.served_grove_id!, target_grove_id: local.id,
      project_name: 'demo', root, backup_ref: null, cursors: {},
    });
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: artifactServer(projectId, () => {}).client,
      detachGoodbyeTransport: goodbyeSink().transport, resolveHostTarget: targetResolver(),
    });
    const journal = readResidencyJournal(projectId);
    expect(journal?.phase).toBe('pulling'); // untouched
    expect(journal?.last_error).toContain('older version');
    // The user's way out still works: abort accepts the retired phase.
    expect(abortResidency(projectId, baseDeps())).toEqual({ ok: true });
  });

  test('an abort mid-fetching stops before the flip: still attached, no local row', async () => {
    const { projectId } = beginDetach();
    expect(abortResidency(projectId, baseDeps())).toEqual({ ok: true });
    expect(readResidencyJournal(projectId)).toBeNull();
    expect(resolveAttach(projectId)).not.toBeNull();
    expect(findRegisteredProjectById(projectId, home)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (5) Goodbye durability
// ---------------------------------------------------------------------------

describe('detach drain — goodbye durability', () => {
  test('an unreachable host never blocks completion; the goodbye retries from a durable marker', async () => {
    const { projectId } = beginDetach();
    const server = artifactServer(projectId, (db) => { seedSporeRow(db, 'sp1', projectId, 'm'); });
    const goodbye = goodbyeSink(200);

    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: server.client,
      detachGoodbyeTransport: async () => { throw new Error('unreachable'); },
      resolveHostTarget: targetResolver(),
    });
    // The detach itself completed — data local, journal gone, nothing held.
    expect(localCount('spores', 'sp1')).toBe(1);
    expect(readResidencyJournal(projectId)).toBeNull();
    // The marker survives for the pass-level retry…
    const dir = path.join(teamHome, 'residency');
    expect(fs.readdirSync(dir).some((f) => f === `goodbye-${projectId}.json`)).toBe(true);

    // …and a later pass with a reachable host consumes it.
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: server.client,
      detachGoodbyeTransport: goodbye.transport, resolveHostTarget: targetResolver(),
    });
    expect(goodbye.calls.length).toBeGreaterThanOrEqual(1);
    expect(fs.readdirSync(dir).some((f) => f === `goodbye-${projectId}.json`)).toBe(false);
  });

  test('an unresolved membership KEEPS the marker; positive host absence drops it', async () => {
    const { projectId, host } = beginDetach();
    const server = artifactServer(projectId, (db) => { seedSporeRow(db, 'sp1', projectId, 'm'); });
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: server.client,
      detachGoodbyeTransport: async () => { throw new Error('unreachable'); },
      resolveHostTarget: targetResolver(),
    });
    const dir = path.join(teamHome, 'residency');
    const markerName = `goodbye-${projectId}.json`;
    expect(fs.readdirSync(dir)).toContain(markerName);

    // Membership unresolved (target null) but the host's durable dir exists —
    // e.g. a mid-rotation snapshot. The marker must survive.
    const hostDir = path.join(teamHome, 'hosts', host.host_id);
    fs.mkdirSync(hostDir, { recursive: true });
    const gone: ResolveResidencyTarget = () => null;
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: server.client,
      detachGoodbyeTransport: goodbyeSink().transport, resolveHostTarget: gone,
    });
    expect(fs.readdirSync(dir)).toContain(markerName);

    // Positive absence (the user left the host; its dir is gone) drops it.
    fs.rmSync(hostDir, { recursive: true, force: true });
    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: server.client,
      detachGoodbyeTransport: goodbyeSink().transport, resolveHostTarget: gone,
    });
    expect(fs.readdirSync(dir)).not.toContain(markerName);
  });
});

// ---------------------------------------------------------------------------
// (6) Suppression through the window
// ---------------------------------------------------------------------------

describe('detach — suppression during the window', () => {
  test('a live fetching journal diverts capture to the host Grove', () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    startResidencyJournal({
      direction: 'detach', phase: 'fetching', host_id: host.host_id, project_id: projectId,
      divert_grove_id: host.served_grove_id!, source_grove_id: host.served_grove_id!, target_grove_id: local.id,
      project_name: 'demo', root, backup_ref: null, cursors: {},
    });
    const resolved = ensureProjectRegistered(root, home, testPerUserLockNamespace);
    expect(resolved?.grove.id).toBe(host.served_grove_id);
  });

  test('a rehoming journal does NOT divert — new capture resolves local', () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    registerProjectInGrove(local.id, { projectId, projectName: 'demo', projectRoot: root }, home);
    clearGroveRegistryCaches();
    startResidencyJournal({
      direction: 'detach', phase: 'rehoming', host_id: host.host_id, project_id: projectId,
      divert_grove_id: host.served_grove_id!, source_grove_id: host.served_grove_id!, target_grove_id: local.id,
      project_name: 'demo', root, backup_ref: null, cursors: {},
    });
    const resolved = ensureProjectRegistered(root, home, testPerUserLockNamespace);
    expect(resolved?.grove.id).toBe(local.id);
  });
});

// ---------------------------------------------------------------------------
// (7) Stall surface (carried from the pre-hybrid drain)
// ---------------------------------------------------------------------------

describe('detach drain — stall surface', () => {
  test('an old, currently-failing transition raises the stall surface once per interval — a young one never does', async () => {
    const { projectId } = beginDetach();
    const failing = artifactServer(projectId, () => {}, { prepareStatus: 500 }).client;
    const stalls: string[] = [];
    const notify = (journal: { project_id: string }) => { stalls.push(journal.project_id); };

    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: failing,
      detachGoodbyeTransport: goodbyeSink().transport, resolveHostTarget: targetResolver(),
      notifyStalledTransition: notify,
    });
    expect(stalls).toHaveLength(0); // young + failing → silent (age gate)

    const stamped = readResidencyJournal(projectId)!;
    writeResidencyJournal({ ...stamped, created_at: new Date(Date.now() - 40 * 60 * 1000).toISOString() });

    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: failing,
      detachGoodbyeTransport: goodbyeSink().transport, resolveHostTarget: targetResolver(),
      notifyStalledTransition: notify,
    });
    expect(stalls).toEqual([projectId]);

    await runResidencyTransitions({
      ...baseDeps(), detachArtifactClient: failing,
      detachGoodbyeTransport: goodbyeSink().transport, resolveHostTarget: targetResolver(),
      notifyStalledTransition: notify,
    });
    expect(stalls).toEqual([projectId]); // inside the re-notify interval
  });
});
