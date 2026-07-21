/**
 * Team Host — host detach-pull (Phase F T3).
 *
 * Covers the pull enumerator (machine scoping, publications-regardless-of-machine,
 * FK-topological order, cursor resume mid-table, identical page re-request), the
 * true-stub predicate, and the handler's exactly-once-ish side effects (first-page
 * claim release, done-page transcript purge + stub deregister + status-cache
 * invalidation), plus tenancy/body validation.
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
import { ROUTED_RESIDENCY_PULL_PATH } from '@myco/host/residency-journal.js';
import { getDatabase } from '@myco/db/client.js';
import {
  pullResidencyPage,
  projectHasForeignMachineRows,
} from '@myco/db/queries/residency-pull.js';
import { createRoutedResidencyPullHandler } from '@myco/host/routed-residency-pull.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  getRegisteredProjectInGrove,
  registerProjectInGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { hostedProjectRoot } from '@myco/host/hosted-projects.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import { initTeamContext, resetTeamContext } from '@myco/team/context.js';
import { resolveRoutedTranscriptsDir } from '@myco/grove/paths.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';

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

describe('residency-pull route wiring', () => {
  test('the pull route is collect-stamped with the Collection capability', () => {
    expect(classifyRouteStamp('POST', ROUTED_RESIDENCY_PULL_PATH)).toEqual({
      stamp: 'collect',
      capability: 'Collection',
    });
  });

  test('the daemon mounts the pull handler at ROUTED_RESIDENCY_PULL_PATH', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const mainSrc = fs.readFileSync(path.join(repoRoot, 'packages', 'myco', 'src', 'daemon', 'main.ts'), 'utf8');
    const match = mainSrc.match(/\.registerRoute\(\s*'POST'\s*,\s*'([^']+)'\s*,\s*createRoutedResidencyPullHandler/);
    expect(match, 'no registerRoute(POST, <path>, createRoutedResidencyPullHandler(...)) in daemon/main.ts').not.toBeNull();
    expect(match![1]).toBe(ROUTED_RESIDENCY_PULL_PATH);
  });
});

// ---------------------------------------------------------------------------
// (1) Pull enumerator
// ---------------------------------------------------------------------------

describe('residency detach-pull enumeration', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  test('returns only the caller machine rows; host and other-member rows are excluded', () => {
    seedNoFk(() => {
      insertSession('s_a1', PROJ, MEMBER_A);
      insertSession('s_a2', PROJ, MEMBER_A);
      insertSession('s_b1', PROJ, MEMBER_B);       // another member
      insertSession('s_host', PROJ, HOST_MACHINE); // host-derived
      insertSession('s_other', PROJ2, MEMBER_A);   // different project
    });
    const page = pullResidencyPage(getDatabase(), { projectId: PROJ, machineId: MEMBER_A });
    const sessionIds = page.rows.filter((r) => r.table === 'sessions').map((r) => r.row.id).sort();
    expect(sessionIds).toEqual(['s_a1', 's_a2']);
    expect(page.done).toBe(true);
  });

  test('includes content_publications for the project artifacts regardless of machine', () => {
    seedNoFk(() => {
      insertSkillRecord('sk1', PROJ, MEMBER_A);
      insertSkillRecord('sk_other', PROJ2, MEMBER_A);
      insertPublication('sk1', 3, HOST_MACHINE);      // host-published, still returned
      insertPublication('sk_other', 1, MEMBER_A);     // other project's artifact — excluded
    });
    const page = pullResidencyPage(getDatabase(), { projectId: PROJ, machineId: MEMBER_A });
    const pubs = page.rows.filter((r) => r.table === 'content_publications');
    expect(pubs).toHaveLength(1);
    expect(pubs[0].row.artifact_id).toBe('sk1');
    expect(pubs[0].row.published_generation).toBe(3);
  });

  test('emits tables in FK-topological order (parents before children)', () => {
    seedNoFk(() => {
      insertSpore('sp1', PROJ, MEMBER_A);
      insertSession('s_a1', PROJ, MEMBER_A);
    });
    const page = pullResidencyPage(getDatabase(), { projectId: PROJ, machineId: MEMBER_A });
    const tables = page.rows.map((r) => r.table);
    expect(tables.indexOf('sessions')).toBeLessThan(tables.indexOf('spores'));
  });

  test('resumes mid-table on the cursor and re-requests a page identically', () => {
    seedNoFk(() => {
      insertSession('s_a1', PROJ, MEMBER_A);
      insertSession('s_a2', PROJ, MEMBER_A);
      insertSession('s_a3', PROJ, MEMBER_A);
    });
    const first = pullResidencyPage(getDatabase(), { projectId: PROJ, machineId: MEMBER_A, maxRows: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.done).toBe(false);
    expect(first.nextCursor).not.toBeNull();

    // Re-request the SAME first page → identical rows (lost-ack safety).
    const firstAgain = pullResidencyPage(getDatabase(), { projectId: PROJ, machineId: MEMBER_A, maxRows: 2 });
    expect(firstAgain.rows.map((r) => r.row.id)).toEqual(first.rows.map((r) => r.row.id));

    const second = pullResidencyPage(getDatabase(), { projectId: PROJ, machineId: MEMBER_A, cursor: first.nextCursor, maxRows: 2 });
    const allIds = [...first.rows, ...second.rows].map((r) => r.row.id).sort();
    expect(allIds).toEqual(['s_a1', 's_a2', 's_a3']);
    expect(second.done).toBe(true);
  });

  test('an empty project pulls one done page with no rows', () => {
    const page = pullResidencyPage(getDatabase(), { projectId: PROJ, machineId: MEMBER_A });
    expect(page.rows).toHaveLength(0);
    expect(page.done).toBe(true);
    expect(page.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (2) True-stub predicate
// ---------------------------------------------------------------------------

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

describe('detach-pull handler side effects', () => {
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

  async function pull(cursor: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
    const handler = createRoutedResidencyPullHandler({ mycoHome: home });
    const res = await handler({
      body: { cursor }, query: {}, params: {}, pathname: '/routed-capture/residency-pull',
      requestContext: reqCtx(grove.id, projectId, MEMBER_A),
    });
    return { status: res.status ?? 200, body: res.body as Record<string, unknown> };
  }

  test('releases the caller machine claims on the first page, idempotently', async () => {
    registerHosted();
    seedNoFk(() => {
      insertActiveClaim('cl_a', 'sk1', projectId, MEMBER_A);   // caller's — released
      insertActiveClaim('cl_b', 'sk2', projectId, MEMBER_B);   // other member — untouched
      insertActiveClaim('cl_a2', 'sk3', PROJ2, MEMBER_A);      // caller, other project — untouched
    });
    await pull(null);
    expect(claimState('cl_a')).toBe('released');
    expect(claimState('cl_b')).toBe('active');
    expect(claimState('cl_a2')).toBe('active');

    // Re-pull the first page — already released, no error, still released.
    const again = await pull(null);
    expect(again.status).toBe(200);
    expect(claimState('cl_a')).toBe('released');
  });

  test('done page on a true stub deregisters the hosted row', async () => {
    registerHosted();
    seedNoFk(() => {
      insertSession('s_a', projectId, MEMBER_A);        // caller's
      insertSession('s_host', projectId, HOST_MACHINE); // host-derived
    });
    expect(getRegisteredProjectInGrove(grove.id, projectId, home)).not.toBeNull();

    const res = await pull(null); // small project → single done page
    expect(res.body.done).toBe(true);
    expect(getRegisteredProjectInGrove(grove.id, projectId, home)).toBeNull();
  });

  test('done page with another member still present does NOT deregister', async () => {
    registerHosted();
    seedNoFk(() => {
      insertSession('s_a', projectId, MEMBER_A);
      insertSpore('sp_b', projectId, MEMBER_B); // another member's row
    });
    const res = await pull(null);
    expect(res.body.done).toBe(true);
    expect(getRegisteredProjectInGrove(grove.id, projectId, home)).not.toBeNull();
  });

  test('done page purges the departing project session transcript trees only', async () => {
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

    const res = await pull(null);
    expect(res.body.done).toBe(true);
    expect(fs.existsSync(projectTree)).toBe(false);   // the project's session tree is purged
    expect(fs.existsSync(unrelatedTree)).toBe(true);  // an unrelated session tree survives
  });

  test('rejects a request missing tenancy', async () => {
    const handler = createRoutedResidencyPullHandler({ mycoHome: home });
    const res = await handler({
      body: { cursor: null }, query: {}, params: {}, pathname: '/routed-capture/residency-pull',
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
