/**
 * Team Host — host side of the HYBRID detach (artifact + goodbye routes).
 *
 * Covers the artifact handler (whole-project scope across ALL machines, host
 * roster excluded, digest correctness, lineage neutralization proven against
 * grove-pathed DBs on both sides), the goodbye handler's idempotent side
 * effects (claims release, machine-scoped transcript prune, true-stub
 * deregister + status-cache invalidation), the stub predicate, and tenancy
 * validation.
 *
 * Hermetic: an in-memory DB (`setupTestDb`) for rows/claims; a fresh MYCO_HOME +
 * MYCO_TEAM_HOME for the registry deregister + transcript trees.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { classifyRouteStamp } from '@myco/host/routing.js';
import { ROUTED_DETACH_ARTIFACT_PATH, ROUTED_DETACH_COMPLETE_PATH } from '@myco/host/residency-journal.js';
import { getDatabase } from '@myco/db/client.js';
import { projectHasForeignMachineRows } from '@myco/db/queries/residency-pull.js';
import {
  _clearDetachArtifactCacheForTests,
  createRoutedDetachArtifactHandler,
  createRoutedDetachCompleteHandler,
  neutralizeArtifactLineage,
} from '@myco/host/routed-residency-detach.js';
import { createHash } from 'node:crypto';
import { Database as BunDatabase } from 'bun:sqlite';
import { createSchema } from '@myco/db/schema.js';
import { createBackup, restoreBackup, projectScope, DETACH_ARTIFACT_TABLES } from '@myco/backup/engine.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  getRegisteredProjectInGrove,
  registerProjectInGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { hostedProjectRoot, maybeRegisterHostedProjectOnIngest } from '@myco/host/hosted-projects.js';
import { ROUTED_RESIDENCY_ROWS_PATH } from '@myco/host/residency-journal.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import { initTeamContext, resetTeamContext } from '@myco/team/context.js';
import { resolveRoutedTranscriptsDir } from '@myco/grove/paths.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const NOW = 1_000_000;
const HOST_MACHINE = 'host-machine';
const MEMBER_A = 'member-a';
const MEMBER_B = 'member-b';
const PROJ = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROJ2 = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function seedNoFk(fn: () => void): void {
  const db = getDatabase();
  db.run('PRAGMA foreign_keys = OFF');
  try { fn(); } finally { db.run('PRAGMA foreign_keys = ON'); }
}

function insertSession(id: string, projectId: string, machineId: string): void {
  getDatabase().prepare(
    `INSERT INTO sessions (id, agent, project_id, started_at, status, created_at, machine_id)
     VALUES (?, 'claude', ?, ?, 'active', ?, ?)`,
  ).run(id, projectId, NOW, NOW, machineId);
}

function insertSpore(id: string, projectId: string, machineId: string): void {
  getDatabase().prepare(
    `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id)
     VALUES (?, ?, 'myco-agent', 'decision', 'c', ?, ?)`,
  ).run(id, projectId, NOW, machineId);
}

function insertSkillRecord(id: string, projectId: string, machineId: string): void {
  getDatabase().prepare(
    `INSERT INTO skill_records (id, project_id, agent_id, machine_id, name, display_name, description, path, created_at, updated_at)
     VALUES (?, ?, 'myco-agent', ?, 'n', 'N', 'd', '/p', ?, ?)`,
  ).run(id, projectId, machineId, NOW, NOW);
}

function insertPublication(artifactId: string, generation: number, machineId: string): void {
  getDatabase().prepare(
    `INSERT INTO content_publications (artifact_kind, artifact_id, published_generation, published_at, published_by, machine_id)
     VALUES ('skill', ?, ?, ?, 'pub', ?)`,
  ).run(artifactId, generation, NOW, machineId);
}

function insertActiveClaim(id: string, artifactId: string, projectId: string, machineId: string): void {
  getDatabase().prepare(
    `INSERT INTO content_claims (id, artifact_kind, artifact_id, generation, project_id, claimed_by, claimed_at, expires_at, state, machine_id)
     VALUES (?, 'skill', ?, 1, ?, 'u', ?, ?, 'active', ?)`,
  ).run(id, artifactId, projectId, NOW, NOW + 1_000_000, machineId);
}

function claimState(id: string): string | undefined {
  return (getDatabase().prepare('SELECT state FROM content_claims WHERE id = ?').get(id) as { state: string } | undefined)?.state;
}

function reqCtx(groveId: string, projectId: string, machineId: string): MycoRequestContext {
  return { groveId, projectId: assertGroveProjectId(projectId), machineId } as MycoRequestContext;
}

// ---------------------------------------------------------------------------
// (0) Route wiring
// ---------------------------------------------------------------------------

describe('detach route wiring', () => {
  test('both detach routes are collect-stamped with the Collection capability', () => {
    expect(classifyRouteStamp('POST', ROUTED_DETACH_ARTIFACT_PATH)).toEqual({ stamp: 'collect', capability: 'Collection' });
    expect(classifyRouteStamp('POST', ROUTED_DETACH_COMPLETE_PATH)).toEqual({ stamp: 'collect', capability: 'Collection' });
  });

  test('the daemon mounts both handlers at their path constants', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const mainSrc = fs.readFileSync(path.join(repoRoot, 'packages', 'myco', 'src', 'daemon', 'main.ts'), 'utf8');
    const artifact = mainSrc.match(/\.registerRoute\(\s*'POST'\s*,\s*'([^']+)'\s*,\s*createRoutedDetachArtifactHandler/);
    expect(artifact, 'artifact handler not mounted').not.toBeNull();
    expect(artifact![1]).toBe(ROUTED_DETACH_ARTIFACT_PATH);
    const complete = mainSrc.match(/\.registerRoute\(\s*'POST'\s*,\s*'([^']+)'\s*,\s*createRoutedDetachCompleteHandler/);
    expect(complete, 'complete handler not mounted').not.toBeNull();
    expect(complete![1]).toBe(ROUTED_DETACH_COMPLETE_PATH);
  });

  test('the retired pull path answers a guidance tombstone, never the old handler', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const mainSrc = fs.readFileSync(path.join(repoRoot, 'packages', 'myco', 'src', 'daemon', 'main.ts'), 'utf8');
    // The literal path stays mounted — as a 410 tombstone with actionable
    // copy for an OLD member mid-detach — and the retired handler is gone.
    expect(mainSrc).toContain("'residency_pull_retired'");
    expect(mainSrc).not.toContain('createRoutedResidencyPullHandler');
  });
});

// ---------------------------------------------------------------------------
// (1) Artifact handler
// ---------------------------------------------------------------------------

describe('detach artifact handler', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); initTeamContext(HOST_MACHINE); _clearDetachArtifactCacheForTests(); });
  afterEach(() => { resetTeamContext(); });

  /** Drive the full prepare/chunk protocol and reassemble the artifact. */
  async function fetchArtifact(): Promise<{ status: number; artifact: string; sha256: string; size: number }> {
    const handler = createRoutedDetachArtifactHandler({});
    const call = async (body: Record<string, unknown>) => {
      const res = await handler({
        body, query: {}, params: {}, pathname: ROUTED_DETACH_ARTIFACT_PATH,
        requestContext: reqCtx('grove_x', PROJ, MEMBER_A),
      });
      return { status: res.status ?? 200, body: res.body as Record<string, unknown> };
    };
    const prep = await call({ op: 'prepare' });
    if (prep.status !== 200 || prep.body.ready !== true) {
      return { status: prep.status, artifact: '', sha256: '', size: 0 };
    }
    const sha256 = prep.body.sha256 as string;
    const size = prep.body.size as number;
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const piece = await call({ op: 'chunk', offset, sha256 });
      expect(piece.status).toBe(200);
      expect(piece.body.restart).not.toBe(true);
      parts.push(Buffer.from(piece.body.chunk as string, 'base64'));
      const next = piece.body.next_offset as number | null;
      if (next === null) break;
      offset = next;
    }
    return { status: 200, artifact: Buffer.concat(parts).toString('utf-8'), sha256, size };
  }

  test('the artifact carries the WHOLE project — every machine\'s rows — and nothing from other projects', async () => {
    seedNoFk(() => {
      insertSession('s_a1', PROJ, MEMBER_A);
      insertSession('s_b1', PROJ, MEMBER_B);       // another member: the project moves whole (rev 4 C1)
      insertSession('s_host', PROJ, HOST_MACHINE); // host intelligence rows too
      insertSession('s_other', PROJ2, MEMBER_A);   // different project — excluded
    });
    const res = await fetchArtifact();
    expect(res.status).toBe(200);
    const artifact = res.artifact;
    expect(artifact).toContain("'s_a1'");
    expect(artifact).toContain("'s_b1'");
    expect(artifact).toContain("'s_host'");
    expect(artifact).not.toContain("'s_other'");
  });

  test('the artifact NEVER carries the host roster', async () => {
    seedNoFk(() => {
      insertSession('s_a1', PROJ, MEMBER_A);
      getDatabase().prepare(`INSERT INTO team_members (id, "user", machine_id) VALUES ('tm1', 'operator', 'host')`).run();
    });
    const res = await fetchArtifact();
    expect(res.artifact).not.toContain('team_members');
  });

  test('sha256 and size describe the exact artifact bytes', async () => {
    seedNoFk(() => { insertSession('s_a1', PROJ, MEMBER_A); });
    const res = await fetchArtifact();
    expect(res.sha256).toBe(createHash('sha256').update(res.artifact, 'utf-8').digest('hex'));
    expect(res.size).toBe(Buffer.byteLength(res.artifact, 'utf-8'));
  });

  test('rejects a request missing tenancy', async () => {
    const handler = createRoutedDetachArtifactHandler({});
    const res = await handler({
      body: { op: 'prepare' }, query: {}, params: {}, pathname: ROUTED_DETACH_ARTIFACT_PATH,
      requestContext: { groveId: 'grove_x', projectId: null, machineId: MEMBER_A } as MycoRequestContext,
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// (1b) Lineage neutralization — proven against grove-pathed DBs on BOTH sides
// ---------------------------------------------------------------------------

describe('artifact lineage neutralization', () => {
  test('a host-grove dump restores into a DIFFERENT member grove only after neutralization', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-lineage-'));
    try {
      const hostDbPath = path.join(home, 'groves', 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'myco.db');
      const memberDbPath = path.join(home, 'groves', 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'myco.db');
      fs.mkdirSync(path.dirname(hostDbPath), { recursive: true });
      fs.mkdirSync(path.dirname(memberDbPath), { recursive: true });
      const hostDb = new BunDatabase(hostDbPath);
      const memberDb = new BunDatabase(memberDbPath);
      createSchema(hostDb, 'host');
      createSchema(memberDb, 'member');
      hostDb.run('PRAGMA foreign_keys = OFF');
      hostDb.prepare(
        `INSERT INTO sessions (id, agent, project_id, started_at, status, created_at, machine_id)
         VALUES ('s1', 'claude', ?, 1, 'active', 1, 'm')`,
      ).run(PROJ);
      const dump = createBackup(hostDb, path.join(home, 'dumps'), 'host', projectScope(assertGroveProjectId(PROJ)), 'detach', DETACH_ARTIFACT_TABLES);
      const raw = fs.readFileSync(dump, 'utf-8');
      expect(raw).toContain('-- grove_id:'); // the host lineage IS emitted for a grove-pathed DB

      // Un-neutralized: the member-side lineage gate refuses the cross-grove restore.
      expect(() => restoreBackup(memberDb, dump)).toThrow();

      // Neutralized: restores cleanly — the detach artifact is cross-grove BY DESIGN.
      const cleanPath = path.join(home, 'dumps', 'clean.sql');
      fs.writeFileSync(cleanPath, neutralizeArtifactLineage(raw), 'utf-8');
      restoreBackup(memberDb, cleanPath);
      const c = (memberDb.prepare(`SELECT COUNT(*) c FROM sessions WHERE id = 's1'`).get() as { c: number }).c;
      expect(c).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('projectHasForeignMachineRows', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  test('false when only the excluded machines (host + caller) have rows — a true stub', () => {
    seedNoFk(() => {
      insertSession('s_a', PROJ, MEMBER_A);      // the departing caller
      insertSession('s_host', PROJ, HOST_MACHINE); // host-derived
    });
    expect(projectHasForeignMachineRows(getDatabase(), PROJ, [HOST_MACHINE, MEMBER_A])).toBe(false);
  });

  test('true when another member still has rows — blocks deregister', () => {
    seedNoFk(() => {
      insertSession('s_a', PROJ, MEMBER_A);
      insertSpore('sp_b', PROJ, MEMBER_B);       // another member's row, a different table
    });
    expect(projectHasForeignMachineRows(getDatabase(), PROJ, [HOST_MACHINE, MEMBER_A])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (3) Handler side effects
// ---------------------------------------------------------------------------

describe('detach goodbye handler side effects', () => {
  let home: string;
  let grove: GroveRecord;
  let projectId: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-detach-pull-'));
    clearGroveRegistryCaches();
    initTeamContext(HOST_MACHINE);
    grove = createGrove('Served', home);
    projectId = assertGroveProjectId(createProjectId());
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    clearGroveRegistryCaches();
    resetTeamContext();
  });

  function registerHosted(): void {
    registerProjectInGrove(grove.id, {
      projectId, projectName: 'Real', projectRoot: hostedProjectRoot(grove.id, projectId, home),
    }, home);
  }

  async function goodbye(asMachine: string = MEMBER_A): Promise<{ status: number; body: Record<string, unknown> }> {
    const handler = createRoutedDetachCompleteHandler({ mycoHome: home });
    const res = await handler({
      body: {}, query: {}, params: {}, pathname: ROUTED_DETACH_COMPLETE_PATH,
      requestContext: reqCtx(grove.id, projectId, asMachine),
    });
    return { status: res.status ?? 200, body: res.body as Record<string, unknown> };
  }

  test('releases the departing machine claims, idempotently', async () => {
    registerHosted();
    seedNoFk(() => {
      insertActiveClaim('cl_a', 'sk1', projectId, MEMBER_A);   // caller's — released
      insertActiveClaim('cl_b', 'sk2', projectId, MEMBER_B);   // other member — untouched
      insertActiveClaim('cl_a2', 'sk3', PROJ2, MEMBER_A);      // caller, other project — untouched
    });
    await goodbye();
    expect(claimState('cl_a')).toBe('released');
    expect(claimState('cl_b')).toBe('active');
    expect(claimState('cl_a2')).toBe('active');

    // A replayed goodbye — already released, no error, still released.
    const again = await goodbye();
    expect(again.status).toBe(200);
    expect(claimState('cl_a')).toBe('released');
  });

  test('a goodbye on a true stub deregisters the hosted row', async () => {
    registerHosted();
    seedNoFk(() => {
      insertSession('s_a', projectId, MEMBER_A);        // caller's
      insertSession('s_host', projectId, HOST_MACHINE); // host-derived
    });
    expect(getRegisteredProjectInGrove(grove.id, projectId, home)).not.toBeNull();

    const res = await goodbye();
    expect(res.status).toBe(200);
    expect(getRegisteredProjectInGrove(grove.id, projectId, home)).toBeNull();
  });

  test('a stub deregister self-heals: a later first-capture re-registers via the ingest seam', async () => {
    // The attached-but-never-captured edge: a member with no host-visible rows is
    // invisible to the stub check, so a sole-contributor detach deregisters the
    // project. That member's first forwarded capture must re-register it.
    registerHosted();
    seedNoFk(() => insertSession('s_a', projectId, MEMBER_A)); // only the departing caller
    await goodbye();
    expect(getRegisteredProjectInGrove(grove.id, projectId, home)).toBeNull(); // deregistered

    // The (previously never-captured) member's first collect capture hits the seam.
    const outcome = maybeRegisterHostedProjectOnIngest({
      method: 'POST',
      pathname: ROUTED_RESIDENCY_ROWS_PATH,
      headers: { 'x-myco-grove-id': grove.id, 'x-myco-project-id': projectId },
      servedGroveId: grove.id,
      mycoHome: home,
    });
    expect(outcome.registered).toBe(true);
    expect(getRegisteredProjectInGrove(grove.id, projectId, home)).not.toBeNull();
  });

  test('a goodbye with another member still present does NOT deregister', async () => {
    registerHosted();
    seedNoFk(() => {
      insertSession('s_a', projectId, MEMBER_A);
      insertSpore('sp_b', projectId, MEMBER_B); // another member's row
    });
    const res = await goodbye();
    expect(res.status).toBe(200);
    expect(getRegisteredProjectInGrove(grove.id, projectId, home)).not.toBeNull();
  });

  test('a goodbye purges the departing machine\'s session transcript trees only', async () => {
    registerHosted();
    seedNoFk(() => {
      insertSession('s_a', projectId, MEMBER_A);
      insertSpore('sp_b', projectId, MEMBER_B); // keep the project non-stub so we isolate the purge
    });
    // Materialize a transcript tree for the caller's session AND one for an unrelated session.
    const root = resolveRoutedTranscriptsDir();
    const projectTree = path.join(root, MEMBER_A, 's_a');
    const unrelatedTree = path.join(root, MEMBER_A, 's_unrelated');
    fs.mkdirSync(projectTree, { recursive: true });
    fs.mkdirSync(unrelatedTree, { recursive: true });
    fs.writeFileSync(path.join(projectTree, 't.jsonl'), 'x');
    fs.writeFileSync(path.join(unrelatedTree, 't.jsonl'), 'y');

    const res = await goodbye();
    expect(res.status).toBe(200);
    expect(fs.existsSync(projectTree)).toBe(false);   // the project's session tree is purged
    expect(fs.existsSync(unrelatedTree)).toBe(true);  // an unrelated session tree survives
  });

  test('the LAST member reclaim fires even though earlier members\' rows stay (departed set)', async () => {
    registerHosted();
    seedNoFk(() => {
      insertSession('s_a', projectId, MEMBER_A);
      insertSpore('sp_b', projectId, MEMBER_B);
    });
    // A departs first: B still present → no deregister.
    await goodbye(MEMBER_A);
    expect(getRegisteredProjectInGrove(grove.id, projectId, home)).not.toBeNull();
    // B departs: A's rows remain forever (copy-out) but A is in the departed
    // set — without it this reclaim could never fire for any project two
    // machines ever touched.
    await goodbye(MEMBER_B);
    expect(getRegisteredProjectInGrove(grove.id, projectId, home)).toBeNull();
  });

  test('rejects a request missing tenancy', async () => {
    const handler = createRoutedDetachCompleteHandler({ mycoHome: home });
    const res = await handler({
      body: {}, query: {}, params: {}, pathname: ROUTED_DETACH_COMPLETE_PATH,
      requestContext: { groveId: grove.id, projectId: null, machineId: MEMBER_A } as MycoRequestContext,
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('missing_tenancy');
  });
});

// ---------------------------------------------------------------------------
// (4) Status-cache invalidation seam
// ---------------------------------------------------------------------------

describe('host-serve status cache invalidation', () => {
  test('a bump drops the cached bundle before the TTL', async () => {
    const { createHostServeStatusHandler, invalidateHostServeStatusCache } = await import('@myco/daemon/api/host-serve-status.js');
    const { loadMachineConfig } = await import('@myco/config/loader.js');
    const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-status-cache-'));
    try {
      let count = 0;
      // A real (default) config so the full status body computes; a frozen `now`
      // and long TTL so only the epoch — not time — can drop the cache.
      const handler = createHostServeStatusHandler({
        hostServe: { servedGroveId: null, overlayAddress: '', hostId: null, label: null, bearer: '' } as never,
        loadMachineConfig: (h: string) => { count += 1; return loadMachineConfig(h); },
        now: () => 1_000,
        ttlMs: 100_000,
        mycoHome: cacheHome,
        lockNamespace: testPerUserLockNamespace,
      });
      const call = () => handler({ body: undefined, query: {}, params: {}, pathname: '/api/host-serve/status' } as never);
      await call();
      await call();
      expect(count).toBe(1); // second served from cache

      invalidateHostServeStatusCache();
      await call();
      expect(count).toBe(2); // recomputed after invalidation
    } finally {
      fs.rmSync(cacheHome, { recursive: true, force: true });
    }
  });
});
