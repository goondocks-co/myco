/**
 * Content claim materialize — member-side disk write (design §4). Covers the
 * LOCAL-project path (no Team Host attach at all): real Grove DB, real
 * skill/lineage/claim rows, real filesystem writes in a temp project root.
 * The ATTACHED-project (remote dial) path and the overlay-refusal proof live
 * in `tests/daemon/content-claims-materialize-overlay.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import {
  createContentClaimMaterializeHandler,
  materializeContentClaim,
  type ClaimSource,
} from '@myco/daemon/api/content-claims-materialize.js';
import type { ProxyLogger } from '@myco/daemon/host-proxy.js';
import { withDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import { insertLineage } from '@myco/db/queries/skill-lineage.js';
import {
  insertContentClaim,
  releaseContentClaim,
  getContentClaimById,
  getContentPublication,
  upsertContentPublication,
} from '@myco/db/queries/content-claims.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches } from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { assertGroveProjectId, createProjectId, projectScope, type GroveProjectId } from '@myco/grove/ids.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { CANONICAL_PROJECT_SKILLS_DIR } from '@myco/skills/publication.js';
import { testPerUserLockNamespace } from '../../helpers/per-user-lock-namespace.js';
import { acquireProjectLease } from '@myco/grove/project-lease.js';

const noopProxyLogger = { warn(): void {}, error(): void {} };
const epochNow = () => Math.floor(Date.now() / 1000);

function req(claimId: string, projectRoot: string, extra: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: { id: claimId },
    query: {},
    body: { project_root: projectRoot },
    pathname: `/api/content-claims/${claimId}/materialize`,
    ...extra,
  };
}

describe('content claim materialize — local project', () => {
  let tmp: string;
  let mycoHome: string;
  let projectRoot: string;
  let projectId: string;
  let groveId: string;
  let cache: GroveRuntimeCache;
  let savedHome: string | undefined;
  let savedMycoHome: string | undefined;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cclaim-mat-'));
    savedHome = process.env.HOME;
    savedMycoHome = process.env.MYCO_HOME;
    savedTeamHome = process.env.MYCO_TEAM_HOME;

    const fakeHome = path.join(tmp, 'user-home');
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome; // deterministic agent-symlink detection

    mycoHome = path.join(tmp, 'myco-home');
    fs.mkdirSync(mycoHome, { recursive: true });
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team-home'); // no host ever registered here
    clearGroveRegistryCaches();

    projectRoot = path.join(tmp, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });

    const grove = createGrove('Work', mycoHome);
    groveId = grove.id;
    ensureGroveDatabase(grove.id, mycoHome);

    projectId = assertGroveProjectId(createProjectId());
    registerProjectInGrove(grove.id, { projectId, projectName: 'Work project', projectRoot }, mycoHome);
    saveProjectManifest(resolveProjectVaultDir(projectRoot), { project: { id: projectId } });

    cache = new GroveRuntimeCache();
    const db = cache.getDatabase(resolveGroveDbPath(groveId, mycoHome));
    withDatabase(db, () => {
      registerAgent({ id: 'agent-test', name: 'Test Agent', created_at: epochNow() });
    });
  });

  afterEach(() => {
    cache.closeAll();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedMycoHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeamHome;
    clearGroveRegistryCaches();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function handler() {
    return createContentClaimMaterializeHandler({
      cache,
      dial: (() => { throw new Error('dial must not be called for a local (non-attached) project'); }) as never,
      logger: noopProxyLogger,
      machineId: 'daemon-machine',
      mycoHome,
      lockNamespace: testPerUserLockNamespace,
    });
  }

  function seed(opts: { name?: string; generation?: number; content?: string; claimedBy?: string } = {}) {
    const db = cache.getDatabase(resolveGroveDbPath(groveId, mycoHome));
    const name = opts.name ?? 'my-skill';
    const generation = opts.generation ?? 1;
    const content = opts.content ?? `# ${name}\n\nBody text.\n`;
    const skillId = `skill-${name}-${generation}`;
    const now = epochNow();
    let claimId = '';
    withDatabase(db, () => {
      insertSkillRecord({
        id: skillId,
        project_id: projectId,
        agent_id: 'agent-test',
        name,
        display_name: name,
        description: 'A test skill',
        path: `.agents/skills/${name}/SKILL.md`,
        generation,
        created_at: now,
        updated_at: now,
      });
      insertLineage({
        id: `lin-${skillId}`,
        project_id: projectId,
        skill_id: skillId,
        generation,
        action: 'create',
        rationale: 'test',
        content_snapshot: content,
        created_at: now,
      });
      const result = insertContentClaim({
        artifactKind: 'skill',
        artifactId: skillId,
        generation,
        projectId,
        claimedBy: opts.claimedBy ?? 'machine-a',
        claimedAt: now,
        expiresAt: now + 3600,
        machineId: opts.claimedBy ?? 'machine-a',
      });
      if (!result.ok) throw new Error('test setup: unexpected already_claimed conflict');
      claimId = result.row.id;
    });
    return { skillId, claimId, name, content, generation };
  }

  /**
   * Seeds a claim row for a residue-tolerance test: a pre-retirement
   * `okf_page` claim, with no backing artifact — the materialize route no
   * longer knows the kind at all, so it never reaches a content lookup.
   * `artifactKind` is cast past its now-narrowed compile-time type; this
   * simulates a row that survived from before the retirement.
   */
  function seedUnsupportedKindClaim(opts: { claimedBy?: string } = {}) {
    const db = cache.getDatabase(resolveGroveDbPath(groveId, mycoHome));
    const now = epochNow();
    let claimId = '';
    withDatabase(db, () => {
      const result = insertContentClaim({
        artifactKind: 'okf_page' as unknown as 'skill',
        artifactId: 'page-legacy',
        generation: 1,
        projectId,
        claimedBy: opts.claimedBy ?? 'machine-a',
        claimedAt: now,
        expiresAt: now + 3600,
        machineId: opts.claimedBy ?? 'machine-a',
      });
      if (!result.ok) throw new Error('test setup: unexpected already_claimed conflict');
      claimId = result.row.id;
    });
    return { claimId };
  }

  test('materialize writes the SKILL.md and syncs agent symlinks at the member project root', async () => {
    fs.mkdirSync(path.join(process.env.HOME!, '.claude'), { recursive: true }); // detect claude-code as installed
    const { claimId, name, content } = seed();

    const res = await handler()(req(claimId, projectRoot));
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; path: string; skill_name: string; generation: number; auto_published: boolean };
    expect(body).toMatchObject({ ok: true, skill_name: name, generation: 1, auto_published: false });

    const writtenPath = path.join(projectRoot, CANONICAL_PROJECT_SKILLS_DIR, name, 'SKILL.md');
    expect(fs.readFileSync(writtenPath, 'utf-8')).toBe(content);

    const linkPath = path.join(projectRoot, '.claude', 'skills', name);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);

    // First-time publish (no prior content_publications row): the manual
    // Mark-published flow owns this, not the republish auto-close — the
    // claim stays active.
    const claimRow = withDatabase(cache.getDatabase(resolveGroveDbPath(groveId, mycoHome)), () =>
      getContentClaimById(claimId, projectScope(projectId as GroveProjectId)));
    expect(claimRow?.state).toBe('active');
  });

  test('a same-generation republish (claim generation matches the recorded publication) auto-closes the claim', async () => {
    const { claimId, skillId, name, content } = seed({ generation: 1, claimedBy: 'machine-a' });
    const db = cache.getDatabase(resolveGroveDbPath(groveId, mycoHome));
    const priorPublishedAt = epochNow() - 3600;
    withDatabase(db, () => {
      upsertContentPublication({
        artifact_kind: 'skill',
        artifact_id: skillId,
        published_generation: 1,
        published_at: priorPublishedAt,
        published_by: 'machine-a',
        machine_id: 'machine-a',
      });
    });

    const res = await handler()(req(claimId, projectRoot));
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; skill_name: string; generation: number; auto_published: boolean };
    expect(body).toMatchObject({ ok: true, skill_name: name, generation: 1, auto_published: true });

    // The republished content still lands on disk exactly as a normal
    // materialize would — auto-close never substitutes for the write.
    const writtenPath = path.join(projectRoot, CANONICAL_PROJECT_SKILLS_DIR, name, 'SKILL.md');
    expect(fs.readFileSync(writtenPath, 'utf-8')).toBe(content);

    const claimRow = withDatabase(db, () => getContentClaimById(claimId, projectScope(projectId as GroveProjectId)));
    expect(claimRow?.state).toBe('published');

    const publication = withDatabase(db, () => getContentPublication('skill', skillId));
    expect(publication?.published_generation).toBe(1);
    expect(publication?.published_at).toBeGreaterThan(priorPublishedAt);
  });

  test('a different-generation materialize (content evolved since the last publish) leaves the claim active, auto_published false', async () => {
    const { claimId, skillId, generation: claimGeneration } = seed({ generation: 2 });
    expect(claimGeneration).toBe(2);
    const db = cache.getDatabase(resolveGroveDbPath(groveId, mycoHome));
    withDatabase(db, () => {
      upsertContentPublication({
        artifact_kind: 'skill',
        artifact_id: skillId,
        published_generation: 1, // an OLDER generation than the claim being materialized now
        published_at: epochNow() - 3600,
        published_by: 'machine-a',
        machine_id: 'machine-a',
      });
    });

    const res = await handler()(req(claimId, projectRoot));
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; generation: number; auto_published: boolean };
    expect(body).toMatchObject({ ok: true, generation: 2, auto_published: false });

    const claimRow = withDatabase(db, () => getContentClaimById(claimId, projectScope(projectId as GroveProjectId)));
    expect(claimRow?.state).toBe('active');

    const publication = withDatabase(db, () => getContentPublication('skill', skillId));
    expect(publication?.published_generation).toBe(1); // unchanged — the manual flow owns this generation
  });

  test('a released (no longer active) claim -> 409 claim_not_active, nothing written', async () => {
    const { claimId, name } = seed();
    const db = cache.getDatabase(resolveGroveDbPath(groveId, mycoHome));
    withDatabase(db, () => { releaseContentClaim(claimId, epochNow()); });

    const res = await handler()(req(claimId, projectRoot));
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('claim_not_active');
    expect(fs.existsSync(path.join(projectRoot, CANONICAL_PROJECT_SKILLS_DIR, name))).toBe(false);
  });

  test('an unknown claim id -> 409 claim_not_active, nothing written', async () => {
    const res = await handler()(req('cclaim_does_not_exist', projectRoot));
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('claim_not_active');
  });

  // --- Project write admission -------------------------------------------
  // This route resolves its project from the BODY (`project_root` →
  // resolveMemberProjectContext), not from the request path, so
  // requestContext.projectId does not identify it and the central
  // per-project HTTP write gate never fires here. The consult sits in the
  // handler, ahead of the local/attached branch.

  test('a held project write lease -> 409 project_paused, nothing written', async () => {
    const { claimId, name } = seed();
    acquireProjectLease(projectId, 'residency-detach', 'leaving the team', null, mycoHome, testPerUserLockNamespace);

    const res = await handler()(req(claimId, projectRoot));

    expect(res.status).toBe(409);
    const body = res.body as { error: { code: string }; paused: { owner_op: string } };
    expect(body.error.code).toBe('project_paused');
    expect(body.paused.owner_op).toBe('residency-detach');
    expect(fs.existsSync(path.join(projectRoot, CANONICAL_PROJECT_SKILLS_DIR, name))).toBe(false);
    // The claim is untouched — a refused materialize is not a consumed claim.
    const db = cache.getDatabase(resolveGroveDbPath(groveId, mycoHome));
    withDatabase(db, () => {
      expect(getContentClaimById(claimId, projectScope(projectId as GroveProjectId))!.state).toBe('active');
    });
  });

  test('an unreadable lease record -> 409, never treated as unheld', async () => {
    const { claimId, name } = seed();
    const leasePath = path.join(mycoHome, 'leases', `${projectId}.json`);
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, '{ torn', 'utf-8');

    const res = await handler()(req(claimId, projectRoot));

    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('project_paused');
    expect(fs.existsSync(path.join(projectRoot, CANONICAL_PROJECT_SKILLS_DIR, name))).toBe(false);
  });

  test('current project root does not match the registered root -> loud root_mismatch, nothing written', async () => {
    const { claimId, name } = seed();
    const movedRoot = path.join(tmp, 'moved-checkout');
    fs.mkdirSync(movedRoot, { recursive: true });
    saveProjectManifest(resolveProjectVaultDir(movedRoot), { project: { id: projectId } });

    const res = await handler()(req(claimId, movedRoot));
    expect(res.status).toBe(409);
    const body = res.body as { error: { code: string }; registered_root: string; current_root: string };
    expect(body.error.code).toBe('root_mismatch');
    expect(body.registered_root).toBe(projectRoot);
    expect(body.current_root).toBe(path.resolve(movedRoot));
    expect(fs.existsSync(path.join(movedRoot, CANONICAL_PROJECT_SKILLS_DIR, name))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, CANONICAL_PROJECT_SKILLS_DIR, name))).toBe(false);
  });

  test('a host-served request context never reaches the writers', async () => {
    const { claimId, name } = seed();
    const res = await handler()(req(claimId, projectRoot, { requestContext: { hostServed: true } as never }));
    expect(res.status).toBe(404);
    expect(fs.existsSync(path.join(projectRoot, CANONICAL_PROJECT_SKILLS_DIR, name))).toBe(false);
  });

  test('residue tolerance: a claim of a retired kind (okf_page) -> 400 unsupported_artifact_kind, nothing written', async () => {
    const { claimId } = seedUnsupportedKindClaim();

    const res = await handler()(req(claimId, projectRoot));
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('unsupported_artifact_kind');

    // Nothing was written anywhere a skill materialize could plausibly land,
    // and the claim itself is untouched — still readable/releasable by the
    // rest of the claim system (covered in `content-claims.test.ts`).
    expect(fs.existsSync(path.join(projectRoot, CANONICAL_PROJECT_SKILLS_DIR))).toBe(false);
    const claimRow = withDatabase(cache.getDatabase(resolveGroveDbPath(groveId, mycoHome)), () =>
      getContentClaimById(claimId, projectScope(projectId as GroveProjectId)));
    expect(claimRow?.state).toBe('active');
  });
});

/** The re-assert race tests below never reach a successful write, so the
 *  post-write auto-close check never runs — these stubs prove it by throwing
 *  if the orchestration ever calls them in those tests. */
async function unusedGetPublishedGeneration(): Promise<never> {
  throw new Error('getPublishedGeneration must not be called when the write never lands');
}
async function unusedMarkPublished(): Promise<never> {
  throw new Error('markPublished must not be called when the write never lands');
}

describe('materializeContentClaim orchestration — the re-assert race', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cclaim-mat-race-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the claim expires between the initial fetch and the pre-write re-assert -> no write', async () => {
    let calls = 0;
    const source: ClaimSource = {
      async getActiveClaim(id) {
        calls += 1;
        // First call (the initial "what to fetch" read) finds it active;
        // the second call (immediately before the write) finds it gone —
        // simulating expiry/release/reassignment landing in between.
        if (calls === 1) return { id, artifactKind: 'skill', artifactId: 'skill-race', generation: 1 };
        return null;
      },
      async getSkillContent() {
        return { name: 'race-skill', content: '# race\n' };
      },
      getPublishedGeneration: unusedGetPublishedGeneration,
      markPublished: unusedMarkPublished,
    };

    const outcome = await materializeContentClaim('cclaim_race', tmp, source, noopProxyLogger);
    expect(outcome).toEqual({ ok: false, code: 'claim_no_longer_active' });
    expect(calls).toBe(2);
    expect(fs.existsSync(path.join(tmp, CANONICAL_PROJECT_SKILLS_DIR, 'race-skill'))).toBe(false);
  });

  test('a stale (already non-active) claim never reaches the content fetch', async () => {
    let contentFetched = false;
    const source: ClaimSource = {
      async getActiveClaim() { return null; },
      async getSkillContent() { contentFetched = true; return { name: 'x', content: 'x' }; },
      getPublishedGeneration: unusedGetPublishedGeneration,
      markPublished: unusedMarkPublished,
    };

    const outcome = await materializeContentClaim('cclaim_stale', tmp, source, noopProxyLogger);
    expect(outcome).toEqual({ ok: false, code: 'claim_not_active' });
    expect(contentFetched).toBe(false);
  });

  test('the host is unreachable on the FIRST check -> distinct host_unreachable, not the misleading claim_not_active', async () => {
    // A source that can distinguish "host down" from "claim genuinely not
    // active" (Task C-6 item 2) — mirrors what `remoteClaimSource` reports
    // via `wasLastActiveClaimCheckHostUnreachable` after a transport
    // failure on `dialHostJson`.
    let contentFetched = false;
    const source: ClaimSource = {
      async getActiveClaim() { return null; },
      wasLastActiveClaimCheckHostUnreachable() { return true; },
      async getSkillContent() { contentFetched = true; return { name: 'x', content: 'x' }; },
      getPublishedGeneration: unusedGetPublishedGeneration,
      markPublished: unusedMarkPublished,
    };

    const outcome = await materializeContentClaim('cclaim_host_down', tmp, source, noopProxyLogger);
    expect(outcome).toEqual({ ok: false, code: 'host_unreachable' });
    expect(contentFetched).toBe(false);
  });

  test('a source with no wasLastActiveClaimCheckHostUnreachable (the LOCAL source contract) still reports claim_not_active, never host_unreachable', async () => {
    // The optional method is absent entirely — the LOCAL source never has a
    // network failure mode. `source.wasLastActiveClaimCheckHostUnreachable?.()`
    // must degrade to falsy, not throw.
    const source: ClaimSource = {
      async getActiveClaim() { return null; },
      async getSkillContent() { return { name: 'x', content: 'x' }; },
      getPublishedGeneration: unusedGetPublishedGeneration,
      markPublished: unusedMarkPublished,
    };

    const outcome = await materializeContentClaim('cclaim_no_seam', tmp, source, noopProxyLogger);
    expect(outcome).toEqual({ ok: false, code: 'claim_not_active' });
  });

  test('a claim of a retired kind (okf_page) never reaches the content fetch', async () => {
    let contentFetched = false;
    const source: ClaimSource = {
      async getActiveClaim(id) {
        return { id, artifactKind: 'okf_page', artifactId: 'page-race', generation: 1 };
      },
      getSkillContent: async () => { contentFetched = true; return { name: 'x', content: 'x' }; },
      getPublishedGeneration: unusedGetPublishedGeneration,
      markPublished: unusedMarkPublished,
    };

    const outcome = await materializeContentClaim('cclaim_okf_race', tmp, source, noopProxyLogger);
    expect(outcome).toEqual({ ok: false, code: 'unsupported_artifact_kind' });
    expect(contentFetched).toBe(false);
  });

  test('a same-generation republish whose mark-published call fails still returns the write outcome with autoPublished:false — and the orchestration adds no warn of its own', async () => {
    // Log discipline: the SOURCE owns the markPublished-false warn at its
    // point of detection (proven against the real remote source by the
    // overlay suite's failing-mark test). This seam-level test pins the
    // complementary half — `attemptAutoClose` adds no second, generic warn
    // on top of a false return, so a real failure logs exactly once.
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const spyLogger: ProxyLogger = {
      warn: (message, meta) => warnings.push({ message, meta }),
      error() { /* unused */ },
    };
    const source: ClaimSource = {
      async getActiveClaim(id) {
        return { id, artifactKind: 'skill', artifactId: 'skill-fail-mark', generation: 1 };
      },
      async getSkillContent() {
        return { name: 'fail-mark-skill', content: '# fail\n' };
      },
      async getPublishedGeneration() { return 1; }, // matches claim.generation -> a same-generation republish
      async markPublished() { return false; }, // failure AFTER the disk write landed; a real source logs this itself
    };

    const outcome = await materializeContentClaim('cclaim_fail_mark', tmp, source, spyLogger);
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.artifactKind === 'skill') {
      expect(outcome.autoPublished).toBe(false);
    }
    // The write is the user-visible outcome — it lands regardless of the
    // bookkeeping failure (spec's binding failure posture).
    expect(fs.existsSync(path.join(tmp, CANONICAL_PROJECT_SKILLS_DIR, 'fail-mark-skill', 'SKILL.md'))).toBe(true);
    expect(warnings.length).toBe(0);
  });
});
