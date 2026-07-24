/**
 * Team Host membership lifecycle daemon API (consolidation Task D-2):
 *
 *   POST /api/host-membership/join|leave|attach|detach
 *   GET  /api/host-membership/status
 *
 * Each mutation handler is a thin wire-mapping layer over the orchestration
 * functions (`host/member-overlay.ts`, `host/attach-command.ts`), which are
 * already exhaustively covered by `tests/cli/member-overlay.test.ts` and
 * `tests/host/attach-command.test.ts` — these tests inject fakes for those
 * functions and assert only the route's OWN job: body → options mapping,
 * result → wire-body mapping, and error → 400 mapping. `status` is tested
 * against the real `readHostRegistry()`/manifest-hint read (no orchestration
 * to fake).
 */
import { writeHostRecordFixture } from '../../helpers/host-registry-fixture.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';

import { clearProjectManifestCache } from '@myco/config/project-manifest.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import { createGrove } from '@myco/grove/registry.js';
import { createGroveId, createHostId, createProjectId } from '@myco/grove/ids.js';
import { codedMembershipError } from '@myco/host/membership-error.js';
import { HOST_PROTOCOL_VERSION } from '@myco/constants.js';
import { getHost, type HostRecord } from '@myco/host/registry.js';
import { RESIDENCY_MIN_HOST_PROTOCOL } from '@myco/host/residency-journal.js';
import {
  classifyHostProtocolSkew,
  createHostMembershipAttachHandler,
  createHostMembershipDetachHandler,
  createHostMembershipHealthHandler,
  createHostMembershipJoinHandler,
  createHostMembershipLeaveHandler,
  createHostMembershipStatusHandler,
  registerHostMembershipRoutes,
} from '@myco/daemon/api/host-membership.js';
import type { RouteRequest } from '@myco/daemon/router.js';

function req(body: unknown, query: Record<string, string> = {}): RouteRequest {
  return { body, query, params: {}, pathname: '/api/host-membership/x' };
}

function makeHost(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    host_id: createHostId(),
    label: 'Mac Studio',
    overlay_address: '100.64.0.1:7433',
    proxy_port: 41200,
    protocol_version: 1,
    created_at: new Date().toISOString(),
    projects: [],
    ...overrides,
  };
}

describe('POST /api/host-membership/join', () => {
  test('maps snake_case body to JoinOptions and the result to snake_case wire fields', async () => {
    let seen: unknown;
    const handler = createHostMembershipJoinHandler({
      join: async (options) => {
        seen = options;
        return {
          hostId: options.hostId ?? options.hostRef,
          overlayAddress: '100.64.0.1:7433',
          proxyPort: 41200,
          memberOverlayIp: '100.64.0.5',
          hostReachable: true,
          created: true,
          notes: ['note-1'],
        };
      },
    });

    const res = await handler(req({
      host_ref: 'host_abc', key: 'onetime', server_url: 'https://h:8080',
      hostname: 'my-mac', overlay_address: '100.64.0.1:7433', bearer: 'b',
      protocol_version: 1, host_id: 'host_abc', label: 'Mac Studio',
    }));

    expect(seen).toEqual({
      hostRef: 'host_abc', key: 'onetime', serverUrl: 'https://h:8080',
      hostname: 'my-mac', overlayAddress: '100.64.0.1:7433', bearer: 'b',
      protocolVersion: 1, hostId: 'host_abc', label: 'Mac Studio',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      host_id: 'host_abc', overlay_address: '100.64.0.1:7433', proxy_port: 41200,
      member_overlay_ip: '100.64.0.5', host_reachable: true, created: true, notes: ['note-1'],
      steps: [],
    });
  });

  test('collects joinHost\'s step log via the injected logger and returns it as `steps` (the CLI replays it post-POST)', async () => {
    const handler = createHostMembershipJoinHandler({
      join: async (options, deps) => {
        deps?.logger?.('Provisioning Tailscale for darwin/arm64…');
        deps?.logger?.('Joining the overlay with the one-time key…');
        return {
          hostId: options.hostRef, overlayAddress: 'a', proxyPort: 1,
          memberOverlayIp: 'ip', hostReachable: true, created: true, notes: [],
        };
      },
    });
    const res = await handler(req({ host_ref: 'host_abc', key: 'k' }));
    expect((res.body as { steps: string[] }).steps).toEqual([
      'Provisioning Tailscale for darwin/arm64…',
      'Joining the overlay with the one-time key…',
    ]);
  });

  test('missing host_ref/key are rejected client-side (never call join)', async () => {
    let called = false;
    const handler = createHostMembershipJoinHandler({ join: async () => { called = true; throw new Error('unreachable'); } });

    const noHost = await handler(req({ key: 'k' }));
    expect(noHost.status).toBe(400);
    const noKey = await handler(req({ host_ref: 'h' }));
    expect(noKey.status).toBe(400);
    expect(called).toBe(false);
  });

  test.each([
    ['server_url', {}],
    ['hostname', []],
    ['overlay_address', {}],
    ['bearer', {}],
    ['protocol_version', '3'],
    ['host_id', 3],
    ['label', false],
  ])('rejects a present wrong-type optional %s before calling join', async (field, value) => {
    let calls = 0;
    const handler = createHostMembershipJoinHandler({
      join: async () => { calls += 1; throw new Error('unreachable'); },
    });

    const res = await handler(req({ host_ref: 'host_abc', key: 'onetime', [field]: value }));

    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('host_enroll_failed');
    expect(calls).toBe(0);
  });

  test('preserves an explicit empty bearer so joinHost selects the manual enrollment path', async () => {
    let seen: { bearer?: string } | undefined;
    const handler = createHostMembershipJoinHandler({
      join: async (options) => {
        seen = options;
        return {
          hostId: options.hostRef,
          overlayAddress: '100.64.0.1:7433',
          proxyPort: 41200,
          memberOverlayIp: '100.64.0.5',
          hostReachable: false,
          created: true,
          notes: [],
        };
      },
    });

    const res = await handler(req({ host_ref: 'host_abc', key: 'onetime', bearer: '' }));

    expect(res.status).toBe(200);
    expect(seen?.bearer).toBe('');
  });

  test.each([
    ['host_ref', {}],
    ['key', []],
  ])('preserves the missing required-field envelope for a wrong-type %s', async (field, value) => {
    let calls = 0;
    const handler = createHostMembershipJoinHandler({
      join: async () => { calls += 1; throw new Error('unreachable'); },
    });

    const res = await handler(req({ host_ref: 'host_abc', key: 'onetime', [field]: value }));

    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(field === 'host_ref' ? 'missing_host_ref' : 'missing_key');
    expect(calls).toBe(0);
  });

  test('an UNCODED orchestration error maps to 400 with the route fallback code + message preserved', async () => {
    const handler = createHostMembershipJoinHandler({
      join: async () => { throw new Error('tailscaled socket did not appear'); },
    });
    const res = await handler(req({ host_ref: 'h', key: 'k' }));
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string; message: string } }).error).toEqual({
      code: 'join_failed', message: 'tailscaled socket did not appear',
    });
  });

  test('a CODED orchestration error surfaces its stable membership code (protocol_mismatch), not the fallback', async () => {
    const handler = createHostMembershipJoinHandler({
      join: async () => {
        throw codedMembershipError(
          'protocol_mismatch',
          'The host rejected enrollment with a protocol-version mismatch (409). This member speaks Team-Host protocol v1; run `myco update` so both sides match, then retry.',
        );
      },
    });
    const res = await handler(req({ host_ref: 'h', key: 'k' }));
    expect(res.status).toBe(400);
    const error = (res.body as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('protocol_mismatch');
    // The CLI-voiced message still travels (terminals print it verbatim);
    // the UI keys on the code and never renders it.
    expect(error.message).toContain('protocol-version mismatch');
  });
});

describe('POST /api/host-membership/leave', () => {
  test('maps host_ref through and the result to snake_case', async () => {
    let seenHostRef: string | undefined;
    const handler = createHostMembershipLeaveHandler({
      leave: async (hostRef) => { seenHostRef = hostRef; return { removed: true, tailscaledRemoved: true, notes: [] }; },
    });
    const res = await handler(req({ host_ref: 'host_abc' }));
    expect(seenHostRef).toBe('host_abc');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true, tailscaled_removed: true, notes: [] });
  });

  test('missing host_ref is rejected client-side', async () => {
    const handler = createHostMembershipLeaveHandler({ leave: async () => { throw new Error('unreachable'); } });
    const res = await handler(req({}));
    expect(res.status).toBe(400);
  });

  test('idempotent leave (removed: false) still returns 200', async () => {
    const handler = createHostMembershipLeaveHandler({
      leave: async () => ({ removed: false, tailscaledRemoved: false, notes: [] }),
    });
    const res = await handler(req({ host_ref: 'unknown' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: false, tailscaled_removed: false, notes: [] });
  });
});

describe('POST /api/host-membership/attach', () => {
  test('maps project_root/host_id and the result to snake_case (no grove_id in the request — the daemon sources it from the host record)', async () => {
    let seen: unknown;
    const handler = createHostMembershipAttachHandler({
      attach: (options) => {
        seen = options;
        return {
          projectId: 'proj_x', groveId: 'grove_x', hostId: options.hostId!,
          hostLabel: 'Mac Studio', root: '/checkout', alreadyAttached: false, notes: [],
        };
      },
      mycoHome: '/tmp/myco-home',
    });
    const res = await handler(req({ project_root: '/checkout', host_id: 'host_abc' }));

    expect(seen).toEqual({
      projectPath: '/checkout', hostId: 'host_abc', projectId: undefined,
      localGroveId: undefined, mycoHome: '/tmp/myco-home',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      project_id: 'proj_x', grove_id: 'grove_x', host_id: 'host_abc',
      host_label: 'Mac Studio', root: '/checkout', already_attached: false, notes: [],
    });
  });

  test('missing project_root is rejected client-side (never calls attach)', async () => {
    let called = false;
    const handler = createHostMembershipAttachHandler({ attach: () => { called = true; throw new Error('unreachable'); } });
    expect((await handler(req({ host_id: 'host_abc' }))).status).toBe(400);
    expect(called).toBe(false);
  });

  test('a CODED host_predates_served_grove refusal surfaces its stable code — attachCommand throws it when the host has no served_grove_id', async () => {
    const handler = createHostMembershipAttachHandler({
      attach: () => {
        throw codedMembershipError(
          'host_predates_served_grove',
          'Host host_abc predates served-grove designation; update the host (run `myco update` on that '
          + 'machine, then re-enable Team Host serving) and re-join with `myco join host_abc`, then retry attach.',
        );
      },
      mycoHome: '/tmp/myco-home',
    });
    const res = await handler(req({ project_root: '/checkout', host_id: 'host_abc' }));
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('host_predates_served_grove');
    expect((res.body as { error: { message: string } }).error.message).toContain('update the host');
  });

  test('an UNCODED attach error maps to 400 with the route fallback code', async () => {
    const handler = createHostMembershipAttachHandler({
      attach: () => { throw new Error('Could not determine the project id for /checkout.'); },
    });
    const res = await handler(req({ project_root: '/checkout' }));
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('attach_failed');
  });

  test('maps an explicit local_grove_id from the body into AttachOptions.localGroveId (a distinct Grove concept from grove_id — the member\'s own local Grove, E-4 local-view requirement)', async () => {
    let seen: unknown;
    const handler = createHostMembershipAttachHandler({
      attach: (options) => {
        seen = options;
        return {
          projectId: 'proj_x', groveId: 'grove_x', hostId: options.hostId!,
          hostLabel: 'Mac Studio', root: '/checkout', alreadyAttached: false, notes: [],
        };
      },
      mycoHome: '/tmp/myco-home',
    });
    await handler(req({ project_root: '/checkout', host_id: 'host_abc', local_grove_id: 'grove_local_1' }));

    expect(seen).toEqual({
      projectPath: '/checkout', hostId: 'host_abc', projectId: undefined,
      localGroveId: 'grove_local_1', mycoHome: '/tmp/myco-home',
    });
  });

  test('an omitted local_grove_id maps to undefined in AttachOptions — attachCommand itself resolves the default', async () => {
    let seen: unknown;
    const handler = createHostMembershipAttachHandler({
      attach: (options) => {
        seen = options;
        return {
          projectId: 'proj_x', groveId: 'grove_x', hostId: options.hostId!,
          hostLabel: 'Mac Studio', root: '/checkout', alreadyAttached: false, notes: [],
        };
      },
      mycoHome: '/tmp/myco-home',
    });
    await handler(req({ project_root: '/checkout', host_id: 'host_abc' }));

    expect((seen as { localGroveId?: string }).localGroveId).toBeUndefined();
  });

  test('a CODED unknown_local_grove refusal surfaces its stable code — attachCommand throws it when an explicit local_grove_id names no existing local Grove', async () => {
    const handler = createHostMembershipAttachHandler({
      attach: () => {
        throw codedMembershipError(
          'unknown_local_grove',
          'Unknown local Grove grove_ghost — this machine has no Grove with that id. Pass an existing local '
          + 'Grove id, or omit local_grove_id to use the machine\'s default Grove.',
        );
      },
      mycoHome: '/tmp/myco-home',
    });
    const res = await handler(req({ project_root: '/checkout', host_id: 'host_abc', local_grove_id: 'grove_ghost' }));
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('unknown_local_grove');
    expect((res.body as { error: { message: string } }).error.message).toContain('Unknown local Grove grove_ghost');
  });

  test('a CODED attach refusal surfaces its stable membership code — the UI keys copy on it, never the CLI-voiced message', async () => {
    const handler = createHostMembershipAttachHandler({
      attach: () => {
        // The real mapAttachError output for ProjectRegisteredLocallyError —
        // message references `myco detach`-style remediation and "task A2",
        // both fine for a terminal, neither renderable in the Team page.
        throw codedMembershipError(
          'project_registered_locally',
          'Cannot attach proj_x: it still has local Grove data (Grove grove_y). Adopting existing local '
          + 'history into a team host requires the residency-transition migration, which is not yet '
          + 'available (task A2). This command attaches a project going forward only — detach/migrate '
          + 'the project off its local Grove first.',
        );
      },
    });
    const res = await handler(req({ project_root: '/checkout' }));
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('project_registered_locally');
  });
});

describe('POST /api/host-membership/detach', () => {
  test('maps project_root through and the result to snake_case', async () => {
    let seen: unknown;
    const handler = createHostMembershipDetachHandler({
      detach: (options) => { seen = options; return { projectId: 'proj_x', detachedFromHostId: 'host_abc' }; },
    });
    const res = await handler(req({ project_root: '/checkout' }));
    expect(seen).toEqual({ projectPath: '/checkout', projectId: undefined, beginDetachResidency: undefined, allowNoPull: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ project_id: 'proj_x', detached_from_host_id: 'host_abc' });
  });

  test('a no-op detach (not attached anywhere) still returns 200 with a null host', async () => {
    const handler = createHostMembershipDetachHandler({
      detach: () => ({ projectId: 'proj_x', detachedFromHostId: null }),
    });
    const res = await handler(req({ project_root: '/checkout' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ project_id: 'proj_x', detached_from_host_id: null });
  });

  test('missing project_root is rejected client-side', async () => {
    const handler = createHostMembershipDetachHandler({ detach: () => { throw new Error('unreachable'); } });
    expect((await handler(req({}))).status).toBe(400);
  });
});

describe('GET /api/host-membership/status', () => {
  let teamHome: string;
  let savedTeamHome: string | undefined;
  // A dedicated MYCO_HOME (distinct from teamHome) for the LOCAL Grove
  // registry `local_grove_id` resolution reads — passed explicitly via
  // `{ mycoHome: home }` rather than a process.env override, so each test's
  // Groves are deterministic and never bleed into the shared sandbox home
  // the test-preload redirects os.homedir() to.
  let home: string;

  beforeEach(() => {
    teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-membership-status-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = teamHome;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-membership-status-home-'));
  });
  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(teamHome, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    clearProjectManifestCache();
  });

  function makeCheckout(projectId: string, hintHostId?: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-membership-proj-'));
    const vaultDir = resolveProjectVaultDir(root);
    fs.mkdirSync(vaultDir, { recursive: true });
    const doc: Record<string, unknown> = { project: { id: projectId, name: 'demo' } };
    if (hintHostId) doc.grove = { remote: { provider: 'team-host', remote_id: hintHostId } };
    fs.writeFileSync(path.join(vaultDir, 'project.toml'), stringify(doc), 'utf-8');
    clearProjectManifestCache();
    return root;
  }

  test('no joined hosts → empty array, no hint without project_root', async () => {
    const handler = createHostMembershipStatusHandler({ mycoHome: home });
    const res = await handler(req({}, {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hosts: [], hint: null });
  });

  test('every joined host appears with its attach refs, including the resolved local_grove_id (no bearer/secret leaks)', async () => {
    const defaultGrove = createGrove('Default', home);
    const groveId = createGroveId();
    const projectId = createProjectId();
    // No explicit local_grove_id on this ref — a legacy shape — so it
    // resolves to the machine's current default Grove.
    const host = makeHost({ projects: [{ grove_id: groveId, project_id: projectId, root: '/checkout' }] });
    writeHostRecordFixture(host);

    const handler = createHostMembershipStatusHandler({ mycoHome: home });
    const res = await handler(req({}, {}));
    expect(res.body).toEqual({
      hosts: [{
        host_id: host.host_id, label: host.label, overlay_address: host.overlay_address,
        proxy_port: host.proxy_port, protocol_version: host.protocol_version,
        served_grove_id: null, created_at: host.created_at,
        projects: [{
          grove_id: groveId, project_id: projectId, root: '/checkout',
          local_grove_id: defaultGrove.id, mismatch: null,
        }],
      }],
      hint: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('bearer');
  });

  test('an explicit local_grove_id naming an existing local Grove resolves to itself, even when it is not the default Grove', async () => {
    createGrove('Default', home);
    const chosen = createGrove('Personal', home);
    const groveId = createGroveId();
    const projectId = createProjectId();
    const host = makeHost({
      projects: [{ grove_id: groveId, project_id: projectId, root: '/checkout', local_grove_id: chosen.id }],
    });
    writeHostRecordFixture(host);

    const handler = createHostMembershipStatusHandler({ mycoHome: home });
    const res = await handler(req({}, {}));
    const body = res.body as { hosts: { projects: { local_grove_id: string | null }[] }[] };
    expect(body.hosts[0]!.projects[0]!.local_grove_id).toBe(chosen.id);
  });

  test('a dangling local_grove_id (the chosen Grove was deleted after attach) falls back to the current default Grove', async () => {
    const defaultGrove = createGrove('Default', home);
    const danglingGroveId = createGroveId(); // never created in `home` — simulates a deleted Grove.
    const groveId = createGroveId();
    const projectId = createProjectId();
    const host = makeHost({
      projects: [{ grove_id: groveId, project_id: projectId, root: '/checkout', local_grove_id: danglingGroveId }],
    });
    writeHostRecordFixture(host);

    const handler = createHostMembershipStatusHandler({ mycoHome: home });
    const res = await handler(req({}, {}));
    const body = res.body as { hosts: { projects: { local_grove_id: string | null }[] }[] };
    expect(body.hosts[0]!.projects[0]!.local_grove_id).toBe(defaultGrove.id);
  });

  test('a ref whose grove_id no longer matches the host\'s served_grove_id is flagged attach_grove_mismatch (spec §2 existing-refs mitigation (c))', async () => {
    const servedGroveId = createGroveId();
    const staleGroveId = createGroveId();
    const matchingProjectId = createProjectId();
    const staleProjectId = createProjectId();
    const host = makeHost({
      served_grove_id: servedGroveId,
      projects: [
        { grove_id: servedGroveId, project_id: matchingProjectId, root: '/checkout-a' },
        { grove_id: staleGroveId, project_id: staleProjectId, root: '/checkout-b' },
      ],
    });
    writeHostRecordFixture(host);

    const handler = createHostMembershipStatusHandler({ mycoHome: home });
    const res = await handler(req({}, {}));
    const body = res.body as { hosts: { served_grove_id: string | null; projects: { project_id: string; mismatch: string | null }[] }[] };
    expect(body.hosts[0]!.served_grove_id).toBe(servedGroveId);
    const matching = body.hosts[0]!.projects.find((p) => p.project_id === matchingProjectId);
    const stale = body.hosts[0]!.projects.find((p) => p.project_id === staleProjectId);
    expect(matching?.mismatch).toBeNull();
    expect(stale?.mismatch).toBe('attach_grove_mismatch');
  });

  test('served_grove_id unknown (host predates designation) → no ref is flagged, not even one that would mismatch once it IS known', async () => {
    const host = makeHost({
      served_grove_id: undefined,
      projects: [{ grove_id: createGroveId(), project_id: createProjectId(), root: '/checkout' }],
    });
    writeHostRecordFixture(host);

    const handler = createHostMembershipStatusHandler({ mycoHome: home });
    const res = await handler(req({}, {}));
    const body = res.body as { hosts: { served_grove_id: string | null; projects: { mismatch: string | null }[] }[] };
    expect(body.hosts[0]!.served_grove_id).toBeNull();
    expect(body.hosts[0]!.projects[0]!.mismatch).toBeNull();
  });

  test('project_root with an unresolved hint (host not joined) surfaces the hint', async () => {
    const hintedHostId = createHostId();
    const projectId = createProjectId();
    const root = makeCheckout(projectId, hintedHostId);

    const handler = createHostMembershipStatusHandler({ mycoHome: home });
    const res = await handler(req({}, { project_root: root }));
    const body = res.body as { hint: { host_id: string; state: string; message: string } | null };
    expect(body.hint).not.toBeNull();
    expect(body.hint!.host_id).toBe(hintedHostId);
    expect(body.hint!.state).toBe('not_joined');
    expect(body.hint!.message).toContain(`myco join ${hintedHostId}`);
  });

  test('project_root for a project already attached (hint resolved) omits the hint', async () => {
    const host = makeHost();
    writeHostRecordFixture(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId, host.host_id);
    // Attach it — resolveTeamHostHintState reads resolveAttach, not the raw hint.
    const { attachProject } = await import('@myco/host/registry.js');
    attachProject(host.host_id, { grove_id: createGroveId(), project_id: projectId, root });

    const handler = createHostMembershipStatusHandler({ mycoHome: home });
    const res = await handler(req({}, { project_root: root }));
    expect((res.body as { hint: unknown }).hint).toBeNull();
  });

  test('project_root pointing at a directory with no manifest degrades to no hint, not an error', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-membership-bare-'));
    const handler = createHostMembershipStatusHandler({ mycoHome: home });
    const res = await handler(req({}, { project_root: bare }));
    expect(res.status).toBe(200);
    expect((res.body as { hint: unknown }).hint).toBeNull();
    fs.rmSync(bare, { recursive: true, force: true });
  });
});

describe('classifyHostProtocolSkew', () => {
  test('within [HOST_MIN_COMPAT_VERSION, HOST_PROTOCOL_VERSION] → none', () => {
    expect(classifyHostProtocolSkew(1)).toBe('none');
    expect(classifyHostProtocolSkew(2)).toBe('none');
    expect(classifyHostProtocolSkew(HOST_PROTOCOL_VERSION)).toBe('none');
  });

  test('above HOST_PROTOCOL_VERSION → host_newer (this member needs myco update)', () => {
    expect(classifyHostProtocolSkew(HOST_PROTOCOL_VERSION + 1)).toBe('host_newer');
  });

  test('below HOST_MIN_COMPAT_VERSION → host_older (that host needs myco update)', () => {
    expect(classifyHostProtocolSkew(0)).toBe('host_older');
  });
});

describe('GET /api/host-membership/health', () => {
  /** A promise the test controls the settlement of, to simulate an in-flight probe. */
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  test('no joined hosts → empty array, never calls the probe', async () => {
    let called = false;
    const handler = createHostMembershipHealthHandler({
      readRegistry: () => [],
      checkReachable: async () => { called = true; return { reachable: true, protocolVersion: null }; },
    });
    const res = await handler(req({}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hosts: [] });
    expect(called).toBe(false);
  });

  test('a host with no proxy_port on record → reachable: null, the probe is never invoked (doctor\'s "not confirmable" branch)', async () => {
    let called = false;
    const host = makeHost({ proxy_port: undefined });
    const handler = createHostMembershipHealthHandler({
      readRegistry: () => [host],
      checkReachable: async () => { called = true; return { reachable: true, protocolVersion: null }; },
    });
    const res = await handler(req({}));
    const body = res.body as { hosts: { host_id: string; reachable: boolean | null }[] };
    expect(body.hosts).toEqual([expect.objectContaining({ host_id: host.host_id, reachable: null })]);
    expect(called).toBe(false);
  });

  test('probes every joined host concurrently and reports protocol_skew + checked_at', async () => {
    const seen: { address: string; port: number }[] = [];
    const hostReachable = makeHost({ overlay_address: '100.64.0.1:7433', proxy_port: 1, protocol_version: 1 });
    const hostUnreachable = makeHost({ overlay_address: '100.64.0.2:7433', proxy_port: 2, protocol_version: HOST_PROTOCOL_VERSION + 1 });
    const handler = createHostMembershipHealthHandler({
      readRegistry: () => [hostReachable, hostUnreachable],
      checkReachable: async (address, port) => {
        seen.push({ address, port });
        return { reachable: address === hostReachable.overlay_address, protocolVersion: null };
      },
      now: () => 1_700_000_000_000,
    });

    const res = await handler(req({}));
    const body = res.body as { hosts: { host_id: string; reachable: boolean | null; checked_at: string; protocol_skew: string }[] };
    expect(body.hosts).toHaveLength(2);
    const reachableEntry = body.hosts.find((h) => h.host_id === hostReachable.host_id)!;
    const unreachableEntry = body.hosts.find((h) => h.host_id === hostUnreachable.host_id)!;
    expect(reachableEntry.reachable).toBe(true);
    expect(reachableEntry.protocol_skew).toBe('none');
    expect(reachableEntry.checked_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(unreachableEntry.reachable).toBe(false);
    expect(unreachableEntry.protocol_skew).toBe('host_newer');
    // Both dialed — concurrent fan-out, not serialized.
    expect(seen).toHaveLength(2);
  });

  test('a probe that rejects classifies reachable: false (fail-closed), never throws out of the handler', async () => {
    const host = makeHost({ proxy_port: 1 });
    const handler = createHostMembershipHealthHandler({
      readRegistry: () => [host],
      checkReachable: async () => { throw new Error('ECONNRESET'); },
    });
    const res = await handler(req({}));
    const body = res.body as { hosts: { reachable: boolean | null }[] };
    expect(body.hosts[0]!.reachable).toBe(false);
  });

  test('TTL cache: a second call within the TTL returns the cached result with ZERO new probe invocations', async () => {
    const host = makeHost({ proxy_port: 1 });
    let callCount = 0;
    let clock = 1_700_000_000_000;
    const handler = createHostMembershipHealthHandler({
      readRegistry: () => [host],
      checkReachable: async () => { callCount += 1; return { reachable: true, protocolVersion: null }; },
      now: () => clock,
      ttlMs: 15_000,
    });

    await handler(req({}));
    expect(callCount).toBe(1);

    clock += 10_000; // still inside the 15s TTL
    const res2 = await handler(req({}));
    expect(callCount).toBe(1); // no new probe
    expect((res2.body as { hosts: { reachable: boolean | null }[] }).hosts[0]!.reachable).toBe(true);

    clock += 10_000; // now 20s since the first probe — past the TTL
    await handler(req({}));
    expect(callCount).toBe(2); // re-probed
  });

  test('single-flight: two overlapping requests for the same host share ONE in-flight probe', async () => {
    const host = makeHost({ proxy_port: 1 });
    let callCount = 0;
    const gate = deferred<{ reachable: boolean; protocolVersion: number | null }>();
    const handler = createHostMembershipHealthHandler({
      readRegistry: () => [host],
      checkReachable: async () => { callCount += 1; return gate.promise; },
    });

    const first = handler(req({}));
    const second = handler(req({}));
    // Let both requests reach the probe call before it settles.
    await new Promise((r) => setTimeout(r, 0));
    expect(callCount).toBe(1);

    gate.resolve({ reachable: true, protocolVersion: null });
    const [res1, res2] = await Promise.all([first, second]);
    expect(callCount).toBe(1);
    expect((res1.body as { hosts: { reachable: boolean | null }[] }).hosts[0]!.reachable).toBe(true);
    expect((res2.body as { hosts: { reachable: boolean | null }[] }).hosts[0]!.reachable).toBe(true);
  });

  test('evictHost clears both the cache AND an in-flight probe entry for that host only', async () => {
    const hostA = makeHost({ host_id: 'host_a', proxy_port: 1 });
    const hostB = makeHost({ host_id: 'host_b', proxy_port: 1 });
    let callCount = 0;
    const handler = createHostMembershipHealthHandler({
      readRegistry: () => [hostA, hostB],
      checkReachable: async () => { callCount += 1; return { reachable: true, protocolVersion: null }; },
    });

    await handler(req({}));
    expect(callCount).toBe(2);

    // Still within the TTL — a second call would normally short-circuit both
    // hosts to their cached result with zero new probes.
    handler.evictHost('host_a');
    await handler(req({}));
    // host_a was evicted (re-probed); host_b's cache entry is untouched.
    expect(callCount).toBe(3);
  });

  test('evictHost is a no-op for a host with nothing cached', () => {
    const handler = createHostMembershipHealthHandler({ readRegistry: () => [] });
    expect(() => handler.evictHost('host_never_probed')).not.toThrow();
  });
});

describe('health probe — records a host upgrade so residency gates stop dead-ending (live-rig fix)', () => {
  let teamHome: string;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-protocol-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = teamHome;
  });
  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(teamHome, { recursive: true, force: true });
  });

  test('a probe that observes a HIGHER protocol version persists it (monotonic) — the residency gate then passes', async () => {
    const host = makeHost({ protocol_version: 2, proxy_port: 1 }); // recorded at join = 2
    writeHostRecordFixture(host);
    const handler = createHostMembershipHealthHandler({
      readRegistry: () => [host],
      checkReachable: async () => ({ reachable: true, protocolVersion: 3 }), // host has upgraded to 3
    });

    const res = await handler(req({}));

    // Persisted, so the residency gate (recorded >= RESIDENCY_MIN_HOST_PROTOCOL) now passes.
    expect(getHost(host.host_id)?.protocol_version).toBe(3);
    expect(getHost(host.host_id)!.protocol_version).toBeGreaterThanOrEqual(RESIDENCY_MIN_HOST_PROTOCOL);
    // Skew is classified from the fresh version.
    const body = res.body as { hosts: { protocol_skew: string }[] };
    expect(body.hosts[0].protocol_skew).toBe('none');
  });

  test('a probe that observes a LOWER version never downgrades the record', async () => {
    const host = makeHost({ protocol_version: 3, proxy_port: 1 });
    writeHostRecordFixture(host);
    const handler = createHostMembershipHealthHandler({
      readRegistry: () => [host],
      checkReachable: async () => ({ reachable: true, protocolVersion: 1 }),
    });

    await handler(req({}));

    expect(getHost(host.host_id)?.protocol_version).toBe(3); // unchanged — a transient low reading never strands the member
  });
});

describe('Health cache eviction on leave (family c, E-4 W2 Task 7)', () => {
  test('createHostMembershipLeaveHandler evicts the health cache for the left host via evictHealthCache', async () => {
    const evicted: string[] = [];
    const handler = createHostMembershipLeaveHandler({
      leave: async () => ({ removed: true, tailscaledRemoved: true, notes: [] }),
      evictHealthCache: (hostId) => { evicted.push(hostId); },
    });

    await handler(req({ host_ref: 'host_abc' }));
    expect(evicted).toEqual(['host_abc']);
  });

  test('a failed leave does NOT evict the health cache', async () => {
    const evicted: string[] = [];
    const handler = createHostMembershipLeaveHandler({
      leave: async () => { throw new Error('unreachable'); },
      evictHealthCache: (hostId) => { evicted.push(hostId); },
    });

    const res = await handler(req({ host_ref: 'host_abc' }));
    expect(res.status).toBe(400);
    expect(evicted).toEqual([]);
  });

  test('with no evictHealthCache wired (a bare createHostMembershipLeaveHandler), leave is a no-op on the cache — never throws', async () => {
    const handler = createHostMembershipLeaveHandler({
      leave: async () => ({ removed: true, tailscaledRemoved: true, notes: [] }),
    });
    const res = await handler(req({ host_ref: 'host_abc' }));
    expect(res.status).toBe(200);
  });

  test('registerHostMembershipRoutes wires the SAME health-handler instance into leave — end to end: health → leave → re-probed; other hosts keep their TTL', async () => {
    const hostA = makeHost({ host_id: 'host_a', proxy_port: 1 });
    const hostB = makeHost({ host_id: 'host_b', proxy_port: 1 });
    let callCount = 0;
    const routes = new Map<string, (req: RouteRequest) => Promise<unknown>>();
    const registrar = {
      registerRoute(method: string, routePath: string, routeHandler: (req: RouteRequest) => Promise<unknown>) {
        routes.set(`${method} ${routePath}`, routeHandler);
      },
    };

    registerHostMembershipRoutes(registrar, {
      readRegistry: () => [hostA, hostB],
      checkReachable: async () => { callCount += 1; return { reachable: true, protocolVersion: null }; },
      leave: async (hostRef) => ({ removed: true, tailscaledRemoved: true, notes: [`left ${hostRef}`] }),
    });

    const health = routes.get('GET /api/host-membership/health')!;
    const leave = routes.get('POST /api/host-membership/leave')!;

    await health(req({}));
    expect(callCount).toBe(2);

    // Still within the TTL: a bare re-probe would short-circuit BOTH hosts.
    await health(req({}));
    expect(callCount).toBe(2);

    await leave(req({ host_ref: 'host_a' }));

    // host_a's cache/inflight entries were evicted by the shared handler ->
    // re-probed; host_b's TTL entry survives untouched (still 1 new call,
    // not 2).
    await health(req({}));
    expect(callCount).toBe(3);
  });
});
