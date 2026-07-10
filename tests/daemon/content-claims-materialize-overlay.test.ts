/**
 * Content claim materialize over the Team Host overlay — driven through TWO
 * real `DaemonServer` instances, the same shape as
 * `tests/daemon/content-claims-overlay.test.ts`: a "host" with a real overlay
 * listener bound to its own real Grove DB, and a "member" with only the
 * loopback listener and no local Grove DB for the attached project.
 *
 * Covers what the single-daemon local-project suite
 * (`tests/daemon/api/content-claims-materialize.test.ts`) cannot:
 *   - the member's REMOTE claim source actually dials the host directly
 *     (mirroring `attached-config.ts`) and materializes to the member's OWN
 *     tree, never the host's;
 *   - root reconciliation against `AttachRef.root`;
 *   - the `localhost-only` stamp refusing an overlay-origin hit on this path
 *     at the transport boundary, before any handler (and so before any
 *     writer) runs — the structural proof behind "a host-served request
 *     never reaches the writers" (B1).
 *
 * Hermetic: `MYCO_HOME` (the host's Grove registry), `MYCO_TEAM_HOME` (the
 * member's attach registry), and `HOME` (deterministic agent-symlink
 * detection) are fresh tmpdirs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DaemonServer } from '@myco/daemon/server.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority.js';
import { registerContentClaimRoutes } from '@myco/daemon/api/content-claims.js';
import { registerContentClaimMaterializeRoute } from '@myco/daemon/api/content-claims-materialize.js';
import { handleGetSkillRecord } from '@myco/daemon/api/skills.js';
import { handleOkfPageRevisionsById } from '@myco/daemon/api/okf.js';
import { tenantRoute } from '@myco/daemon/api/route-helpers.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { defaultDial } from '@myco/daemon/host-proxy.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import { insertLineage } from '@myco/db/queries/skill-lineage.js';
import { insertContentClaim, upsertContentPublication } from '@myco/db/queries/content-claims.js';
import { getOkfPageRevisionAtGeneration } from '@myco/db/queries/okf.js';
import { getDatabase, initDatabase, closeDatabase } from '@myco/db/client.js';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches } from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { assertGroveProjectId, createProjectId, createHostId, projectScope, type GroveProjectId } from '@myco/grove/ids.js';
import { upsertHost, writeHostSecret, type HostRecord } from '@myco/host/registry.js';
import { HOST_BEARER_SECRET, HOST_PROTOCOL_VERSION } from '@myco/constants.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { CANONICAL_PROJECT_SKILLS_DIR } from '@myco/skills/publication.js';
import { MycoConfigSchema } from '@myco/config/schema.js';
import { OkfStore } from '@myco/okf/store.js';
import { renderOkfDocument } from '@myco/okf/serialize.js';
import type { WikiPlan } from '@myco/okf/synthesis/plan.js';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;
const HOST_BEARER = 'test-content-claims-materialize-host-bearer';
const CONTENT = '# skill-1\n\nMaterialized body.\n';
const noopProxyLogger = { warn(): void {}, error(): void {} };

describe('content claim materialize over the Team Host overlay', () => {
  let tmp: string;
  let mycoHome: string;
  let hostServer: DaemonServer;
  let memberServer: DaemonServer;
  let hostCache: GroveRuntimeCache;
  let memberCache: GroveRuntimeCache;
  let projectId: string;
  let groveId: string;
  let claimId: string;
  let okfClaimId: string;
  let okfPageId: string;
  let okfDocPath: string;
  let hostProjectRoot: string;
  let memberProjectRoot: string;
  let hostBearerRecord: HostRecord;
  let savedMycoHome: string | undefined;
  let savedTeamHome: string | undefined;
  let savedHome: string | undefined;
  let memberBase: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cclaim-mat-overlay-'));
    savedMycoHome = process.env.MYCO_HOME;
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    savedHome = process.env.HOME;
    mycoHome = path.join(tmp, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team-home');
    const fakeHome = path.join(tmp, 'user-home');
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    clearGroveRegistryCaches();

    // --- the host's REAL Grove, project, skill record + lineage + claim ---
    const grove = createGrove('Work', mycoHome);
    groveId = grove.id;
    ensureGroveDatabase(grove.id, mycoHome);
    const databasePath = resolveGroveDbPath(grove.id, mycoHome);
    initDatabase(databasePath);

    projectId = assertGroveProjectId(createProjectId());
    hostProjectRoot = path.join(tmp, 'host-project'); // the host's own idea of the tree — must never be touched
    fs.mkdirSync(hostProjectRoot, { recursive: true });
    registerProjectInGrove(grove.id, { projectId, projectName: 'Work project', projectRoot: hostProjectRoot }, mycoHome);
    // The OKF read routes (`daemon/api/okf.ts`'s `contextFor`) resolve merged
    // config from the host project's own myco.yaml — a real host project
    // always has one (`myco init`), so the fixture needs one too.
    fs.mkdirSync(path.join(hostProjectRoot, '.myco'), { recursive: true });
    fs.writeFileSync(path.join(hostProjectRoot, '.myco', 'myco.yaml'), 'version: 3\nokf:\n  enabled: true\n');

    registerAgent({ id: 'agent-test', name: 'Test Agent', created_at: Math.floor(Date.now() / 1000) });
    const now = Math.floor(Date.now() / 1000);
    insertSkillRecord({
      id: 'skill-1',
      project_id: projectId,
      agent_id: 'agent-test',
      name: 'skill-1',
      display_name: 'Skill One',
      description: 'A test skill',
      path: '.agents/skills/skill-1/SKILL.md',
      generation: 1,
      created_at: now,
      updated_at: now,
    });
    insertLineage({
      id: 'lin-skill-1',
      project_id: projectId,
      skill_id: 'skill-1',
      generation: 1,
      action: 'create',
      rationale: 'test',
      content_snapshot: CONTENT,
      created_at: now,
    });
    const created = insertContentClaim({
      artifactKind: 'skill',
      artifactId: 'skill-1',
      generation: 1,
      projectId,
      claimedBy: 'attached-member-machine',
      claimedAt: now,
      expiresAt: now + 3600,
      machineId: 'attached-member-machine',
    });
    if (!created.ok) throw new Error('test setup: unexpected already_claimed conflict');
    claimId = created.row.id;

    // --- the host's REAL OKF page + claim, same Grove DB, for the OKF dial-through test ---
    const okfStore = new OkfStore({
      scope: projectScope(projectId as GroveProjectId),
      projectId,
      machineId: 'agent-test',
      config: MycoConfigSchema.parse({ version: 3, okf: { enabled: true } }),
    });
    const okfPlan: WikiPlan = {
      generatedAt: new Date().toISOString(),
      sinceRef: '',
      pages: [{ path: 'architecture/foo', type: 'note', title: 'Foo', rationale: 'test', sourceRefs: [] }],
    };
    const okfDraft = okfStore.createDraftGeneration({ runId: null, plan: okfPlan });
    const okfWritten = okfStore.writePage({
      path: 'architecture/foo',
      type: 'note',
      title: 'Foo',
      description: 'A test page.',
      body: 'OKF body materialized over the overlay.',
    });
    okfStore.finalizeGeneration(okfDraft.id);
    okfPageId = okfWritten.pageId;
    okfDocPath = okfWritten.path;
    const okfClaim = insertContentClaim({
      artifactKind: 'okf_page',
      artifactId: okfPageId,
      generation: 1,
      projectId,
      claimedBy: 'attached-member-machine',
      claimedAt: now,
      expiresAt: now + 3600,
      machineId: 'attached-member-machine',
    });
    if (!okfClaim.ok) throw new Error('test setup: unexpected already_claimed conflict');
    okfClaimId = okfClaim.row.id;

    // --- host daemon: real overlay listener, real content-claim + skill-record + okf routes ---
    const hostLogger = new DaemonLogger(path.join(tmp, 'host-logs'));
    hostServer = new DaemonServer({
      vaultDir: path.join(tmp, 'host-anchor', '.myco'),
      logger: hostLogger,
      daemonStateAuthority: stubAuthority,
      hostServe: { overlayAddress: '127.0.0.1', overlayPort: 0, bearer: HOST_BEARER },
    });
    registerContentClaimRoutes(hostServer, { machineId: 'host-machine', logger: hostLogger });
    hostServer.registerRoute(
      'GET',
      '/api/skill-records/:id',
      tenantRoute({ machineId: 'host-machine', logger: hostLogger }, handleGetSkillRecord),
    );
    hostServer.registerRoute(
      'GET',
      '/api/okf/pages/by-id/:id',
      tenantRoute({ machineId: 'host-machine', logger: hostLogger }, handleOkfPageRevisionsById),
    );
    hostCache = new GroveRuntimeCache();
    registerContentClaimMaterializeRoute(hostServer, {
      cache: hostCache,
      dial: defaultDial,
      logger: noopProxyLogger,
      machineId: 'host-machine',
      mycoHome,
    });
    await hostServer.start(0);

    // --- attach the project to the host (member's machine-global registry) ---
    // Built directly rather than via `attachProject`: that helper refuses to
    // attach a project with a LOCAL Grove registry row (the never-materialize
    // invariant), but this test's "host" and "member" share one process/
    // MYCO_HOME (there is only one real filesystem), so the project IS
    // registered locally here — on the host's side, which is exactly correct
    // (the host owns this Grove locally; only a real second machine's member
    // would have no local row for it).
    memberProjectRoot = path.join(tmp, 'member-project');
    fs.mkdirSync(memberProjectRoot, { recursive: true });
    hostBearerRecord = {
      host_id: createHostId(),
      label: 'Test host',
      overlay_address: `127.0.0.1:${hostServer.overlayPort}`,
      protocol_version: HOST_PROTOCOL_VERSION,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: grove.id, project_id: projectId, root: memberProjectRoot }],
    };
    upsertHost(hostBearerRecord);
    writeHostSecret(hostBearerRecord.host_id, HOST_BEARER_SECRET, HOST_BEARER);
    saveProjectManifest(resolveProjectVaultDir(memberProjectRoot), { project: { id: projectId } });

    // --- member daemon: loopback only, no local Grove DB for this project ---
    const memberLogger = new DaemonLogger(path.join(tmp, 'member-logs'));
    memberServer = new DaemonServer({
      vaultDir: path.join(tmp, 'member-anchor', '.myco'),
      logger: memberLogger,
      daemonStateAuthority: stubAuthority,
    });
    memberCache = new GroveRuntimeCache();
    registerContentClaimMaterializeRoute(memberServer, {
      cache: memberCache,
      dial: defaultDial,
      logger: noopProxyLogger,
      // Matches `claimedBy` on both fixture claims above: the auto-close
      // mark-published dial stamps this as the member's own machine id
      // (`REQUEST_CONTEXT_HEADERS.machineId`), and the host's holder gate
      // (`content-claims.ts`'s `loadActiveHeldClaim`) requires it to equal
      // `claim.claimed_by`.
      machineId: 'attached-member-machine',
      mycoHome,
    });
    await memberServer.start(0);
    memberBase = `http://127.0.0.1:${memberServer.port}`;
  });

  afterEach(async () => {
    // Every step is independently guarded: a `beforeEach` that threw partway
    // through setup must not skip env/db restoration for later tests — a
    // partial cleanup here previously cascaded into unrelated failures in
    // every test that ran after the one whose setup failed.
    try { await memberServer?.stop(); } catch { /* not started */ }
    try { await hostServer?.stop(); } catch { /* not started */ }
    try { hostCache?.closeAll(); } catch { /* not created */ }
    try { memberCache?.closeAll(); } catch { /* not created */ }
    try { closeDatabase(); } catch { /* already closed */ }
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedMycoHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeamHome;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    clearGroveRegistryCaches();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('member materializes an attached claim by dialing the host directly — lands on the MEMBER tree only', async () => {
    const res = await fetch(`${memberBase}/api/content-claims/${claimId}/materialize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_root: memberProjectRoot }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; skill_name: string; generation: number; auto_published: boolean };
    expect(body).toMatchObject({ ok: true, skill_name: 'skill-1', generation: 1, auto_published: false });

    const written = fs.readFileSync(
      path.join(memberProjectRoot, CANONICAL_PROJECT_SKILLS_DIR, 'skill-1', 'SKILL.md'),
      'utf-8',
    );
    expect(written).toBe(CONTENT);

    // The host's own project tree was never touched — the host holds the
    // Grove DB, not the member's working tree (B1).
    expect(fs.existsSync(path.join(hostProjectRoot, CANONICAL_PROJECT_SKILLS_DIR))).toBe(false);

    // No prior publication row exists for this artifact, so this is a
    // first-time publish, not a republish — the claim on the host's Grove DB
    // stays `active` for the manual Mark-published flow (Task 1.4's
    // republish auto-close is covered by the test below).
    const row = getDatabase().prepare(
      `SELECT state FROM content_claims WHERE id = ?`,
    ).get(claimId) as { state: string } | undefined;
    expect(row?.state).toBe('active');
  });

  test('member republishes a same-generation claim — auto-closes through the proxied mark-published call', async () => {
    const priorPublishedAt = Math.floor(Date.now() / 1000) - 3600;
    upsertContentPublication({
      artifact_kind: 'skill',
      artifact_id: 'skill-1',
      published_generation: 1, // matches the fixture claim's own generation — a republish
      published_at: priorPublishedAt,
      published_by: 'attached-member-machine',
      machine_id: 'attached-member-machine',
    });

    const res = await fetch(`${memberBase}/api/content-claims/${claimId}/materialize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_root: memberProjectRoot }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; skill_name: string; generation: number; auto_published: boolean };
    expect(body).toMatchObject({ ok: true, skill_name: 'skill-1', generation: 1, auto_published: true });

    // The republished content still lands on the member's tree exactly as a
    // normal materialize would.
    const written = fs.readFileSync(
      path.join(memberProjectRoot, CANONICAL_PROJECT_SKILLS_DIR, 'skill-1', 'SKILL.md'),
      'utf-8',
    );
    expect(written).toBe(CONTENT);

    // The member dialed the host's OWN `POST /api/content-claims/:id/published`
    // through the real overlay — the close landed on the host's Grove DB.
    const claimRow = getDatabase().prepare(
      `SELECT state, published_at FROM content_claims WHERE id = ?`,
    ).get(claimId) as { state: string; published_at: number } | undefined;
    expect(claimRow?.state).toBe('published');
    expect(claimRow?.published_at).toBeGreaterThan(priorPublishedAt);

    const pubRow = getDatabase().prepare(
      `SELECT published_generation, published_at FROM content_publications WHERE artifact_kind = 'skill' AND artifact_id = 'skill-1'`,
    ).get() as { published_generation: number; published_at: number } | undefined;
    expect(pubRow?.published_generation).toBe(1);
    expect(pubRow?.published_at).toBeGreaterThan(priorPublishedAt);
  });

  test('member materializes an attached okf_page claim by dialing the host directly — byte-faithful, lands on the MEMBER tree only', async () => {
    const res = await fetch(`${memberBase}/api/content-claims/${okfClaimId}/materialize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_root: memberProjectRoot }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; path: string; page_path: string; generation: number };
    expect(body).toMatchObject({ ok: true, page_path: okfDocPath, generation: 1 });

    const revision = getOkfPageRevisionAtGeneration(okfPageId, 1)!;
    const expected = renderOkfDocument({
      path: okfDocPath,
      frontmatter: JSON.parse(revision.frontmatter),
      body: revision.body,
    });
    // This member checkout has NO myco.yaml, so the attached config read
    // throws and the published root degrades to the schema default ('okf',
    // relative to the project root) — the graceful-degradation path. The
    // non-default-root test below covers the genuine config resolution.
    const written = fs.readFileSync(path.join(memberProjectRoot, 'okf', okfDocPath), 'utf-8');
    expect(written).toBe(expected.content);

    // The host's own project tree was never touched (B1).
    expect(fs.existsSync(path.join(hostProjectRoot, 'okf'))).toBe(false);
  });

  test('attached member with a non-default output_path in its own myco.yaml materializes there — proves the attached config resolution, not the fallback', async () => {
    // `output_path` is project-tier (config/scope.ts homes okf.* at
    // 'project'), so it structurally CANNOT arrive via the host grove-config
    // fetch — `pruneToTier(groveRaw, 'grove')` strips okf.* from the host
    // doc. The member-resolved value comes from the member checkout's own
    // committed myco.yaml through `loadAttachedMergedConfig` (which still
    // dials the host for the grove tier along the way). A 'wiki' landing spot
    // is unreachable by the hard-coded 'okf' fallback, so this proves the
    // attached loader ran end-to-end rather than silently degrading.
    fs.writeFileSync(
      path.join(memberProjectRoot, '.myco', 'myco.yaml'),
      'version: 3\nokf:\n  enabled: true\n  maintain:\n    output_path: wiki\n',
    );

    const res = await fetch(`${memberBase}/api/content-claims/${okfClaimId}/materialize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_root: memberProjectRoot }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; path: string; page_path: string };
    expect(body.path).toBe(path.join(memberProjectRoot, 'wiki', okfDocPath));
    expect(fs.existsSync(path.join(memberProjectRoot, 'wiki', okfDocPath))).toBe(true);
    expect(fs.existsSync(path.join(memberProjectRoot, 'okf'))).toBe(false);
    expect(fs.existsSync(path.join(hostProjectRoot, 'okf'))).toBe(false);
    expect(fs.existsSync(path.join(hostProjectRoot, 'wiki'))).toBe(false);
  });

  test('root mismatch against AttachRef.root -> loud error naming both paths, nothing written', async () => {
    const wrongRoot = path.join(tmp, 'wrong-checkout');
    fs.mkdirSync(wrongRoot, { recursive: true });
    saveProjectManifest(resolveProjectVaultDir(wrongRoot), { project: { id: projectId } });

    const res = await fetch(`${memberBase}/api/content-claims/${claimId}/materialize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_root: wrongRoot }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string }; attached_root: string; current_root: string };
    expect(body.error.code).toBe('root_mismatch');
    expect(body.attached_root).toBe(memberProjectRoot);
    expect(body.current_root).toBe(path.resolve(wrongRoot));
    expect(fs.existsSync(path.join(wrongRoot, CANONICAL_PROJECT_SKILLS_DIR))).toBe(false);
  });

  test('member materializes an attached okf_page claim when the HOST has no local working tree for the served project (F1)', async () => {
    // Team Host shape: the host's registered project root doesn't exist on
    // the host's own filesystem (the checkout lives on some OTHER member's
    // machine) — only the Grove DB (content) is authoritative here. Before
    // the fix, `GET /api/okf/pages/by-id/:id` 500'd resolving this project's
    // config (`okf.ts`'s `contextFor` required a present `myco.yaml`), so
    // `remoteClaimSource.getOkfPageContent` saw a non-200 and the whole
    // materialize failed 422 `content_unavailable` even though the page body
    // existed in the Grove DB the whole time.
    fs.rmSync(hostProjectRoot, { recursive: true, force: true });

    const res = await fetch(`${memberBase}/api/content-claims/${okfClaimId}/materialize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_root: memberProjectRoot }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; path: string; page_path: string; generation: number };
    expect(body).toMatchObject({ ok: true, page_path: okfDocPath, generation: 1 });

    const revision = getOkfPageRevisionAtGeneration(okfPageId, 1)!;
    const expected = renderOkfDocument({
      path: okfDocPath,
      frontmatter: JSON.parse(revision.frontmatter),
      body: revision.body,
    });
    const written = fs.readFileSync(path.join(memberProjectRoot, 'okf', okfDocPath), 'utf-8');
    expect(written).toBe(expected.content);
  });

  test('an overlay-origin hit on the materialize path is refused at the transport boundary — the writers are never reached', async () => {
    const res = await fetch(`http://127.0.0.1:${hostServer.overlayPort}/api/content-claims/${claimId}/materialize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${HOST_BEARER}`,
        'x-myco-host-protocol': String(HOST_PROTOCOL_VERSION),
        'x-myco-grove-id': groveId,
        'x-myco-project-id': projectId,
      },
      body: JSON.stringify({ project_root: hostProjectRoot }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_found');

    // Nothing landed anywhere a materialize write could plausibly have gone.
    expect(fs.existsSync(path.join(hostProjectRoot, CANONICAL_PROJECT_SKILLS_DIR))).toBe(false);
    expect(fs.existsSync(path.join(memberProjectRoot, CANONICAL_PROJECT_SKILLS_DIR))).toBe(false);
  });
});
