/**
 * Fix B: the skill-candidate / skill-record READ + candidate-mutate routes are
 * wrapped in `tenantRoute`, the same gate the skill-record DELETE already uses.
 *
 *   GET    /api/skill-candidates
 *   GET    /api/skill-candidates/:id
 *   PUT    /api/skill-candidates/:id
 *   GET    /api/skill-records
 *   GET    /api/skill-records/:id
 *   DELETE /api/skill-candidates/:id
 *
 * Pins two halves of the contract:
 *   1. A synthesized/anchor-fallback context is rejected with 400 +
 *      `tenancy.violation` before the handler runs.
 *   2. With a caller-supplied (authorized) context for project B, the read is
 *      scoped to B's rows — never the anchor's.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertCandidate } from '@myco/db/queries/skill-candidates.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import {
  handleListCandidates,
  handleGetCandidate,
  handleListSkillRecords,
  handleGetSkillRecord,
  handleDeleteCandidate,
} from '@myco/daemon/api/skills.js';
import { tenantRoute } from '@myco/daemon/api/route-helpers.js';
import type { RequestPrincipal } from '@myco/daemon/request-principal.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import type { GroveProjectId } from '@myco/grove/ids.js';

const PROJECT_ANCHOR = 'proj_aaaa1111aaaa1111aaaa1111aaaa1111' as GroveProjectId;
const PROJECT_B = 'proj_bbbb2222bbbb2222bbbb2222bbbb2222' as GroveProjectId;
const GROVE_B = 'grove_bbbb2222bbbb2222bbbb2222bbbb2222';

function principalB(): RequestPrincipal {
  return {
    identity: { machineId: 'machine-a', userId: null },
    tenancy: {
      projectVaultDir: '/tenants/b/.myco' as RequestPrincipal['tenancy']['projectVaultDir'],
      projectId: PROJECT_B,
      groveId: GROVE_B,
      requestContext: {
        projectVaultDir: '/tenants/b/.myco',
        projectId: PROJECT_B,
        groveId: GROVE_B,
      },
    },
  };
}

function callerContextB(): RouteRequest['requestContext'] {
  return {
    projectRoot: '/tenants/b',
    callerRoot: null,
    projectId: PROJECT_B,
    groveId: GROVE_B,
    machineId: 'machine-a',
    sessionId: null,
    projectVaultDir: '/tenants/b/.myco',
    databasePath: '/tenants/b/.myco/vault.db',
    source: 'headers',
    tenancySource: 'caller',
  } as unknown as RouteRequest['requestContext'];
}

function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    requestContext: callerContextB(),
    pathname: '/api/skill-candidates',
    ...overrides,
  } as RouteRequest;
}

function recordingLogger(kinds: string[]) {
  return {
    info: () => {},
    warn: (kind: string) => { kinds.push(kind); },
    error: () => {},
    debug: () => {},
  } as never;
}

const now = () => Math.floor(Date.now() / 1000);

function seedCandidate(projectId: GroveProjectId, id: string, topic: string): void {
  insertCandidate({
    id,
    project_id: projectId,
    agent_id: 'agent-test',
    topic,
    rationale: 'r',
    created_at: now(),
    updated_at: now(),
  });
}

function seedRecord(projectId: GroveProjectId, id: string, name: string): void {
  insertSkillRecord({
    id,
    project_id: projectId,
    agent_id: 'agent-test',
    name,
    display_name: name,
    description: 'd',
    path: `.agents/skills/${name}/SKILL.md`,
    created_at: now(),
    updated_at: now(),
  });
}

describe('skill read/mutate routes — tenant-scoped via tenantRoute', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: 'agent-test', name: 'Agent Test', created_at: 10 });
  });

  describe('synthesized context is rejected (400 + tenancy.violation)', () => {
    const synthesized = {
      ...callerContextB(),
      tenancySource: 'synthesized',
    } as unknown as RouteRequest['requestContext'];

    const cases: Array<{ name: string; handler: Parameters<typeof tenantRoute>[1]; pathname: string }> = [
      { name: 'GET /api/skill-candidates', handler: handleListCandidates, pathname: '/api/skill-candidates' },
      { name: 'GET /api/skill-candidates/:id', handler: handleGetCandidate, pathname: '/api/skill-candidates/x' },
      { name: 'GET /api/skill-records', handler: handleListSkillRecords, pathname: '/api/skill-records' },
      { name: 'GET /api/skill-records/:id', handler: handleGetSkillRecord, pathname: '/api/skill-records/x' },
      { name: 'DELETE /api/skill-candidates/:id', handler: handleDeleteCandidate, pathname: '/api/skill-candidates/x' },
    ];

    for (const { name, handler, pathname } of cases) {
      it(`${name} rejects synthesized with 400 + tenancy.violation`, async () => {
        const kinds: string[] = [];
        const wrapped = tenantRoute({ machineId: 'machine-a', logger: recordingLogger(kinds) }, handler);
        const res = await wrapped(makeReq({ requestContext: synthesized, pathname, params: { id: 'x' } }));
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: { code: 'tenancy-violation' } });
        expect(kinds).toContain('tenancy.violation');
      });
    }
  });

  describe('with caller context for project B, reads are scoped to B', () => {
    it('GET /api/skill-candidates returns only B candidates, never the anchor', async () => {
      seedCandidate(PROJECT_ANCHOR, 'cand-anchor', 'anchor topic');
      seedCandidate(PROJECT_B, 'cand-b', 'B topic');

      const res = await handleListCandidates(makeReq(), principalB());
      const body = res.body as { candidates: Array<{ id: string }>; total: number };
      const ids = body.candidates.map((c) => c.id);
      expect(ids).toEqual(['cand-b']);
      expect(body.total).toBe(1);
    });

    it('GET /api/skill-candidates/:id 404s for an anchor-owned candidate', async () => {
      seedCandidate(PROJECT_ANCHOR, 'cand-anchor', 'anchor topic');

      const res = await handleGetCandidate(
        makeReq({ params: { id: 'cand-anchor' } }),
        principalB(),
      );
      expect(res.status).toBe(404);
    });

    it('GET /api/skill-records returns only B records, never the anchor', async () => {
      seedRecord(PROJECT_ANCHOR, 'rec-anchor', 'anchor-skill');
      seedRecord(PROJECT_B, 'rec-b', 'b-skill');

      const res = await handleListSkillRecords(
        makeReq({ pathname: '/api/skill-records' }),
        principalB(),
      );
      const body = res.body as { records: Array<{ id: string }>; total: number };
      expect(body.records.map((r) => r.id)).toEqual(['rec-b']);
      expect(body.total).toBe(1);
    });

    it('GET /api/skill-records/:id 404s for an anchor-owned record', async () => {
      seedRecord(PROJECT_ANCHOR, 'rec-anchor', 'anchor-skill');

      const res = await handleGetSkillRecord(
        makeReq({ params: { id: 'rec-anchor' }, pathname: '/api/skill-records/rec-anchor' }),
        principalB(),
      );
      expect(res.status).toBe(404);
    });

    it('DELETE /api/skill-candidates/:id 404s for an anchor-owned candidate (never deletes it)', async () => {
      seedCandidate(PROJECT_ANCHOR, 'cand-anchor', 'anchor topic');

      const res = await handleDeleteCandidate(
        makeReq({ params: { id: 'cand-anchor' } }),
        principalB(),
      );
      expect(res.status).toBe(404);

      // The anchor's candidate survives — a B-scoped delete must never reach it.
      const stillThere = await handleGetCandidate(
        makeReq({ params: { id: 'cand-anchor' } }),
        { ...principalB(), tenancy: { ...principalB().tenancy, projectId: PROJECT_ANCHOR } } as RequestPrincipal,
      );
      expect(stillThere.status).toBe(200);
    });
  });
});
