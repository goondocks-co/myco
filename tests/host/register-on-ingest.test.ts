/**
 * Team Host — host-side registration-on-ingest + hosted-row lifecycle (E-4 W2 T1).
 *
 * The pure decision + lifecycle surface of `host/hosted-projects.ts`:
 *   - `maybeRegisterHostedProjectOnIngest` gates (served grove, collect stamp,
 *     grove==served, grove-era project id, not-already-registered) and the
 *     synthetic-root row it writes.
 *   - `listHostedProjects` / `countHostedProjects` (operator visibility).
 *   - `pruneHostedProjects` delete-only-if-empty GC.
 *
 * Hermetic: `MYCO_HOME` is a fresh tmpdir per test; every registry helper is
 * passed the explicit home so nothing touches a real vault.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  countHostedProjects,
  hostedProjectName,
  hostedProjectRoot,
  isHostedProjectRoot,
  listHostedProjects,
  maybeRegisterHostedProjectOnIngest,
  pruneHostedProjects,
} from '@myco/host/hosted-projects.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  getRegisteredProjectInGrove,
  registerProjectInGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { assertSafeProjectRoot } from '@myco/vault/resolve.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { HOSTED_PROJECT_NAME_ID_SUFFIX_LEN, HOSTED_PROJECT_PRUNE_TTL_MS } from '@myco/constants.js';
import type { Database } from '@myco/db/client.js';

const COLLECT_ROUTE = '/sessions/register';
const SERVE_ROUTE = '/api/spores';

describe('host registration-on-ingest + hosted lifecycle', () => {
  let home: string;
  let servedGrove: GroveRecord;
  let otherGrove: GroveRecord;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-register-on-ingest-'));
    clearGroveRegistryCaches();
    servedGrove = createGrove('Served', home);
    otherGrove = createGrove('Other', home);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    clearGroveRegistryCaches();
  });

  function headers(groveId: string | undefined, projectId: string | undefined): Record<string, string> {
    const h: Record<string, string> = {};
    if (groveId !== undefined) h['x-myco-grove-id'] = groveId;
    if (projectId !== undefined) h['x-myco-project-id'] = projectId;
    return h;
  }

  // -- (1a) the happy path: registers a synthetic-root row --------------------

  test('collect route + served grove + unknown grove-era project → registers a hosted row (AC #1 registry half)', () => {
    const projectId = assertGroveProjectId(createProjectId());
    const outcome = maybeRegisterHostedProjectOnIngest({
      method: 'POST',
      pathname: COLLECT_ROUTE,
      headers: headers(servedGrove.id, projectId),
      servedGroveId: servedGrove.id,
      mycoHome: home,
    });
    expect(outcome.registered).toBe(true);
    expect(outcome.projectId).toBe(projectId);
    expect(outcome.groveId).toBe(servedGrove.id);

    const row = getRegisteredProjectInGrove(servedGrove.id, projectId, home);
    expect(row).not.toBeNull();
    expect(row!.root).toBe(hostedProjectRoot(servedGrove.id, projectId, home));
    expect(row!.name).toBe(projectId.slice(-HOSTED_PROJECT_NAME_ID_SUFFIX_LEN));
  });

  test('the synthetic root passes assertSafeProjectRoot and never exists on disk', () => {
    const projectId = assertGroveProjectId(createProjectId());
    const root = hostedProjectRoot(servedGrove.id, projectId, home);
    expect(() => assertSafeProjectRoot(root)).not.toThrow();
    expect(fs.existsSync(root)).toBe(false);
    expect(isHostedProjectRoot(root, servedGrove.id, home)).toBe(true);
  });

  test('hostedProjectName is the last-N hex of the id', () => {
    const projectId = assertGroveProjectId(createProjectId());
    expect(hostedProjectName(projectId)).toBe(projectId.slice(-HOSTED_PROJECT_NAME_ID_SUFFIX_LEN));
    expect(hostedProjectName(projectId).length).toBe(HOSTED_PROJECT_NAME_ID_SUFFIX_LEN);
  });

  // -- (4) idempotent: repeat ingest → exactly one row -----------------------

  test('repeat ingest of the same project → exactly one row, second call is a no-op (AC #4)', () => {
    const projectId = assertGroveProjectId(createProjectId());
    const first = maybeRegisterHostedProjectOnIngest({
      method: 'POST', pathname: COLLECT_ROUTE, headers: headers(servedGrove.id, projectId),
      servedGroveId: servedGrove.id, mycoHome: home,
    });
    expect(first.registered).toBe(true);
    const second = maybeRegisterHostedProjectOnIngest({
      method: 'POST', pathname: COLLECT_ROUTE, headers: headers(servedGrove.id, projectId),
      servedGroveId: servedGrove.id, mycoHome: home,
    });
    expect(second.registered).toBe(false);
    expect(countHostedProjects(servedGrove.id, home)).toBe(1);
  });

  // -- (6) non-served grove header → refused, zero side-effect ----------------

  test('a NON-served grove header registers nothing anywhere (AC #6)', () => {
    const projectId = assertGroveProjectId(createProjectId());
    const outcome = maybeRegisterHostedProjectOnIngest({
      method: 'POST', pathname: COLLECT_ROUTE, headers: headers(otherGrove.id, projectId),
      servedGroveId: servedGrove.id, mycoHome: home,
    });
    expect(outcome.registered).toBe(false);
    expect(getRegisteredProjectInGrove(otherGrove.id, projectId, home)).toBeNull();
    expect(getRegisteredProjectInGrove(servedGrove.id, projectId, home)).toBeNull();
  });

  // -- (7) garbage / non-grove-era project ids → never register ---------------

  test('a garbage / non-grove-era project id never registers (AC #7)', () => {
    for (const bad of ['not-a-project-id', 'grove_0123456789abcdef0123456789abcdef', '', 'proj_short']) {
      const outcome = maybeRegisterHostedProjectOnIngest({
        method: 'POST', pathname: COLLECT_ROUTE, headers: headers(servedGrove.id, bad || undefined),
        servedGroveId: servedGrove.id, mycoHome: home,
      });
      expect(outcome.registered).toBe(false);
    }
    expect(countHostedProjects(servedGrove.id, home)).toBe(0);
  });

  // -- gate misses: non-collect route, no designation, missing headers --------

  test('a serve-stamped (non-collect) route never registers', () => {
    const projectId = assertGroveProjectId(createProjectId());
    const outcome = maybeRegisterHostedProjectOnIngest({
      method: 'GET', pathname: SERVE_ROUTE, headers: headers(servedGrove.id, projectId),
      servedGroveId: servedGrove.id, mycoHome: home,
    });
    expect(outcome.registered).toBe(false);
    expect(getRegisteredProjectInGrove(servedGrove.id, projectId, home)).toBeNull();
  });

  test('no served-grove designation never registers', () => {
    const projectId = assertGroveProjectId(createProjectId());
    const outcome = maybeRegisterHostedProjectOnIngest({
      method: 'POST', pathname: COLLECT_ROUTE, headers: headers(servedGrove.id, projectId),
      servedGroveId: null, mycoHome: home,
    });
    expect(outcome.registered).toBe(false);
  });

  test('a missing project header never registers', () => {
    const outcome = maybeRegisterHostedProjectOnIngest({
      method: 'POST', pathname: COLLECT_ROUTE, headers: headers(servedGrove.id, undefined),
      servedGroveId: servedGrove.id, mycoHome: home,
    });
    expect(outcome.registered).toBe(false);
  });

  // -- listHostedProjects distinguishes synthetic rows from real-root rows ----

  test('listHostedProjects/countHostedProjects count only synthetic-root rows', () => {
    // A normal project with a REAL working tree root — never a hosted row.
    const realRoot = path.join(home, 'real-project');
    fs.mkdirSync(realRoot, { recursive: true });
    const realProjectId = assertGroveProjectId(createProjectId());
    registerProjectInGrove(servedGrove.id, { projectId: realProjectId, projectName: 'Real', projectRoot: realRoot }, home);

    const hostedProjectId = assertGroveProjectId(createProjectId());
    maybeRegisterHostedProjectOnIngest({
      method: 'POST', pathname: COLLECT_ROUTE, headers: headers(servedGrove.id, hostedProjectId),
      servedGroveId: servedGrove.id, mycoHome: home,
    });

    const hosted = listHostedProjects(servedGrove.id, home);
    expect(hosted.map((p) => p.project_id)).toEqual([hostedProjectId]);
    expect(countHostedProjects(servedGrove.id, home)).toBe(1);
    expect(isHostedProjectRoot(realRoot, servedGrove.id, home)).toBe(false);
  });

  // -- (11) prune: delete-only-if-empty, past-TTL ----------------------------

  describe('pruneHostedProjects (AC #11)', () => {
    let cache: GroveRuntimeCache;
    let db: Database;

    beforeEach(() => {
      cache = new GroveRuntimeCache();
      db = cache.getDatabase(resolveGroveDbPath(servedGrove.id, home)); // opens + creates schema
    });
    afterEach(() => {
      cache.closeAll();
    });

    function registerHosted(): string {
      const projectId = assertGroveProjectId(createProjectId());
      maybeRegisterHostedProjectOnIngest({
        method: 'POST', pathname: COLLECT_ROUTE, headers: headers(servedGrove.id, projectId),
        servedGroveId: servedGrove.id, mycoHome: home,
      });
      return projectId;
    }

    function insertSession(projectId: string): void {
      db.prepare(
        `INSERT INTO sessions (id, agent, project_id, started_at, created_at) VALUES (?, 'claude', ?, 0, 0)`,
      ).run(`sess_${projectId}`, projectId);
    }

    test('an empty past-TTL row is pruned; a row with one session survives; a young row survives', () => {
      const empty = registerHosted();
      const referenced = registerHosted();
      insertSession(referenced);

      // Far-future clock → both rows are past TTL.
      const farFuture = () => Date.now() + HOSTED_PROJECT_PRUNE_TTL_MS + 60_000;
      const res = pruneHostedProjects({ servedGroveId: servedGrove.id, db, mycoHome: home, now: farFuture });

      expect(res.pruned).toBe(1);
      expect(res.kept).toBe(1);
      expect(getRegisteredProjectInGrove(servedGrove.id, empty, home)).toBeNull();
      expect(getRegisteredProjectInGrove(servedGrove.id, referenced, home)).not.toBeNull();
    });

    test('a young empty row is kept (TTL not yet elapsed)', () => {
      const young = registerHosted();
      const res = pruneHostedProjects({ servedGroveId: servedGrove.id, db, mycoHome: home });
      expect(res.pruned).toBe(0);
      expect(getRegisteredProjectInGrove(servedGrove.id, young, home)).not.toBeNull();
    });

    test('a normal (non-hosted, real-root) row is never a prune candidate', () => {
      const realRoot = path.join(home, 'real-project');
      fs.mkdirSync(realRoot, { recursive: true });
      const realProjectId = assertGroveProjectId(createProjectId());
      registerProjectInGrove(servedGrove.id, { projectId: realProjectId, projectName: 'Real', projectRoot: realRoot }, home);

      const farFuture = () => Date.now() + HOSTED_PROJECT_PRUNE_TTL_MS + 60_000;
      const res = pruneHostedProjects({ servedGroveId: servedGrove.id, db, mycoHome: home, now: farFuture });
      expect(res.pruned).toBe(0);
      expect(getRegisteredProjectInGrove(servedGrove.id, realProjectId, home)).not.toBeNull();
    });
  });
});
