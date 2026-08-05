/**
 * Content claim system over the real member→host transport — TWO real
 * `DaemonServer` instances (a "member" with only the loopback listener, a
 * "host" with its real team listener on a unix socket, serving its own real
 * Grove DB) with a real HTTPS edge between them.
 *
 * Nothing here is injected: the member's proxy runs the production
 * `defaultDial`, which issues a genuine `https.request` at the recorded
 * `host_url`; the edge terminates TLS and forwards to the host's socket exactly
 * as Tailscale Funnel does, Host-rewrite included. So these tests prove an
 * end-to-end claim reaches the host's authoritative Grove state over the
 * transport that ships, not that bytes moved between two fixtures.
 *
 * Hermetic: `MYCO_HOME` (the host's Grove registry) and `MYCO_TEAM_HOME`
 * (the member's attach registry) are fresh tmpdirs.
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
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import { getDatabase, initDatabase, closeDatabase } from '@myco/db/client.js';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches } from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { assertGroveProjectId, createProjectId, createHostId } from '@myco/grove/ids.js';
import { createHostRegistryOperations, type HostRecord } from '@myco/host/registry.js';
import { startFunnelEdge, type FunnelEdge } from '../helpers/funnel-edge.js';
import { teamFetch, teamSocketPath } from '../helpers/team-socket.js';
import { getMachineId } from '@myco/machine-id.js';
import { HOST_BEARER_SECRET, HOST_PROTOCOL_VERSION } from '@myco/constants.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { issueTestMemberToken } from '../helpers/member-token.js';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;
const { writeHostSecret } = createHostRegistryOperations(testPerUserLockNamespace);
const HOST_BEARER = 'test-content-claims-host-bearer';
// The member acts as ITSELF. A browser-shaped request carries no machine id,
// so the member's proxy stamps its own — and the token is bound to that same
// identity, exactly as production issues it. A literal here would make the
// fixture a member impersonating another machine, which the binding now
// (correctly) refuses; substituting one fails the browser-shaped case below.
//
// CONSEQUENCE, stated because it bounds what these assertions prove: host and
// member share one process here, so this value is ALSO the host's own fallback
// identity. `claimed_by === CLAIMING_MACHINE` therefore cannot distinguish "the
// member's identity travelled the hop" from "the host defaulted to itself".
// That distinction is gated where it belongs, on the gate path itself —
// `tests/daemon/team-member-tokens.test.ts` asserts the RESOLVED context
// identity is the token's and explicitly NOT `getMachineId()`.
let CLAIMING_MACHINE: string;
let grove: ReturnType<typeof createGrove>;

// The team listener binds an AF_UNIX socket, which host serving requires; it
// refuses to bind on Windows, so there is no transport to exercise there.
const describeTeamTransport = process.platform === 'win32' ? describe.skip : describe;

describeTeamTransport('content claims over the real member -> host transport', () => {
  let tmp: string;
  let mycoHome: string;
  let hostServer: DaemonServer;
  let memberServer: DaemonServer;
  let projectId: string;
  let savedMycoHome: string | undefined;
  let savedTeamHome: string | undefined;
  let memberBase: string;
  let memberAuthToken: string;
  let edge: FunnelEdge;
  let socketPath: string;

let memberToken: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cclaim-overlay-'));
    savedMycoHome = process.env.MYCO_HOME;
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    mycoHome = path.join(tmp, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team-home');
    // A REAL issued member token: the shared host bearer is no longer accepted,
    // so a fixture must hold a credential the host actually issued.
    CLAIMING_MACHINE = getMachineId();
    memberToken = issueTestMemberToken(CLAIMING_MACHINE);
    clearGroveRegistryCaches();

    // --- the host's REAL Grove, project, and seeded skill record ---
    grove = createGrove('Work', mycoHome);
    ensureGroveDatabase(grove.id, mycoHome);
    const databasePath = resolveGroveDbPath(grove.id, mycoHome);
    initDatabase(databasePath);

    projectId = assertGroveProjectId(createProjectId());
    const projectRoot = path.join(tmp, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    registerProjectInGrove(grove.id, { projectId, projectName: 'Work project', projectRoot }, mycoHome);

    registerAgent({ id: 'agent-test', name: 'Test Agent', created_at: Math.floor(Date.now() / 1000) });
    const now = Math.floor(Date.now() / 1000);
    insertSkillRecord({
      id: 'skill-1',
      project_id: projectId,
      agent_id: 'agent-test',
      name: 'skill-1',
      display_name: 'Skill One',
      description: 'A test skill',
      path: '.myco/skills/skill-1.md',
      generation: 1,
      created_at: now,
      updated_at: now,
    });

    // --- host daemon: real overlay listener, real content-claim routes ---
    const hostLogger = new DaemonLogger(path.join(tmp, 'host-logs'));
    socketPath = teamSocketPath('cclaim-host');
    hostServer = new DaemonServer({
      vaultDir: path.join(tmp, 'host-anchor', '.myco'),
      logger: hostLogger,
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
      teamSocketPath: socketPath,
      // servedGroveId designates `grove` as the ONE Grove this host serves —
      // required since Task 2's servedGroveRefusal fail-closed filter now
      // refuses every team request when the designation is absent, even
      // one naming a real, owned Grove.
      hostServe: { bearer: HOST_BEARER, servedGroveId: grove.id },
    });
    registerContentClaimRoutes(hostServer, { machineId: 'host-machine', logger: hostLogger });
    await hostServer.start(0);

    // The public edge in front of the host's socket. The member dials THIS,
    // over real TLS, through the production dialer.
    edge = await startFunnelEdge(socketPath);

    // --- attach the project to the host (member's machine-global registry) ---
    const host: HostRecord = {
      host_id: createHostId(),
      label: 'Test host',
      host_url: edge.url,
      protocol_version: HOST_PROTOCOL_VERSION,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: grove.id, project_id: projectId }],
    };
    writeHostRecordFixture(host);
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, memberToken);

    // --- member daemon: loopback only, no local Grove DB for this project ---
    const memberLogger = new DaemonLogger(path.join(tmp, 'member-logs'));
    memberServer = new DaemonServer({
      vaultDir: path.join(tmp, 'member-anchor', '.myco'),
      logger: memberLogger,
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
    });
    // Registered under the SAME id the proxy stamps for a browser-shaped
    // request, so the member has one identity end to end.
    registerContentClaimRoutes(memberServer, { machineId: CLAIMING_MACHINE, logger: memberLogger });
    await memberServer.start(0);
    memberBase = `http://127.0.0.1:${memberServer.port}`;
    memberAuthToken = memberServer.getAuthToken();
  });

  afterEach(async () => {
    await memberServer.stop();
    await edge.close();
    await hostServer.stop();
    try { closeDatabase(); } catch { /* already closed */ }
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedMycoHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    clearGroveRegistryCaches();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function memberHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'x-myco-project-id': projectId,
      'x-myco-machine-id': CLAIMING_MACHINE,
      'x-myco-auth': memberAuthToken,
      ...extra,
    };
  }

  test('a claim POSTed to the member is served by the real host Grove DB', async () => {
    const res = await fetch(`${memberBase}/api/content-claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...memberHeaders() },
      body: JSON.stringify({ artifact_kind: 'skill', artifact_id: 'skill-1' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { claim: { id: string; claimed_by: string; state: string } };
    expect(body.claim.state).toBe('active');
    expect(body.claim.claimed_by).toBe(CLAIMING_MACHINE);

    // The row is REAL, on the host's OWN grove DB — the proxy relayed bytes,
    // it never wrote anything itself, and the member has no local Grove DB
    // for this project at all.
    const row = getDatabase().prepare(
      `SELECT artifact_id, claimed_by, state FROM content_claims WHERE id = ?`,
    ).get(body.claim.id) as { artifact_id: string; claimed_by: string; state: string } | undefined;
    expect(row).toMatchObject({ artifact_id: 'skill-1', claimed_by: CLAIMING_MACHINE, state: 'active' });

    // A GET over the SAME hop reflects the active claim.
    const listRes = await fetch(`${memberBase}/api/content-claims`, { headers: memberHeaders() });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { active_claims: Array<{ id: string; claimed_by: string }> };
    expect(listBody.active_claims).toHaveLength(1);
    expect(listBody.active_claims[0]).toMatchObject({ id: body.claim.id, claimed_by: CLAIMING_MACHINE });
  });

  test('a claim POSTed to the member with a browser Origin/Referer header still succeeds end-to-end', async () => {
    // The member→host hop is server-to-server; the member's own loopback
    // listener already enforced browser-facing CSRF before this request ever
    // reached the proxy. Without stripping Origin/Referer at the forward, the
    // host's Origin refusal (which rejects ANY Origin) would 403 this —
    // the exact "Claim & materialize" dead-end the dashboard hit live.
    // A real browser dashboard's Origin matches the member's OWN loopback
    // listener (same-origin fetch) — the member's loopback CSRF gate accepts
    // that; it's the HOST's team gate that must never see it.
    const res = await fetch(`${memberBase}/api/content-claims`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...memberHeaders(),
        origin: memberBase,
        referer: `${memberBase}/dashboard`,
      },
      body: JSON.stringify({ artifact_kind: 'skill', artifact_id: 'skill-1' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { claim: { state: string; claimed_by: string } };
    expect(body.claim.state).toBe('active');
    expect(body.claim.claimed_by).toBe(CLAIMING_MACHINE);
  });

  test('a browser-shaped claim (no machine-id header) is attributed to the MEMBER daemon, and the member can release it', async () => {
    // A dashboard fetch carries no x-myco-machine-id. The proxy stamps the
    // member daemon's own machine id at the forward — attribution comes from
    // the caller at the hop, which here is the member. Without the stamp the
    // host handler's fallback resolved to the EXECUTING daemon (the host),
    // so the claim landed as the host's and the member's release 403'd
    // not_holder. (This single-process fixture shares one machine-id cache
    // between the two daemons, so the host-fallback value coincides with
    // the member's — the stamp-vs-fallback distinction is pinned at the
    // forward itself in host-proxy.test.ts; this test proves the
    // live-shaped flow: a browser-shaped claim lands member-attributed and
    // the member's browser-shaped release succeeds.)
    const memberMachineId = getMachineId();
    const res = await fetch(`${memberBase}/api/content-claims`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-myco-project-id': projectId,
        'x-myco-auth': memberAuthToken,
        origin: memberBase,
      },
      body: JSON.stringify({ artifact_kind: 'skill', artifact_id: 'skill-1' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { claim: { id: string; claimed_by: string } };
    expect(body.claim.claimed_by).toBe(memberMachineId);
    expect(body.claim.claimed_by).not.toBe('host-machine');

    // The host Grove row carries the member attribution.
    const row = getDatabase().prepare(
      `SELECT claimed_by FROM content_claims WHERE id = ?`,
    ).get(body.claim.id) as { claimed_by: string } | undefined;
    expect(row?.claimed_by).toBe(memberMachineId);

    // The claiming member's own browser-driven release succeeds (not_holder
    // was the live dead-end).
    const released = await fetch(`${memberBase}/api/content-claims/${body.claim.id}/release`, {
      method: 'POST',
      headers: {
        'x-myco-project-id': projectId,
        'x-myco-auth': memberAuthToken,
        origin: memberBase,
      },
    });
    expect(released.status).toBe(200);
    expect(((await released.json()) as { claim: { state: string } }).claim.state).toBe('released');
  });

  test('a second claim over the transport while the first is active -> 409 already_claimed with holder identity', async () => {
    const first = await fetch(`${memberBase}/api/content-claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...memberHeaders() },
      body: JSON.stringify({ artifact_kind: 'skill', artifact_id: 'skill-1' }),
    });
    expect(first.status).toBe(201);

    // The contender is a SECOND MEMBER, with its own token and its own
    // identity — not this member claiming to be another machine. That
    // distinction is now enforced: a token is bound to the machine_id its
    // member enrolled with, so one member cannot present another's identity,
    // and a fixture that spoofed the header would be testing something the
    // transport no longer permits.
    const otherToken = issueTestMemberToken('a-different-machine');
    const second = await teamFetch(socketPath, '/api/content-claims', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${otherToken}`,
        'x-myco-host-protocol': String(HOST_PROTOCOL_VERSION),
        'x-myco-grove-id': grove.id,
        'x-myco-project-id': projectId,
        'x-myco-machine-id': 'a-different-machine',
      },
      body: JSON.stringify({ artifact_kind: 'skill', artifact_id: 'skill-1' }),
    });
    expect(second.status).toBe(409);
    const body = await second.json() as { error: { code: string }; holder: { claimed_by: string } };
    expect(body.error.code).toBe('already_claimed');
    expect(body.holder.claimed_by).toBe(CLAIMING_MACHINE);

    // Exactly one active row on the host — the ACTIVE-partial unique index
    // serialized the conflict; the proxy hop didn't create a second row.
    const active = getDatabase().prepare(
      `SELECT COUNT(*) AS n FROM content_claims WHERE state = 'active'`,
    ).get() as { n: number };
    expect(active.n).toBe(1);
  });

  test('the request pathname crosses the public edge byte-identical', async () => {
    // Member→host routing keys on exact pathnames (`ROUTE_RULES`,
    // `SERVE_DEFAULT_ROUTES`), so anything that rewrites a path in flight
    // misses the whole stamp table. What this pins is the MEMBER side of that:
    // the proxy's dial reconstructs the path from `host_url` + pathname, and a
    // dropped or doubled segment there would be invisible to a unit test of
    // either half. (The Funnel MOUNT is gated separately, at activation — see
    // `tests/team-host/funnel.test.ts`; a mount change cannot fail this test,
    // because a member never sends a mount prefix in the first place.)
    const created = await fetch(`${memberBase}/api/content-claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...memberHeaders() },
      body: JSON.stringify({ artifact_kind: 'skill', artifact_id: 'skill-1' }),
    });
    expect(created.status).toBe(201);
    const claimId = ((await created.json()) as { claim: { id: string } }).claim.id;

    // A DISTINCTIVE nested path, so a prefix strip could not coincidentally
    // still match: `/api/content-claims/<id>/release` has three segments below
    // the root and an id no rewrite could reconstruct.
    const releasePath = `/api/content-claims/${claimId}/release`;
    const released = await fetch(`${memberBase}${releasePath}`, {
      method: 'POST',
      headers: memberHeaders(),
    });
    expect(released.status).toBe(200);

    expect(edge.seenPaths).toContain('/api/content-claims');
    expect(edge.seenPaths).toContain(releasePath);
  });

  test('release over the transport frees the artifact for a new claim', async () => {
    const created = await fetch(`${memberBase}/api/content-claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...memberHeaders() },
      body: JSON.stringify({ artifact_kind: 'skill', artifact_id: 'skill-1' }),
    });
    const claimId = ((await created.json()) as { claim: { id: string } }).claim.id;

    const released = await fetch(`${memberBase}/api/content-claims/${claimId}/release`, {
      method: 'POST',
      headers: memberHeaders(),
    });
    expect(released.status).toBe(200);
    expect(((await released.json()) as { claim: { state: string } }).claim.state).toBe('released');

    // A DIFFERENT member picks it up — again as itself, with its own token.
    const otherToken = issueTestMemberToken('a-different-machine');
    const reclaim = await teamFetch(socketPath, '/api/content-claims', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${otherToken}`,
        'x-myco-host-protocol': String(HOST_PROTOCOL_VERSION),
        'x-myco-grove-id': grove.id,
        'x-myco-project-id': projectId,
        'x-myco-machine-id': 'a-different-machine',
      },
      body: JSON.stringify({ artifact_kind: 'skill', artifact_id: 'skill-1' }),
    });
    expect(reclaim.status).toBe(201);
  });
});
