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
import { getOkfPageRevisionAtGeneration } from '@myco/db/queries/okf.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { MycoConfigSchema } from '@myco/config/schema.js';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches } from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { assertGroveProjectId, createProjectId, projectScope, type GroveProjectId } from '@myco/grove/ids.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { CANONICAL_PROJECT_SKILLS_DIR } from '@myco/skills/publication.js';
import { OkfStore } from '@myco/okf/store.js';
import { renderOkfDocument } from '@myco/okf/serialize.js';
import type { WikiPlan } from '@myco/okf/synthesis/plan.js';

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

  function okfPlan(pagePath: string): WikiPlan {
    return {
      generatedAt: new Date().toISOString(),
      sinceRef: '',
      pages: [{ path: pagePath, type: 'note', title: 'Foo', rationale: 'test page', sourceRefs: [] }],
    };
  }

  /**
   * Writes one OKF page through the REAL `OkfStore` write path (so FK rows
   * — `okf_generations` — and generation semantics are exactly what
   * production produces), optionally evolving it to a second
   * `page_generation` afterward, then claims one generation of it.
   * `claimGeneration` defaults to the LATEST written generation; pass `1`
   * with `evolvedBody` set to exercise generation pinning (an older claim
   * surviving a later edit).
   */
  function seedOkfPage(opts: {
    pagePath?: string;
    body?: string;
    evolvedBody?: string;
    claimGeneration?: number;
    claimedBy?: string;
  } = {}) {
    const db = cache.getDatabase(resolveGroveDbPath(groveId, mycoHome));
    const pagePath = opts.pagePath ?? 'architecture/foo';
    const body = opts.body ?? 'Body text.';
    const config = MycoConfigSchema.parse({ version: 3, okf: { enabled: true } });
    const now = epochNow();
    let pageId = '';
    let docPath = '';
    let latestGeneration = 1;
    let claimId = '';
    withDatabase(db, () => {
      const store = new OkfStore({
        scope: projectScope(projectId as GroveProjectId),
        projectId,
        machineId: 'agent-test',
        config,
      });
      const draft1 = store.createDraftGeneration({ runId: null, plan: okfPlan(pagePath) });
      const written1 = store.writePage({ path: pagePath, type: 'note', title: 'Foo', description: 'A test page.', body });
      store.finalizeGeneration(draft1.id);
      pageId = written1.pageId;
      docPath = written1.path;
      latestGeneration = written1.pageGeneration;

      if (opts.evolvedBody !== undefined) {
        const draft2 = store.createDraftGeneration({ runId: null, plan: okfPlan(pagePath) });
        const written2 = store.writePage({
          path: pagePath,
          type: 'note',
          title: 'Foo',
          description: 'A test page.',
          body: opts.evolvedBody,
        });
        store.finalizeGeneration(draft2.id);
        latestGeneration = written2.pageGeneration;
      }

      const claimGeneration = opts.claimGeneration ?? latestGeneration;
      const result = insertContentClaim({
        artifactKind: 'okf_page',
        artifactId: pageId,
        generation: claimGeneration,
        projectId,
        claimedBy: opts.claimedBy ?? 'machine-a',
        claimedAt: now,
        expiresAt: now + 3600,
        machineId: opts.claimedBy ?? 'machine-a',
      });
      if (!result.ok) throw new Error('test setup: unexpected already_claimed conflict');
      claimId = result.row.id;
    });
    return { pageId, claimId, docPath, latestGeneration };
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

  test('materializes an okf_page claim byte-faithful to the claimed revision, under the default published wiki root', async () => {
    const { pageId, claimId, docPath } = seedOkfPage({ body: 'Body text for foo.' });

    const res = await handler()(req(claimId, projectRoot));
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; path: string; page_path: string; generation: number };
    expect(body).toMatchObject({ ok: true, page_path: docPath, generation: 1 });

    // Default `config.okf.maintain.output_path` is 'okf', relative to the project root.
    const writtenPath = path.join(projectRoot, 'okf', docPath);
    expect(body.path).toBe(writtenPath);

    const db = cache.getDatabase(resolveGroveDbPath(groveId, mycoHome));
    const revision = withDatabase(db, () => getOkfPageRevisionAtGeneration(pageId, 1))!;
    const expected = renderOkfDocument({
      path: docPath,
      frontmatter: JSON.parse(revision.frontmatter),
      body: revision.body,
    });
    expect(fs.readFileSync(writtenPath, 'utf-8')).toBe(expected.content);
  });

  test('a non-default config.okf.maintain.output_path resolves the published root — proves the config read, not the fallback', async () => {
    // `output_path` is project-tier (config/scope.ts homes okf.* at 'project'),
    // read from the project's own myco.yaml. A value the hard-coded fallback
    // can never produce distinguishes a genuine config resolution from a
    // silently-swallowed loader error degrading to the 'okf' default.
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.myco', 'myco.yaml'),
      'version: 3\nokf:\n  enabled: true\n  maintain:\n    output_path: wiki\n',
    );
    const { claimId, docPath } = seedOkfPage({ body: 'Body under a custom wiki root.' });

    const res = await handler()(req(claimId, projectRoot));
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; path: string };
    expect(body.path).toBe(path.join(projectRoot, 'wiki', docPath));
    expect(fs.existsSync(path.join(projectRoot, 'wiki', docPath))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, 'okf'))).toBe(false);
  });

  test('a publish-eligibility finding blocks the write — nothing lands on disk', async () => {
    const { claimId, docPath } = seedOkfPage({ body: 'See /Users/alice/notes.txt for the source.' });

    const res = await handler()(req(claimId, projectRoot));
    expect(res.status).toBe(422);
    const body = res.body as { error: { code: string }; findings: Array<{ code: string; path: string }> };
    expect(body.error.code).toBe('scan_blocked');
    expect(body.findings.length).toBeGreaterThan(0);
    expect(body.findings[0].code).toBe('absolute_local_path');

    expect(fs.existsSync(path.join(projectRoot, 'okf', docPath))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, 'okf'))).toBe(false);
  });

  test('generation pinning: an older claimed generation writes the OLD revision even after the page evolved', async () => {
    const { pageId, claimId, docPath } = seedOkfPage({
      body: 'Original body, generation 1.',
      evolvedBody: 'Evolved body, generation 2.',
      claimGeneration: 1,
    });

    const res = await handler()(req(claimId, projectRoot));
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; generation: number };
    expect(body.generation).toBe(1);

    const writtenPath = path.join(projectRoot, 'okf', docPath);
    const written = fs.readFileSync(writtenPath, 'utf-8');
    expect(written).toContain('Original body, generation 1.');
    expect(written).not.toContain('Evolved body, generation 2.');

    // The page's own head has moved on to generation 2 — pinning is a
    // property of the claimed content fetch, not of the page row.
    const db = cache.getDatabase(resolveGroveDbPath(groveId, mycoHome));
    const latest = withDatabase(db, () => getOkfPageRevisionAtGeneration(pageId, 2))!;
    expect(latest.body).toBe('Evolved body, generation 2.');
  });

  test('current project root does not match the registered root -> loud root_mismatch, nothing written for an okf_page claim', async () => {
    const { claimId, docPath } = seedOkfPage();
    const movedRoot = path.join(tmp, 'moved-checkout-okf');
    fs.mkdirSync(movedRoot, { recursive: true });
    saveProjectManifest(resolveProjectVaultDir(movedRoot), { project: { id: projectId } });

    const res = await handler()(req(claimId, movedRoot));
    expect(res.status).toBe(409);
    const body = res.body as { error: { code: string }; registered_root: string; current_root: string };
    expect(body.error.code).toBe('root_mismatch');
    expect(body.registered_root).toBe(projectRoot);
    expect(body.current_root).toBe(path.resolve(movedRoot));
    expect(fs.existsSync(path.join(movedRoot, 'okf', docPath))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, 'okf', docPath))).toBe(false);
  });

  test('a host-served request context never reaches the okf_page writer', async () => {
    const { claimId, docPath } = seedOkfPage();
    const res = await handler()(req(claimId, projectRoot, { requestContext: { hostServed: true } as never }));
    expect(res.status).toBe(404);
    expect(fs.existsSync(path.join(projectRoot, 'okf', docPath))).toBe(false);
  });
});

/** A `ClaimSource` never exercises the OKF branch in these skill-only race
 *  tests — this stub proves it by throwing if the orchestration ever calls it. */
async function unusedOkfPageContent(): Promise<never> {
  throw new Error('getOkfPageContent must not be called for a skill claim');
}

/** `resolveOkfPublishedRootFn` is only invoked for an `okf_page` claim — this
 *  stub proves it by throwing if the orchestration ever calls it in a
 *  skill-only test. */
async function unusedOkfPublishedRoot(): Promise<never> {
  throw new Error('resolveOkfPublishedRootFn must not be called for a skill claim');
}

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
      getOkfPageContent: unusedOkfPageContent,
      getPublishedGeneration: unusedGetPublishedGeneration,
      markPublished: unusedMarkPublished,
    };

    const outcome = await materializeContentClaim('cclaim_race', tmp, source, unusedOkfPublishedRoot, noopProxyLogger);
    expect(outcome).toEqual({ ok: false, code: 'claim_no_longer_active' });
    expect(calls).toBe(2);
    expect(fs.existsSync(path.join(tmp, CANONICAL_PROJECT_SKILLS_DIR, 'race-skill'))).toBe(false);
  });

  test('a stale (already non-active) claim never reaches the content fetch', async () => {
    let contentFetched = false;
    const source: ClaimSource = {
      async getActiveClaim() { return null; },
      async getSkillContent() { contentFetched = true; return { name: 'x', content: 'x' }; },
      getOkfPageContent: unusedOkfPageContent,
      getPublishedGeneration: unusedGetPublishedGeneration,
      markPublished: unusedMarkPublished,
    };

    const outcome = await materializeContentClaim('cclaim_stale', tmp, source, unusedOkfPublishedRoot, noopProxyLogger);
    expect(outcome).toEqual({ ok: false, code: 'claim_not_active' });
    expect(contentFetched).toBe(false);
  });

  test('an okf_page claim: the claim goes inactive between fetch and the pre-write re-assert -> no write', async () => {
    let calls = 0;
    let contentFetched = false;
    const source: ClaimSource = {
      async getActiveClaim(id) {
        calls += 1;
        if (calls === 1) return { id, artifactKind: 'okf_page', artifactId: 'page-race', generation: 1 };
        return null;
      },
      getSkillContent: async () => { throw new Error('getSkillContent must not be called for an okf_page claim'); },
      async getOkfPageContent() {
        contentFetched = true;
        return { path: 'race.md', frontmatter: JSON.stringify({ type: 'note', title: 't', description: 'd', timestamp: '2026-01-01T00:00:00Z' }), body: 'race body' };
      },
      getPublishedGeneration: unusedGetPublishedGeneration,
      markPublished: unusedMarkPublished,
    };

    const outcome = await materializeContentClaim('cclaim_okf_race', tmp, source, async () => tmp, noopProxyLogger);
    expect(outcome).toEqual({ ok: false, code: 'claim_no_longer_active' });
    expect(calls).toBe(2);
    expect(contentFetched).toBe(true); // content WAS fetched — the re-assert runs after, per spec §4 step 3
    expect(fs.existsSync(path.join(tmp, 'race.md'))).toBe(false);
  });

  test('a same-generation republish whose mark-published call fails still returns the write outcome with autoPublished:false, and logs a warn', async () => {
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
      getOkfPageContent: unusedOkfPageContent,
      async getPublishedGeneration() { return 1; }, // matches claim.generation -> a same-generation republish
      async markPublished() { return false; }, // simulated failure AFTER the disk write already landed
    };

    const outcome = await materializeContentClaim('cclaim_fail_mark', tmp, source, unusedOkfPublishedRoot, spyLogger);
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.artifactKind === 'skill') {
      expect(outcome.autoPublished).toBe(false);
    }
    // The write is the user-visible outcome — it lands regardless of the
    // bookkeeping failure (spec's binding failure posture).
    expect(fs.existsSync(path.join(tmp, CANONICAL_PROJECT_SKILLS_DIR, 'fail-mark-skill', 'SKILL.md'))).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0].message).toContain('auto-close');
  });
});
