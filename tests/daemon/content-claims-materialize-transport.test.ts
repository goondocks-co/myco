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
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DaemonServer } from '@myco/daemon/server.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority.js';
import { registerContentClaimRoutes } from '@myco/daemon/api/content-claims.js';
import { registerContentClaimMaterializeRoute } from '@myco/daemon/api/content-claims-materialize.js';
import { registerContentClaimFileStatusRoute } from '@myco/daemon/api/content-claims-file-status.js';
import { handleGetSkillRecord } from '@myco/daemon/api/skills.js';
import { tenantRoute } from '@myco/daemon/api/route-helpers.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { defaultDial } from '@myco/daemon/host-proxy.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import { insertLineage } from '@myco/db/queries/skill-lineage.js';
import { insertContentClaim, upsertContentPublication } from '@myco/db/queries/content-claims.js';
import { getDatabase, initDatabase, closeDatabase } from '@myco/db/client.js';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches } from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { assertGroveProjectId, createProjectId, createHostId } from '@myco/grove/ids.js';
import { createHostRegistryOperations, type HostRecord } from '@myco/host/registry.js';
import { startFunnelEdge, type FunnelEdge } from '../helpers/funnel-edge.js';
import { getMachineId } from '@myco/machine-id.js';
import { teamFetch, teamTestPort } from '../helpers/team-socket.js';
import { HOST_BEARER_SECRET, HOST_PROTOCOL_VERSION } from '@myco/constants.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { CANONICAL_PROJECT_SKILLS_DIR } from '@myco/skills/publication.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { issueTestMemberToken } from '../helpers/member-token.js';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;
const { writeHostSecret } = createHostRegistryOperations(testPerUserLockNamespace);
const HOST_BEARER = 'test-content-claims-materialize-host-bearer';
const CONTENT = '# skill-1\n\nMaterialized body.\n';
const noopProxyLogger = { warn(): void {}, error(): void {} };

// The team listener binds an AF_UNIX socket, which host serving requires; it
// refuses to bind on Windows, so there is no transport to exercise there.
const describeTeamTransport = process.platform === 'win32' ? describe.skip : describe;

describeTeamTransport('content claim materialize over the real member -> host transport', () => {
  let tmp: string;
  let mycoHome: string;
  let hostServer: DaemonServer;
  let memberServer: DaemonServer;
  let hostCache: GroveRuntimeCache;
  let memberCache: GroveRuntimeCache;
  let projectId: string;
  let groveId: string;
  let claimId: string;
  let hostProjectRoot: string;
  let memberProjectRoot: string;
  let hostBearerRecord: HostRecord;
  let savedMycoHome: string | undefined;
  let savedTeamHome: string | undefined;
  let savedHome: string | undefined;
  let memberBase: string;
  let edge: FunnelEdge;
  let teamPort: number;

// ONE identity for the member, everywhere: the id its routes are registered
// with, the id its token is bound to, and the id holding the seeded claim.
// Production has exactly this property (a member enrolls with its own
// `getMachineId()`), and splitting it in a fixture makes the member look like
// it is impersonating another machine — which the token binding refuses.
//
// CONSEQUENCE: host and member share one process, so this is also the host's
// own fallback identity, and `claimed_by === CLAIMING_MACHINE` cannot tell a
// travelled stamp from a host default. The discriminating gate is on the gate
// path — see `tests/daemon/team-member-tokens.test.ts`.
let CLAIMING_MACHINE: string;
const NON_HOLDER_MACHINE = 'not-the-claim-holder';
let memberToken: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cclaim-mat-overlay-'));
    savedMycoHome = process.env.MYCO_HOME;
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    savedHome = process.env.HOME;
    mycoHome = path.join(tmp, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team-home');
    // A REAL issued member token: the shared host bearer is no longer accepted,
    // so a fixture must hold a credential the host actually issued.
    CLAIMING_MACHINE = getMachineId();
    memberToken = issueTestMemberToken(CLAIMING_MACHINE);
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
      claimedBy: CLAIMING_MACHINE,
      claimedAt: now,
      expiresAt: now + 3600,
      machineId: CLAIMING_MACHINE,
    });
    if (!created.ok) throw new Error('test setup: unexpected already_claimed conflict');
    claimId = created.row.id;

    // --- host daemon: real overlay listener, real content-claim + skill-record routes ---
    const hostLogger = new DaemonLogger(path.join(tmp, 'host-logs'));
    teamPort = teamTestPort();
    hostServer = new DaemonServer({
      vaultDir: path.join(tmp, 'host-anchor', '.myco'),
      logger: hostLogger,
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
      // servedGroveId designates `grove` as the ONE Grove this host serves —
      // required since Task 2's servedGroveRefusal fail-closed filter now
      // refuses every overlay request when the designation is absent, even
      // one naming a real, owned Grove.
      teamPort: teamPort,
      hostServe: { bearer: HOST_BEARER, servedGroveId: grove.id },
    });
    registerContentClaimRoutes(hostServer, { machineId: 'host-machine', logger: hostLogger });
    // Registered so the host's own overlay-stamp backstop (`overlayHostStampRefusal`
    // in `daemon/server.ts`) has a matched route to classify — an overlay hit on
    // this `localhost-only`-stamped path must be refused BEFORE the handler below
    // ever resolves a member's disk (see the transport-boundary test at the bottom
    // of this file).
    registerContentClaimFileStatusRoute(hostServer, {
      logger: noopProxyLogger,
      mycoHome,
      lockNamespace: testPerUserLockNamespace,
    });
    hostServer.registerRoute(
      'GET',
      '/api/skill-records/:id',
      tenantRoute({ machineId: 'host-machine', logger: hostLogger }, handleGetSkillRecord),
    );
    hostCache = new GroveRuntimeCache();
    registerContentClaimMaterializeRoute(hostServer, {
      cache: hostCache,
      dial: defaultDial,
      logger: noopProxyLogger,
      machineId: 'host-machine',
      mycoHome,
      lockNamespace: testPerUserLockNamespace,
    });
    await hostServer.start(0);
    // The public edge in front of the host's socket: the member dials THIS,
    // over real TLS, through the production dialer.
    edge = await startFunnelEdge({ port: teamPort });

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
      host_url: edge.url,
      protocol_version: HOST_PROTOCOL_VERSION,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: grove.id, project_id: projectId, root: memberProjectRoot }],
    };
    writeHostRecordFixture(hostBearerRecord);
    // The member's stored credential is its ISSUED token — the shared host
    // bearer is no longer accepted.
    writeHostSecret(hostBearerRecord.host_id, HOST_BEARER_SECRET, memberToken);
    saveProjectManifest(resolveProjectVaultDir(memberProjectRoot), { project: { id: projectId } });

    // --- member daemon: loopback only, no local Grove DB for this project ---
    const memberLogger = new DaemonLogger(path.join(tmp, 'member-logs'));
    memberServer = new DaemonServer({
      vaultDir: path.join(tmp, 'member-anchor', '.myco'),
      logger: memberLogger,
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
    });
    memberCache = new GroveRuntimeCache();
    // Registered locally (mirroring production `daemon/main.ts`, which wires every
    // content-claim route on every daemon unconditionally) so the router match
    // succeeds and the daemon's attach-classification chokepoint (`server.ts`
    // `handleRequest`) runs at all — for an attached project this `serve`-stamped
    // GET is then proxied to the host rather than invoking this local handler
    // (see the inventory-through-the-proxy test at the bottom of this file).
    registerContentClaimRoutes(memberServer, { machineId: CLAIMING_MACHINE, logger: memberLogger });
    registerContentClaimMaterializeRoute(memberServer, {
      cache: memberCache,
      dial: defaultDial,
      logger: noopProxyLogger,
      // Matches `claimedBy` on both fixture claims above: the auto-close
      // mark-published dial stamps this as the member's own machine id
      // (`REQUEST_CONTEXT_HEADERS.machineId`), and the host's holder gate
      // (`content-claims.ts`'s `loadActiveHeldClaim`) requires it to equal
      // `claim.claimed_by`.
      machineId: CLAIMING_MACHINE,
      mycoHome,
      lockNamespace: testPerUserLockNamespace,
    });
    registerContentClaimFileStatusRoute(memberServer, {
      logger: noopProxyLogger,
      mycoHome,
      lockNamespace: testPerUserLockNamespace,
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
    // Before the host: the edge holds sockets open against it.
    try { await edge?.close(); } catch { /* not started */ }
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

  test("member materializes with the dashboard's full tenancy-header shape (grove-id + project-id + auth) — drives the registered-context branch real traffic hits (PR-669 residual)", async () => {
    // `materialize`/`file-status` are `localhost-only` (never proxied), so
    // — unlike the `serve`/proxied `GET /api/content-claims` below, whose
    // remote-classification branch never touches local context resolution
    // at all — a request here DOES run the full local
    // `resolveRouteRequestContext` before the handler, same as any other
    // localhost-only route. The prior test above sent no headers at all;
    // this one sends the shape the dashboard ACTUALLY sends:
    // `requestContextHeadersForSelection()` (ui/src/lib/selection.ts)
    // always emits `x-myco-grove-id` PAIRED with `x-myco-project-id`, plus
    // `x-myco-auth` — every `ClaimControl` action fires only once a
    // `ProjectSelection` is active, so `fetchJson` always attaches all
    // three. With grove-id present, `requestContextFromHttpHeaders` takes
    // the REGISTERED branch (`resolveRegisteredRequestContext`) rather than
    // the manifest-header branch a project-id-only request routes through —
    // the fixture registers the grove locally, so this exercises the branch
    // real dashboard traffic hits. Proves the handler's identity resolution
    // — deliberately sourced from the JSON body's `project_root`, NOT
    // `req.requestContext` (see this file's module docstring) — actually
    // holds under that shape.
    const res = await fetch(`${memberBase}/api/content-claims/${claimId}/materialize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-myco-grove-id': groveId,
        'x-myco-project-id': projectId,
        'x-myco-auth': memberServer.getAuthToken(),
      },
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
  });

  test("member checks file-status with the dashboard's full tenancy-header shape (grove-id + project-id + auth) — PR-669 residual, file-status half", async () => {
    // Sibling of the materialize case above — file-status shares the same
    // `localhost-only` stamp and the same `resolveMemberProjectContext`
    // prelude, so it is exposed to the identical registered-branch
    // local-context resolution a real dashboard request exercises.
    const res = await fetch(`${memberBase}/api/content-claims/file-status`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-myco-grove-id': groveId,
        'x-myco-project-id': projectId,
        'x-myco-auth': memberServer.getAuthToken(),
      },
      body: JSON.stringify({
        project_root: memberProjectRoot,
        artifacts: [{ artifact_kind: 'skill', artifact_id: 'skill-1', name: 'skill-1' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { statuses: Array<{ artifact_kind: string | null; artifact_id: string | null; file_present: boolean | null }> };
    // Not yet materialized on the member tree in THIS test's fixture state.
    expect(body.statuses).toEqual([{ artifact_kind: 'skill', artifact_id: 'skill-1', file_present: false }]);
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

  test('a same-generation republish whose proxied mark-published call fails (real 403 not_holder) still returns the write with auto_published:false and exactly ONE warn', async () => {
    // Drives the REAL remote source's mark-failure path end-to-end: this
    // member daemon's machineId does not match the claim's `claimed_by`, so
    // every read dial succeeds and the write lands, but the host's holder
    // gate 403s the mark-published POST. The failure posture (200 +
    // auto_published:false) and the single-warn discipline (the remote
    // source's one detection warn, nothing added by the orchestration) are
    // both asserted against real code, not a hand-rolled ClaimSource.
    upsertContentPublication({
      artifact_kind: 'skill',
      artifact_id: 'skill-1',
      published_generation: 1, // same generation as the claim — the auto-close check fires
      published_at: Math.floor(Date.now() / 1000) - 3600,
      published_by: 'attached-member-machine',
      machine_id: 'attached-member-machine',
    });

    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const spyLogger = {
      warn(message: string, meta?: Record<string, unknown>): void { warnings.push({ message, meta }); },
      error(): void { /* unused */ },
    };
    // Its own credential: the stored host secret is what the dial carries, so
    // it is swapped to the non-holder's token for this case.
    writeHostSecret(hostBearerRecord.host_id, HOST_BEARER_SECRET, issueTestMemberToken(NON_HOLDER_MACHINE));
    const nonHolderLogger = new DaemonLogger(path.join(tmp, 'non-holder-logs'));
    const nonHolderServer = new DaemonServer({
      vaultDir: path.join(tmp, 'non-holder-anchor', '.myco'),
      logger: nonHolderLogger,
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
    });
    const nonHolderCache = new GroveRuntimeCache();
    registerContentClaimMaterializeRoute(nonHolderServer, {
      cache: nonHolderCache,
      dial: defaultDial,
      logger: spyLogger,
      // A DIFFERENT machine, so it carries its OWN token bound to that
      // identity — a member cannot present someone else's. The host therefore
      // ACCEPTS the request and refuses it at the holder gate, which is the
      // 403 this case is about.
      machineId: NON_HOLDER_MACHINE,
      mycoHome,
      lockNamespace: testPerUserLockNamespace,
    });
    await nonHolderServer.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${nonHolderServer.port}/api/content-claims/${claimId}/materialize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_root: memberProjectRoot }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; skill_name: string; generation: number; auto_published: boolean };
      expect(body).toMatchObject({ ok: true, skill_name: 'skill-1', generation: 1, auto_published: false });

      // The write is the user-visible outcome — it landed on the member tree
      // despite the failed bookkeeping.
      const written = fs.readFileSync(
        path.join(memberProjectRoot, CANONICAL_PROJECT_SKILLS_DIR, 'skill-1', 'SKILL.md'),
        'utf-8',
      );
      expect(written).toBe(CONTENT);

      // The host refused the close: the claim stays active for the holder's
      // own manual Mark-published flow or TTL expiry.
      const claimRow = getDatabase().prepare(
        `SELECT state FROM content_claims WHERE id = ?`,
      ).get(claimId) as { state: string } | undefined;
      expect(claimRow?.state).toBe('active');

      // Exactly one warn: the remote source's detection log (carrying the
      // dial's real 403), with no second generic warn from the orchestration.
      expect(warnings.length).toBe(1);
      expect(warnings[0].message).toContain('mark-published');
      expect(warnings[0].meta?.status).toBe(403);
    } finally {
      try { await nonHolderServer.stop(); } catch { /* not started */ }
      try { nonHolderCache.closeAll(); } catch { /* not created */ }
    }
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

  test('an overlay-origin hit on the materialize path is refused at the transport boundary — the writers are never reached', async () => {
    const res = await teamFetch(teamPort, `/api/content-claims/${claimId}/materialize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${memberToken}`,
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

  test('an attached member GET /api/content-claims proxies to the host and carries the published[] entry, with active_claim', async () => {
    // skill-1 published at its own lineage-latest generation (1) — the
    // inventory route's `addCandidate` (content-claims.ts) routes this to
    // `published`, not `claimable`, and still attaches the live claim fixture
    // set up above (also generation 1, still `active`) as `active_claim`.
    const publishedAt = Math.floor(Date.now() / 1000) - 60;
    upsertContentPublication({
      artifact_kind: 'skill',
      artifact_id: 'skill-1',
      published_generation: 1,
      published_at: publishedAt,
      published_by: 'attached-member-machine',
      machine_id: 'attached-member-machine',
    });

    // No `x-myco-machine-id` — this is the member DAEMON's own attach-classification
    // dispatch, the same header shape the dashboard's inventory fetch uses. The
    // member has no local Grove DB for this project at all (B1's whole premise):
    // this can ONLY resolve by the member proxying to the host over the real
    // overlay dial, never a local answer.
    //
    // `x-myco-project-id` is a context-switching header (grove/request-context.ts),
    // so the member daemon's own auth-token gate requires its bearer here — the
    // same token a spawned child (hook/MCP) inherits via `MYCO_REQUEST_CONTEXT_AUTH`.
    const res = await fetch(`${memberBase}/api/content-claims`, {
      headers: { 'x-myco-project-id': projectId, 'x-myco-auth': memberServer.getAuthToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      published: Array<{
        artifact_kind: string;
        artifact_id: string;
        name: string;
        label: string;
        published_generation: number;
        lineage_generation: number;
        active_claim: { id: string; state: string; generation: number; claimed_by: string } | null;
      }>;
    };
    expect(body.ok).toBe(true);
    const entry = body.published.find((p) => p.artifact_id === 'skill-1');
    expect(entry).toMatchObject({
      artifact_kind: 'skill',
      artifact_id: 'skill-1',
      name: 'skill-1',
      label: 'Skill One',
      published_generation: 1,
      lineage_generation: 1,
    });
    expect(entry?.active_claim).toMatchObject({
      id: claimId,
      state: 'active',
      generation: 1,
      claimed_by: CLAIMING_MACHINE,
    });
  });

  test('a file-status POST arriving over the overlay is refused at the transport boundary — never resolves a member disk', async () => {
    // The member-disk-truth sibling of the materialize refusal above: the
    // `localhost-only` stamp (host/routing.ts) and the host's independent
    // overlay backstop (`overlayHostStampRefusal`, server.ts) hold for
    // `/api/content-claims/file-status` exactly as they do for materialize —
    // the specific `message`/`retryable` fields (not just a bare 404) prove the
    // STAMP-based refusal fired, not merely "no such route registered here".
    const res = await teamFetch(teamPort, '/api/content-claims/file-status', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${memberToken}`,
        'x-myco-host-protocol': String(HOST_PROTOCOL_VERSION),
        'x-myco-grove-id': groveId,
        'x-myco-project-id': projectId,
      },
      body: JSON.stringify({
        project_root: hostProjectRoot,
        artifacts: [{ artifact_kind: 'skill', artifact_id: 'skill-1', name: 'skill-1' }],
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; message: string; retryable: boolean };
    expect(body.error).toBe('not_found');
    expect(body.message).toBe('This route is served on localhost only, not over the overlay.');
    expect(body.retryable).toBe(false);
  });
});
