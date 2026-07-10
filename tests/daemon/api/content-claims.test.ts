/**
 * Content claim system daemon API handlers — real store, real rows, no
 * transport: seeds skill/OKF-page rows directly through their own query
 * modules and asserts the HTTP envelopes the handlers return.
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSkillRecord, updateSkillRecord, deleteSkillRecordCascade } from '@myco/db/queries/skill-records.js';
import { insertOkfPage } from '@myco/db/queries/okf.js';
import { getContentPublication, upsertContentPublication } from '@myco/db/queries/content-claims.js';
import { projectScope, type GroveProjectId } from '@myco/grove/ids.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import type { RequestPrincipal } from '@myco/daemon/request-principal.js';
import {
  handleContentClaimsList,
  handleContentClaimCreate,
  handleContentClaimRefresh,
  handleContentClaimRelease,
  handleContentClaimPublished,
} from '@myco/daemon/api/content-claims.js';

const PROJECT_ID = 'proj_cccccccccccccccccccccccccccccccc';
const epochNow = () => Math.floor(Date.now() / 1000);

function principal(machineId = 'machine-a'): RequestPrincipal {
  return {
    identity: { machineId, userId: null },
    tenancy: {
      projectVaultDir: '/tmp/does-not-matter',
      projectId: PROJECT_ID,
      groveId: 'grove_dddddddddddddddddddddddddddddddd',
    },
  } as RequestPrincipal;
}

function req(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { params: {}, query: {}, body: undefined, pathname: '/api/content-claims', ...overrides } as RouteRequest;
}

function seedSkill(id: string, overrides: { generation?: number; name?: string } = {}): void {
  const now = epochNow();
  insertSkillRecord({
    id,
    project_id: PROJECT_ID,
    agent_id: 'agent-test',
    name: overrides.name ?? id,
    display_name: overrides.name ?? id,
    description: 'A test skill',
    path: `.myco/skills/${overrides.name ?? id}.md`,
    generation: overrides.generation ?? 1,
    created_at: now,
    updated_at: now,
  });
}

function seedOkfPage(id: string, overrides: { generation?: number; path?: string } = {}): void {
  const now = epochNow();
  insertOkfPage({
    id,
    project_id: PROJECT_ID,
    machine_id: 'machine-a',
    path: overrides.path ?? `concepts/${id}`,
    type: 'concept',
    title: id,
    description: '',
    tags: '[]',
    status: 'active',
    generation: overrides.generation ?? 1,
    created_at: now,
    updated_at: now,
  });
}

describe('content claim daemon API', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: 'agent-test', name: 'Test Agent', created_at: epochNow() });
  });

  // ---------------------------------------------------------------------------
  // GET /api/content-claims — claimable inventory
  // ---------------------------------------------------------------------------

  describe('handleContentClaimsList', () => {
    it('lists never-published skills and pages as claimable', async () => {
      seedSkill('skill-1');
      seedOkfPage('page-1');

      const res = await handleContentClaimsList(req(), principal());
      expect(res.status).toBe(200);
      const body = res.body as { claimable: Array<Record<string, unknown>>; active_claims: unknown[] };
      expect(body.claimable).toHaveLength(2);
      const skillEntry = body.claimable.find((c) => c.artifact_kind === 'skill');
      expect(skillEntry).toMatchObject({ artifact_id: 'skill-1', lineage_generation: 1, published_generation: null, active_claim: null });
      const pageEntry = body.claimable.find((c) => c.artifact_kind === 'okf_page');
      expect(pageEntry).toMatchObject({ artifact_id: 'page-1', lineage_generation: 1, published_generation: null, active_claim: null });
      expect(body.active_claims).toHaveLength(0);
    });

    it('excludes an artifact once published at its current lineage-latest generation', async () => {
      seedSkill('skill-1');
      const created = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal(),
      );
      const claimId = (created.body as { claim: { id: string } }).claim.id;
      await handleContentClaimPublished(req({ params: { id: claimId } }), principal());

      const res = await handleContentClaimsList(req(), principal());
      const body = res.body as { claimable: Array<Record<string, unknown>> };
      expect(body.claimable).toHaveLength(0);
    });

    it('re-surfaces a published artifact once its generation advances (stale)', async () => {
      seedSkill('skill-1');
      const created = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal(),
      );
      const claimId = (created.body as { claim: { id: string } }).claim.id;
      await handleContentClaimPublished(req({ params: { id: claimId } }), principal());

      // The artifact evolves — lineage-latest is now 2, published_generation still 1.
      updateSkillRecord('skill-1', { generation: 2 }, projectScope(PROJECT_ID as GroveProjectId));

      const res = await handleContentClaimsList(req(), principal());
      const body = res.body as { claimable: Array<Record<string, unknown>> };
      expect(body.claimable).toHaveLength(1);
      expect(body.claimable[0]).toMatchObject({ artifact_id: 'skill-1', lineage_generation: 2, published_generation: 1 });
    });

    it('a skill seeded with a content_publications row (v69 migration backfill) is not claimable until its generation advances past the seed', async () => {
      // Mirrors what migrateV68ToV69 does for a pre-existing artifact: a
      // publication row exists at the CURRENT generation with no claim ever
      // having been taken — the migration seed, not a real mark-published call.
      seedSkill('skill-1', { generation: 4 });
      upsertContentPublication({
        artifact_kind: 'skill',
        artifact_id: 'skill-1',
        published_generation: 4,
        published_at: epochNow(),
        published_by: 'local',
        machine_id: 'local',
      });

      const before = await handleContentClaimsList(req(), principal());
      expect((before.body as { claimable: unknown[] }).claimable).toHaveLength(0);

      updateSkillRecord('skill-1', { generation: 5 }, projectScope(PROJECT_ID as GroveProjectId));

      const after = await handleContentClaimsList(req(), principal());
      const body = after.body as { claimable: Array<Record<string, unknown>> };
      expect(body.claimable).toHaveLength(1);
      expect(body.claimable[0]).toMatchObject({ artifact_id: 'skill-1', lineage_generation: 5, published_generation: 4 });
    });

    it('surfaces an active claim on a claimable artifact, with staleness computed against lineage-latest', async () => {
      seedSkill('skill-1');
      await handleContentClaimCreate(req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }), principal('machine-a'));
      updateSkillRecord('skill-1', { generation: 3 }, projectScope(PROJECT_ID as GroveProjectId));

      const res = await handleContentClaimsList(req(), principal());
      const body = res.body as { claimable: Array<{ active_claim: Record<string, unknown> | null }>; active_claims: Array<Record<string, unknown>> };
      expect(body.claimable[0].active_claim).toMatchObject({ claimed_by: 'machine-a', generation: 1, stale: true });
      expect(body.active_claims).toHaveLength(1);
      expect(body.active_claims[0]).toMatchObject({ claimed_by: 'machine-a', stale: true });
    });

    it('surfaces a published-at-latest artifact in `published` with active_claim populated, and excludes it from `claimable`', async () => {
      seedSkill('skill-1');
      const created = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal('machine-a'),
      );
      const claimId = (created.body as { claim: { id: string } }).claim.id;
      await handleContentClaimPublished(req({ params: { id: claimId } }), principal('machine-a'));

      // The first claim is now `published`, not `active` — a second claim on
      // the still-published artifact (same generation) is free to succeed.
      await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal('machine-b'),
      );

      const res = await handleContentClaimsList(req(), principal());
      const body = res.body as {
        ok: boolean;
        claimable: unknown[];
        published: Array<Record<string, unknown>>;
        active_claims: unknown[];
      };
      expect(Object.keys(body).sort()).toEqual(['active_claims', 'claimable', 'ok', 'published']);
      expect(body.claimable).toHaveLength(0);
      expect(body.published).toHaveLength(1);
      expect(body.published[0]).toMatchObject({
        artifact_kind: 'skill',
        artifact_id: 'skill-1',
        name: 'skill-1',
        label: 'skill-1',
        published_generation: 1,
        lineage_generation: 1,
      });
      expect(body.published[0].active_claim).toMatchObject({ claimed_by: 'machine-b', state: 'active', stale: false });
    });

    it('a stale-published artifact appears in `claimable` only, with the pre-existing claimable shape unchanged', async () => {
      seedSkill('skill-1');
      const created = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal('machine-a'),
      );
      const claimId = (created.body as { claim: { id: string } }).claim.id;
      await handleContentClaimPublished(req({ params: { id: claimId } }), principal('machine-a'));
      updateSkillRecord('skill-1', { generation: 2 }, projectScope(PROJECT_ID as GroveProjectId));

      const res = await handleContentClaimsList(req(), principal());
      const body = res.body as { claimable: Array<Record<string, unknown>>; published: unknown[] };
      expect(body.published).toHaveLength(0);
      expect(body.claimable).toHaveLength(1);
      expect(body.claimable[0]).toEqual({
        artifact_kind: 'skill',
        artifact_id: 'skill-1',
        label: 'skill-1',
        lineage_generation: 2,
        published_generation: 1,
        active_claim: null,
      });
    });

    it('a published-at-latest okf_page emits no `published` entry (skills-only)', async () => {
      seedOkfPage('page-1');
      upsertContentPublication({
        artifact_kind: 'okf_page',
        artifact_id: 'page-1',
        published_generation: 1,
        published_at: epochNow(),
        published_by: 'machine-a',
        machine_id: 'machine-a',
      });

      const res = await handleContentClaimsList(req(), principal());
      const body = res.body as { claimable: unknown[]; published: unknown[] };
      expect(body.published).toHaveLength(0);
      expect(body.claimable).toHaveLength(0);
    });

    it('a publication row whose skill record was deleted emits no `published` entry (orphan)', async () => {
      seedSkill('skill-1');
      const created = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal('machine-a'),
      );
      const claimId = (created.body as { claim: { id: string } }).claim.id;
      await handleContentClaimPublished(req({ params: { id: claimId } }), principal('machine-a'));

      deleteSkillRecordCascade('skill-1', projectScope(PROJECT_ID as GroveProjectId));

      const res = await handleContentClaimsList(req(), principal());
      const body = res.body as { claimable: unknown[]; published: unknown[] };
      expect(body.published).toHaveLength(0);
      expect(body.claimable).toHaveLength(0);
      // The durable publication marker survives the delete — proves the join
      // iterates scoped skill records, not `listContentPublications()`.
      expect(getContentPublication('skill', 'skill-1')).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/content-claims — constraint-based claim
  // ---------------------------------------------------------------------------

  describe('handleContentClaimCreate', () => {
    it('claims a skill at its current lineage-latest generation -> 201', async () => {
      seedSkill('skill-1', { generation: 4 });
      const res = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal('machine-a'),
      );
      expect(res.status).toBe(201);
      const body = res.body as { claim: Record<string, unknown>; content: Record<string, unknown> };
      expect(body.claim).toMatchObject({ artifact_kind: 'skill', artifact_id: 'skill-1', generation: 4, claimed_by: 'machine-a', state: 'active', stale: false });
      expect(body.content).toMatchObject({ artifact_kind: 'skill', artifact_id: 'skill-1', generation: 4 });
    });

    it('claims an OKF page at its current lineage-latest generation -> 201', async () => {
      seedOkfPage('page-1', { generation: 2 });
      const res = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'okf_page', artifact_id: 'page-1' } }),
        principal('machine-a'),
      );
      expect(res.status).toBe(201);
      expect((res.body as { claim: { generation: number } }).claim.generation).toBe(2);
    });

    it('a second claim while active -> 409 already_claimed with holder identity', async () => {
      seedSkill('skill-1');
      await handleContentClaimCreate(req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }), principal('machine-a'));
      const res = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal('machine-b'),
      );
      expect(res.status).toBe(409);
      const body = res.body as { error: { code: string }; holder: { claimed_by: string } };
      expect(body.error.code).toBe('already_claimed');
      expect(body.holder.claimed_by).toBe('machine-a');
    });

    it('404 artifact_not_found for an unknown artifact id', async () => {
      const res = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'nope' } }),
        principal(),
      );
      expect(res.status).toBe(404);
      expect((res.body as { error: { code: string } }).error.code).toBe('artifact_not_found');
    });

    it('400 invalid_request for a missing/invalid artifact_kind', async () => {
      const missing = await handleContentClaimCreate(req({ body: { artifact_id: 'skill-1' } }), principal());
      expect(missing.status).toBe(400);
      const bad = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'not-a-kind', artifact_id: 'skill-1' } }),
        principal(),
      );
      expect(bad.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/content-claims/:id/refresh
  // ---------------------------------------------------------------------------

  describe('handleContentClaimRefresh', () => {
    async function claimSkill(id: string, machineId = 'machine-a') {
      seedSkill(id);
      const res = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: id } }),
        principal(machineId),
      );
      return (res.body as { claim: { id: string } }).claim.id;
    }

    it('holder refresh bumps generation to current lineage-latest', async () => {
      const claimId = await claimSkill('skill-1');
      updateSkillRecord('skill-1', { generation: 7 }, projectScope(PROJECT_ID as GroveProjectId));

      const res = await handleContentClaimRefresh(req({ params: { id: claimId } }), principal('machine-a'));
      expect(res.status).toBe(200);
      const body = res.body as { claim: { generation: number; stale: boolean } };
      expect(body.claim.generation).toBe(7);
      expect(body.claim.stale).toBe(false);
    });

    it('refresh only mutates the holder claim row, leaving a sibling claim untouched', async () => {
      const claimA = await claimSkill('skill-a', 'machine-a');
      const claimB = await claimSkill('skill-b', 'machine-b');
      updateSkillRecord('skill-a', { generation: 9 }, projectScope(PROJECT_ID as GroveProjectId));

      await handleContentClaimRefresh(req({ params: { id: claimA } }), principal('machine-a'));

      const listRes = await handleContentClaimsList(req(), principal());
      const active = (listRes.body as { active_claims: Array<{ id: string; generation: number }> }).active_claims;
      expect(active.find((c) => c.id === claimA)?.generation).toBe(9);
      expect(active.find((c) => c.id === claimB)?.generation).toBe(1);
    });

    it('403 not_holder for a non-holder machine (cooperative check)', async () => {
      const claimId = await claimSkill('skill-1', 'machine-a');
      const res = await handleContentClaimRefresh(req({ params: { id: claimId } }), principal('machine-b'));
      expect(res.status).toBe(403);
      expect((res.body as { error: { code: string } }).error.code).toBe('not_holder');
    });

    it('409 claim_not_active once released', async () => {
      const claimId = await claimSkill('skill-1');
      await handleContentClaimRelease(req({ params: { id: claimId } }), principal('machine-a'));
      const res = await handleContentClaimRefresh(req({ params: { id: claimId } }), principal('machine-a'));
      expect(res.status).toBe(409);
      expect((res.body as { error: { code: string } }).error.code).toBe('claim_not_active');
    });

    it('404 claim_not_found for an unknown id', async () => {
      const res = await handleContentClaimRefresh(req({ params: { id: 'cclaim_doesnotexist' } }), principal());
      expect(res.status).toBe(404);
      expect((res.body as { error: { code: string } }).error.code).toBe('claim_not_found');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/content-claims/:id/release
  // ---------------------------------------------------------------------------

  describe('handleContentClaimRelease', () => {
    it('holder release -> released, frees the artifact for a new claim', async () => {
      seedSkill('skill-1');
      const created = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal('machine-a'),
      );
      const claimId = (created.body as { claim: { id: string } }).claim.id;

      const res = await handleContentClaimRelease(req({ params: { id: claimId } }), principal('machine-a'));
      expect(res.status).toBe(200);
      expect((res.body as { claim: { state: string } }).claim.state).toBe('released');

      const reclaim = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal('machine-b'),
      );
      expect(reclaim.status).toBe(201);
    });

    it('403 not_holder for a non-holder machine', async () => {
      seedSkill('skill-1');
      const created = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal('machine-a'),
      );
      const claimId = (created.body as { claim: { id: string } }).claim.id;
      const res = await handleContentClaimRelease(req({ params: { id: claimId } }), principal('machine-b'));
      expect(res.status).toBe(403);
    });

    it('409 claim_not_active on a second release', async () => {
      seedSkill('skill-1');
      const created = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal('machine-a'),
      );
      const claimId = (created.body as { claim: { id: string } }).claim.id;
      await handleContentClaimRelease(req({ params: { id: claimId } }), principal('machine-a'));
      const res = await handleContentClaimRelease(req({ params: { id: claimId } }), principal('machine-a'));
      expect(res.status).toBe(409);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/content-claims/:id/published
  // ---------------------------------------------------------------------------

  describe('handleContentClaimPublished', () => {
    it('holder mark-published transitions the claim AND upserts content_publications', async () => {
      seedSkill('skill-1', { generation: 3 });
      const created = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal('machine-a'),
      );
      const claimId = (created.body as { claim: { id: string } }).claim.id;

      const res = await handleContentClaimPublished(req({ params: { id: claimId } }), principal('machine-a'));
      expect(res.status).toBe(200);
      const body = res.body as { claim: { state: string }; publication: Record<string, unknown> };
      expect(body.claim.state).toBe('published');
      expect(body.publication).toMatchObject({ artifact_kind: 'skill', artifact_id: 'skill-1', published_generation: 3, published_by: 'machine-a' });

      const marker = getContentPublication('skill', 'skill-1');
      expect(marker?.published_generation).toBe(3);
    });

    it('403 not_holder for a non-holder machine', async () => {
      seedSkill('skill-1');
      const created = await handleContentClaimCreate(
        req({ body: { artifact_kind: 'skill', artifact_id: 'skill-1' } }),
        principal('machine-a'),
      );
      const claimId = (created.body as { claim: { id: string } }).claim.id;
      const res = await handleContentClaimPublished(req({ params: { id: claimId } }), principal('machine-b'));
      expect(res.status).toBe(403);
      expect(getContentPublication('skill', 'skill-1')).toBeNull();
    });
  });
});
