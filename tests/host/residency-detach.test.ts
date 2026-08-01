/**
 * Residency detach-pull, member side (Phase F T4). Covers the detachCommand
 * with-pull path + its refusals, the full drain round trip (pull → staging →
 * flip → re-materialize → apply → re-home → purge → done), crash-resume, the
 * allow_no_pull fallback, post-flip freshness, staging cleanup, and that
 * suppression-divert stays active through the window.
 *
 * The pull server, host-target resolver, and apply engine are injected seams, so
 * the member discipline is exercised without a real host or the shared engine.
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
import { createGroveId, createHostId, createProjectId, type GroveProjectId } from '@myco/grove/ids.js';
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
  appendResidencyStagingRows,
  listResidencyStagingTables,
  readResidencyJournal,
  startResidencyJournal,
  writeResidencyJournal,
} from '@myco/host/residency-journal.js';
import {
  countResidencyInFlight,
  runResidencyTransitions,
  type ApplyStagedRows,
  type ResidencyPullResponse,
  type ResidencyPullTransport,
  type ResolveResidencyTarget,
} from '@myco/host/residency-drain.js';
import type { RemoteTarget } from '@myco/host/routing.js';
import { applyResidencyRows } from '@myco/db/queries/residency-apply.js';
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
    overlay_address: '100.64.0.1:7433',
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
    host: { host_id: hostId, label: 'h', overlay_address: '100.64.0.1:7433', protocol_version: protocol },
    bearer: 'bearer',
  });
}

/** A pull server that returns the given pages in order, then done. */
function pagingPull(pages: { table: string; row: Record<string, unknown> }[][]): {
  transport: ResidencyPullTransport;
  calls: (string | null)[];
} {
  const calls: (string | null)[] = [];
  let idx = 0;
  const transport: ResidencyPullTransport = async (_target, body): Promise<ResidencyPullResponse> => {
    calls.push(body.cursor);
    const rows = pages[idx] ?? [];
    const done = idx >= pages.length - 1;
    const next_cursor = done ? null : `c${idx + 1}`;
    idx += 1;
    return { status: 200, rows, next_cursor, done };
  };
  return { transport, calls };
}

/** Attach a project to `host` (records the ref, no local row). */
function attachRef(host: HostRecord, projectId: string, root: string, localGroveId: string): void {
  const ref: AttachRef = { grove_id: host.served_grove_id!, project_id: projectId, root, local_grove_id: localGroveId };
  attachProject(host.host_id, ref, home);
}

/** Seed a diverted capture buffer file under the host Grove (as the hook would
 *  during the window) so the re-home step has something to move. */
function seedDivertedBuffer(host: HostRecord, projectId: string, sessionId: string): string {
  const dir = resolveProjectBufferDir(host.served_grove_id!, projectId, home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '{"event":"x"}\n', 'utf-8');
  return file;
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

describe('detachCommand — pull path validation', () => {
  test('with the daemon capability + a ready host, writes a pulling journal and returns "pull started" (ref not yet flipped)', () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachRef(host, projectId, root, local.id);

    const result = detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach });

    expect(result.detachedFromHostId).toBe(host.host_id);
    const journal = readResidencyJournal(projectId);
    expect(journal?.direction).toBe('detach');
    expect(journal?.phase).toBe('pulling');
    expect(journal?.target_grove_id).toBe(local.id);
    // The ref is still present — the drain flips it once the pull completes.
    expect(resolveAttach(projectId)).not.toBeNull();
  });

  test('a rootless legacy ref refuses up-front with residency_detach_needs_root', () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    const projectId = createProjectId();
    // Seed a ref with NO root (a pre-root legacy record).
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
    const host = makeHost(2); // predates the pull
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

  test('allow_no_pull against an old host runs a plain detach: ref removed, no journal, no pull', () => {
    createGrove('Local', home);
    const host = makeHost(2);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachRef(host, projectId, root, createGroveId());

    const result = detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach, allowNoPull: true });

    expect(result.detachedFromHostId).toBe(host.host_id);
    expect(resolveAttach(projectId)).toBeNull(); // plain flip happened
    expect(readResidencyJournal(projectId)).toBeNull(); // no transition
  });
});

describe('detach drain — round trip', () => {
  test('pulls pages to staging, flips, re-materializes, applies, re-homes buffered events, purges, and finishes', async () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachRef(host, projectId, root, local.id);
    const bufferFile = seedDivertedBuffer(host, projectId, 'sess_div');

    detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach });
    expect(countResidencyInFlight()).toBe(1);

    const { transport, calls } = pagingPull([
      [{ table: 'spores', row: { id: 'sp_pull', project_id: projectId } }],
      [{ table: 'sessions', row: { id: 'sess_pull', project_id: projectId } }],
    ]);
    const applied: { table: string; ids: unknown[] }[] = [];
    const applyStagedRows: ApplyStagedRows = (_db, table, rows) => applied.push({ table, ids: rows.map((r) => r.id) });

    await runResidencyTransitions({ ...baseDeps(), pullTransport: transport, resolveHostTarget: targetResolver(), applyStagedRows });

    // Pull resumed page-by-page from the journal cursor.
    expect(calls).toEqual([null, 'c1']);
    // Apply saw both staged tables in FK-topological order (sessions before
    // spores per RESIDENCY_TABLE_ORDER) — NOT the readdirSync/pull order.
    expect(applied.map((a) => a.table)).toEqual(['sessions', 'spores']);
    expect(applied.find((a) => a.table === 'spores')?.ids).toEqual(['sp_pull']);

    // Flip: ref removed, local Grove row re-materialized.
    expect(resolveAttach(projectId)).toBeNull();
    const reMaterialized = findRegisteredProjectById(projectId, home);
    expect(reMaterialized?.grove.id).toBe(local.id);

    // Re-home: the diverted buffer file moved to the local Grove buffer dir.
    expect(fs.existsSync(bufferFile)).toBe(false);
    expect(fs.existsSync(path.join(resolveProjectBufferDir(local.id, projectId, home), 'sess_div.jsonl'))).toBe(true);

    // Journal + staging cleared.
    expect(readResidencyJournal(projectId)).toBeNull();
    expect(listResidencyStagingTables(projectId).state).toBe('absent');
    expect(countResidencyInFlight()).toBe(0);
  });

  test('an unreadable staging tree stops the apply — nothing is applied, nothing is cleared', async () => {
    // The destruction path: on a read failure the staging dir enumerates as
    // empty, the apply consumes zero rows, and the tree is deleted — taking the
    // entire pulled dataset with it, under a "transition complete" log.
    const local = createGrove('Local', home);
    const host = makeHost(3);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachRef(host, projectId, root, local.id);

    detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach });

    // Stage one page, then stall so the journal stays pre-apply.
    let call = 0;
    const stallingPull = async () => {
      call += 1;
      if (call === 1) {
        return { status: 200, rows: [{ table: 'spores', row: { id: 'sp_a', project_id: projectId } }], next_cursor: 'c1', done: false };
      }
      return { status: 503, rows: [], next_cursor: null, done: false };
    };
    await runResidencyTransitions({ ...baseDeps(), pullTransport: stallingPull as never, resolveHostTarget: targetResolver(), applyStagedRows: () => {} });

    const stagingDir = path.join(teamHome, 'residency', `${projectId}-staging`);
    expect(fs.existsSync(stagingDir)).toBe(true);
    fs.chmodSync(stagingDir, 0o000); // deny enumeration

    try {
      const finishingPull = async () => ({ status: 200, rows: [], next_cursor: null, done: true });
      const applied: string[] = [];
      await runResidencyTransitions({
        ...baseDeps(),
        pullTransport: finishingPull as never,
        resolveHostTarget: targetResolver(),
        applyStagedRows: (_db, table) => { applied.push(table); },
      });

      expect(applied).toEqual([]); // nothing applied off an unreadable tree
      expect(readResidencyJournal(projectId)).not.toBeNull(); // the retry path survives
      expect(fs.existsSync(stagingDir)).toBe(true); // and so does the data
    } finally {
      fs.chmodSync(stagingDir, 0o700); // restore so the fixture can clean up
    }
  });

  test('a staging tree holding fewer lines than the pull recorded refuses to apply', async () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachRef(host, projectId, root, local.id);

    detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach });

    // Pull one page, then stop before the apply by refusing the second page.
    let call = 0;
    const stallingPull = async () => {
      call += 1;
      if (call === 1) {
        return { status: 200, rows: [{ table: 'spores', row: { id: 'sp_a', project_id: projectId } }], next_cursor: 'c1', done: false };
      }
      return { status: 503, rows: [], next_cursor: null, done: false };
    };
    await runResidencyTransitions({ ...baseDeps(), pullTransport: stallingPull as never, resolveHostTarget: targetResolver(), applyStagedRows: () => {} });

    const journal = readResidencyJournal(projectId);
    expect(journal?.phase).toBe('pulling');
    expect(journal?.staged_rows).toBe(1); // the durable count the apply will check

    // Truncate the staged file behind the drain's back, then let the pull finish.
    const stagingDir = path.join(teamHome, 'residency', `${projectId}-staging`);
    fs.writeFileSync(path.join(stagingDir, 'spores.ndjson'), '', 'utf-8');

    const finishingPull = async () => ({ status: 200, rows: [], next_cursor: null, done: true });
    const applied: string[] = [];
    await runResidencyTransitions({
      ...baseDeps(),
      pullTransport: finishingPull as never,
      resolveHostTarget: targetResolver(),
      applyStagedRows: (_db, table) => { applied.push(table); },
    });

    // Nothing applied, nothing cleared — the journal survives as the retry path.
    expect(applied).toEqual([]);
    const after = readResidencyJournal(projectId);
    expect(after).not.toBeNull();
    expect(after?.last_error).toContain('staging holds');
    expect(resolveAttach(projectId)).toBeNull(); // the flip had already run
  });

  test('an abort mid-pull stops before the flip: the project stays attached, no local row, staging cleared', async () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachRef(host, projectId, root, local.id);
    detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach });
    const deps = baseDeps();

    // A concurrent Cancel fires during the pull await — clears journal + staging,
    // leaves the ref attached (nothing flipped).
    const racingPull: ResidencyPullTransport = async () => {
      abortResidency(projectId, deps);
      return { status: 200, rows: [{ table: 'spores', row: { id: 'sp1', project_id: projectId } }], next_cursor: null, done: true };
    };

    await runResidencyTransitions({ ...deps, pullTransport: racingPull, resolveHostTarget: targetResolver(), applyStagedRows: () => {} });

    expect(resolveAttach(projectId)).not.toBeNull(); // still attached — the flip bailed
    expect(findRegisteredProjectById(projectId, home)).toBeNull(); // no local Grove row re-materialized
    expect(readResidencyJournal(projectId)).toBeNull(); // aborted
    expect(listResidencyStagingTables(projectId).state).toBe('absent'); // guard stopped re-staging after abort cleared it
  });

  test('a failed pull does not advance: the journal stays pulling and the ref survives', async () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachRef(host, projectId, root, local.id);
    detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach });

    const failing: ResidencyPullTransport = async () => ({ status: 503, rows: [], next_cursor: null, done: false });
    await runResidencyTransitions({ ...baseDeps(), pullTransport: failing, resolveHostTarget: targetResolver(), applyStagedRows: () => {} });

    expect(readResidencyJournal(projectId)?.phase).toBe('pulling');
    expect(resolveAttach(projectId)).not.toBeNull(); // never flipped
  });
});

describe('detach drain — crash-resume + freshness', () => {
  test('resumes an applying journal idempotently (re-materialize converges, re-apply is safe)', async () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    // Simulate a crash AFTER the pull completed but before apply: journal in
    // `pulling` with the pull already done, ref still attached, staging present.
    writeHostRecordFixture(host);
    attachRef(host, projectId, root, local.id);
    startResidencyJournal({
      direction: 'detach', phase: 'pulling', host_id: host.host_id, project_id: projectId,
      divert_grove_id: host.served_grove_id!, source_grove_id: host.served_grove_id!, target_grove_id: local.id,
      project_name: 'demo', root, backup_ref: null, cursors: { pull: 'done' },
    });
    // Staged rows are present (the pull completed before the crash).
    appendResidencyStagingRows(projectId, [{ table: 'spores', row: { id: 'sp_staged', project_id: projectId } }]);

    let applyCount = 0;
    const run = () => runResidencyTransitions({
      ...baseDeps(),
      pullTransport: async () => ({ status: 200, rows: [], next_cursor: null, done: true }),
      resolveHostTarget: targetResolver(),
      applyStagedRows: () => { applyCount += 1; },
    });

    await run();
    // A redundant second tick must not error even though the journal is gone.
    await run();

    expect(resolveAttach(projectId)).toBeNull();
    expect(findRegisteredProjectById(projectId, home)?.grove.id).toBe(local.id);
    expect(readResidencyJournal(projectId)).toBeNull();
    expect(applyCount).toBe(1); // only the first tick had a live journal to apply
  });

  test('crash mid-sweep (journal in rehoming) resumes and finishes the re-home — zero orphaned files', async () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    // Post-flip state: journal left in `rehoming` by a crash before the sweep
    // completed, with a diverted buffer file still under the host Grove.
    const bufferFile = seedDivertedBuffer(host, projectId, 'sess_orphan');
    startResidencyJournal({
      direction: 'detach', phase: 'rehoming', host_id: host.host_id, project_id: projectId,
      divert_grove_id: host.served_grove_id!, source_grove_id: host.served_grove_id!, target_grove_id: local.id,
      project_name: 'demo', root, backup_ref: null, cursors: { pull: 'done' },
    });

    await runResidencyTransitions({ ...baseDeps(), resolveHostTarget: targetResolver(), applyStagedRows: () => {} });

    // The residual buffered file was re-homed; nothing orphaned; journal cleared.
    expect(fs.existsSync(bufferFile)).toBe(false);
    expect(fs.existsSync(path.join(resolveProjectBufferDir(local.id, projectId, home), 'sess_orphan.jsonl'))).toBe(true);
    expect(readResidencyJournal(projectId)).toBeNull();
    expect(countResidencyInFlight()).toBe(0);
  });

  test('integration: the real shared apply engine lands pulled rows into the local Grove (production seam)', async () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachRef(host, projectId, root, local.id);
    detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach });

    const { transport } = pagingPull([[{
      table: 'spores',
      row: { id: 'sp_new', project_id: projectId, agent_id: 'user', observation_type: 'note', content: 'from-host', created_at: 1, updated_at: 1, machine_id: 'local' },
    }]]);

    // The exact production wiring from main.ts — the real engine, one transaction.
    const applyStagedRows = (db: Database, table: string, rows: Record<string, unknown>[], projectId: string) => { applyResidencyRows(db, table, rows, { expectedProjectId: projectId }, {}); };
    await runResidencyTransitions({ ...baseDeps(), pullTransport: transport, resolveHostTarget: targetResolver(), applyStagedRows });

    const landed = getDatabase().prepare(`SELECT content FROM spores WHERE id = 'sp_new'`).get() as { content: string } | undefined;
    expect(landed?.content).toBe('from-host');
    expect(readResidencyJournal(projectId)).toBeNull(); // completed
  });

  test('apply orders staged tables FK-topologically through the real engine (parents before children, one transaction)', async () => {
    const local = createGrove('Local', home);
    const host = makeHost();
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachRef(host, projectId, root, local.id);
    detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach });

    // A page with CHILDREN before their PARENTS: prompt_batches.session_id →
    // sessions and entity_mentions.entity_id → entities. Applied in readdirSync
    // order (alphabetical: entities, entity_mentions, prompt_batches, sessions)
    // prompt_batches would insert before sessions and the FK transaction would
    // roll back and wedge. RESIDENCY_TABLE_ORDER must fix it.
    const { transport } = pagingPull([[
      { table: 'entity_mentions', row: { project_id: projectId, entity_id: 'ent_r', note_id: 'sess_r', note_type: 'session', agent_id: 'user', machine_id: 'local' } },
      { table: 'prompt_batches', row: { id: 'pbatch_r', project_id: projectId, session_id: 'sess_r', created_at: 1, machine_id: 'local' } },
      { table: 'entities', row: { id: 'ent_r', project_id: projectId, agent_id: 'user', type: 'file', name: 'n', first_seen: 1, last_seen: 1, machine_id: 'local' } },
      { table: 'sessions', row: { id: 'sess_r', project_id: projectId, agent: 'claude-code', started_at: 1, created_at: 1, machine_id: 'local' } },
    ]]);

    const applyStagedRows = (db: Database, table: string, rows: Record<string, unknown>[], projectId: string) => { applyResidencyRows(db, table, rows, { expectedProjectId: projectId }, {}); };
    await runResidencyTransitions({ ...baseDeps(), pullTransport: transport, resolveHostTarget: targetResolver(), applyStagedRows });

    // Both FK-children landed → their parents were applied first (else the whole
    // immediate-FK transaction would have thrown and left the journal stuck).
    expect(getDatabase().prepare(`SELECT id FROM prompt_batches WHERE id = 'pbatch_r'`).get()).toBeTruthy();
    expect(getDatabase().prepare(`SELECT entity_id FROM entity_mentions WHERE entity_id = 'ent_r'`).get()).toBeTruthy();
    expect(readResidencyJournal(projectId)).toBeNull(); // completed, not wedged
  });

  test('post-flip freshness: a newer local row survives the apply of an older host snapshot', async () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachRef(host, projectId, root, local.id);

    // A newer local row already in the DB (post-flip live capture). FK off so the
    // seed needs no agents row.
    const db = getDatabase();
    db.run('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, updated_at, machine_id)
       VALUES ('sp_x', ?, 'user', 'note', 'local-new', 1, 200, 'local')`,
    ).run(projectId);
    db.run('PRAGMA foreign_keys = ON');

    detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach });

    // Pull an OLDER snapshot of the same row from the host.
    const { transport } = pagingPull([[{
      table: 'spores',
      row: { id: 'sp_x', project_id: projectId, agent_id: 'user', observation_type: 'note', content: 'host-old', created_at: 1, updated_at: 100, machine_id: 'local' },
    }]]);

    // A faithful if-newer-by-updated_at apply (the shared engine's rule for spores).
    const ifNewer: ApplyStagedRows = (db, table, rows) => {
      for (const row of rows) {
        const existing = db.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(row.id) as { updated_at: number | null } | undefined;
        if (existing && Number(row.updated_at ?? 0) <= Number(existing.updated_at ?? 0)) continue;
        db.prepare(`UPDATE ${table} SET content = ?, updated_at = ? WHERE id = ?`).run(row.content, Number(row.updated_at ?? 0), row.id);
      }
    };

    await runResidencyTransitions({ ...baseDeps(), pullTransport: transport, resolveHostTarget: targetResolver(), applyStagedRows: ifNewer });

    const survived = getDatabase().prepare(`SELECT content, updated_at FROM spores WHERE id = 'sp_x'`).get() as { content: string; updated_at: number };
    expect(survived.content).toBe('local-new'); // the newer local row won
    expect(survived.updated_at).toBe(200);
  });
});

describe('detach — suppression during the window', () => {
  test('a live detach journal diverts capture to the host Grove (events buffer there, re-homed at the end)', () => {
    const host = makeHost(3);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    startResidencyJournal({
      direction: 'detach', phase: 'pulling', host_id: host.host_id, project_id: projectId,
      divert_grove_id: host.served_grove_id!, source_grove_id: host.served_grove_id!, target_grove_id: createGroveId(),
      project_name: 'demo', root, backup_ref: null, cursors: {},
    });

    const resolved = ensureProjectRegistered(root, home, testPerUserLockNamespace);
    expect(resolved?.grove.id).toBe(host.served_grove_id);
    expect(resolved?.project.project_id).toBe(projectId);
  });

  test('a rehoming journal does NOT divert — new capture resolves to the (re-materialized) local Grove', () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    // Post-flip: the local Grove row is live again; the journal is in the terminal
    // sweep. Divert must be OFF so a fresh hook lands locally, not in the host buffer.
    registerProjectInGrove(local.id, { projectId, projectName: 'demo', projectRoot: root }, home);
    clearGroveRegistryCaches();
    startResidencyJournal({
      direction: 'detach', phase: 'rehoming', host_id: host.host_id, project_id: projectId,
      divert_grove_id: host.served_grove_id!, source_grove_id: host.served_grove_id!, target_grove_id: local.id,
      project_name: 'demo', root, backup_ref: null, cursors: { pull: 'done' },
    });

    const resolved = ensureProjectRegistered(root, home, testPerUserLockNamespace);
    expect(resolved?.grove.id).toBe(local.id); // local, not the host divert grove
    expect(resolved?.grove.id).not.toBe(host.served_grove_id);
  });
});

describe('detach drain — failure honesty (phase, stamps, stall surface)', () => {
  /** Drive a detach to the point where the pull is complete and the flip +
   *  apply are next: begun via the real command, one staged page. */
  function beginPulledDetach(): { projectId: string; localId: string } {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    attachRef(host, projectId, root, local.id);
    detachCommand({ projectPath: root, beginDetachResidency: injectedBeginDetach });
    return { projectId, localId: local.id };
  }

  test('a crash AFTER the flip keeps the durable phase at applying — a stale pass snapshot can never regress it to pulling', async () => {
    const { projectId } = beginPulledDetach();
    const { transport } = pagingPull([[{ table: 'spores', row: { id: 'sp_1', project_id: projectId } }]]);

    // The apply throws OUT of runDetachTransition (a SQLITE_BUSY shape), so the
    // failure is recorded by the OUTER pass catch — which holds the journal as
    // it looked at pass start: `pulling`. The durable journal has moved through
    // the flip to `applying` in between.
    const crash: ApplyStagedRows = () => { throw new Error('database is locked'); };
    await runResidencyTransitions({ ...baseDeps(), pullTransport: transport, resolveHostTarget: targetResolver(), applyStagedRows: crash });

    const journal = readResidencyJournal(projectId);
    expect(journal?.phase).toBe('applying'); // NOT 'pulling' — the flip's durable record must stand
    expect(journal?.last_error).toContain('database is locked');
    // The flip itself happened: the attach ref is gone.
    expect(resolveAttach(projectId)).toBeNull();

    // And the retry converges: next tick applies and finishes.
    const applied: string[] = [];
    const collect: ApplyStagedRows = (_db, table) => { applied.push(table); };
    await runResidencyTransitions({ ...baseDeps(), pullTransport: transport, resolveHostTarget: targetResolver(), applyStagedRows: collect });
    expect(applied).toContain('spores');
    expect(readResidencyJournal(projectId)).toBeNull();
  });

  test('a host below the residency protocol stamps last_error instead of skipping silently', async () => {
    const { projectId } = beginPulledDetach();
    await runResidencyTransitions({ ...baseDeps(), pullTransport: pagingPull([]).transport, resolveHostTarget: targetResolver(2) });
    const journal = readResidencyJournal(projectId);
    expect(journal?.phase).toBe('pulling'); // untouched — retry when the host updates
    expect(journal?.last_error).toContain('below the residency protocol');
  });

  test('a missing host record stamps last_error instead of skipping silently', async () => {
    const { projectId } = beginPulledDetach();
    const gone: ResolveResidencyTarget = () => undefined as never;
    await runResidencyTransitions({ ...baseDeps(), pullTransport: pagingPull([]).transport, resolveHostTarget: gone });
    const journal = readResidencyJournal(projectId);
    expect(journal?.phase).toBe('pulling');
    expect(journal?.last_error).toContain('host record');
  });

  test('an old, currently-failing transition raises the stall surface exactly once per interval — and a young one never does', async () => {
    const { projectId } = beginPulledDetach();
    const failing: ResidencyPullTransport = async () => ({ status: 500, rows: [], next_cursor: null, done: false });
    const stalls: { projectId: string; ms: number }[] = [];
    const notify = (journal: { project_id: string }, ms: number) =>
      { stalls.push({ projectId: journal.project_id, ms }); };

    // Young transition + fresh failure: the age gate must hold — a large
    // first pull failing early is not a stall.
    await runResidencyTransitions({ ...baseDeps(), pullTransport: failing, resolveHostTarget: targetResolver(), notifyStalledTransition: notify });
    const stamped = readResidencyJournal(projectId);
    expect(stamped?.last_error).toContain('500');
    expect(stalls).toHaveLength(0);

    // Age the transition past the stall threshold, keeping it failing.
    writeResidencyJournal({ ...stamped!, created_at: new Date(Date.now() - 40 * 60 * 1000).toISOString() });

    // The stall check runs AFTER this pass's own failed attempt, against the
    // stamp the pass just wrote — so it fires regardless of drain cadence.
    await runResidencyTransitions({ ...baseDeps(), pullTransport: failing, resolveHostTarget: targetResolver(), notifyStalledTransition: notify });
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.projectId).toBe(projectId);
    expect(stalls[0]!.ms).toBeGreaterThanOrEqual(30 * 60 * 1000);

    // Still stalled on the next tick — but inside the re-notify interval, so silent.
    await runResidencyTransitions({ ...baseDeps(), pullTransport: failing, resolveHostTarget: targetResolver(), notifyStalledTransition: notify });
    expect(stalls).toHaveLength(1);
  });

  test('an old transition whose attempt did NOT fail this pass stays silent — a stale stamp is not a stall', async () => {
    // A journal shape the drain no-ops (attach direction in a non-attach
    // phase): the pass makes no attempt and writes no stamp, so the only
    // failure evidence is the OLD stamp — the freshness gate must reject it.
    const local = createGrove('Local', home);
    const host = makeHost(3);
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    registerProjectInGrove(local.id, { projectId, projectName: 'demo', projectRoot: root }, home);
    clearGroveRegistryCaches();
    startResidencyJournal({
      direction: 'attach', phase: 'pulling', host_id: host.host_id, project_id: projectId,
      divert_grove_id: host.served_grove_id!, source_grove_id: local.id,
      project_name: 'demo', root, backup_ref: null, cursors: {},
    });
    const journal = readResidencyJournal(projectId)!;
    writeResidencyJournal({
      ...journal,
      created_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      last_error: 'old failure',
      last_error_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    const stalls: unknown[] = [];
    await runResidencyTransitions({
      ...baseDeps(),
      pullTransport: pagingPull([]).transport,
      resolveHostTarget: targetResolver(),
      notifyStalledTransition: (j) => { stalls.push(j); },
    });
    expect(stalls).toHaveLength(0);
  });

  test('a failed re-home preserves the journal in rehoming — the buffered events keep their retry path', async () => {
    const local = createGrove('Local', home);
    const host = makeHost(3);
    const projectId = createProjectId();
    const root = makeCheckout(projectId);
    registerProjectInGrove(local.id, { projectId, projectName: 'demo', projectRoot: root }, home);
    clearGroveRegistryCaches();
    startResidencyJournal({
      direction: 'detach', phase: 'rehoming', host_id: host.host_id, project_id: projectId,
      divert_grove_id: host.served_grove_id!, source_grove_id: host.served_grove_id!, target_grove_id: local.id,
      project_name: 'demo', root, backup_ref: null, cursors: { pull: 'done' },
    });
    // Seed a buffered file, then deny enumeration of the divert buffer dir —
    // an undetermined read must NOT count as "nothing buffered".
    const fromDir = resolveProjectBufferDir(host.served_grove_id!, projectId, home);
    fs.mkdirSync(fromDir, { recursive: true });
    fs.writeFileSync(path.join(fromDir, 'sess_x.jsonl'), '{"event":"x"}\n', 'utf-8');
    fs.chmodSync(fromDir, 0o000); // deny enumeration
    try {
      await runResidencyTransitions({ ...baseDeps(), pullTransport: pagingPull([]).transport, resolveHostTarget: targetResolver() });
    } finally {
      fs.chmodSync(fromDir, 0o700); // restore so the fixture can clean up
    }

    const journal = readResidencyJournal(projectId);
    expect(journal?.phase).toBe('rehoming'); // NOT cleared — the journal is the retry path
    expect(journal?.last_error).toBeTruthy();
  });
});
