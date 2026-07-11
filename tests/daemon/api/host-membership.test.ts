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
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';

import { clearProjectManifestCache } from '@myco/config/project-manifest.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import { createGroveId, createHostId, createProjectId } from '@myco/grove/ids.js';
import { codedMembershipError } from '@myco/host/membership-error.js';
import { upsertHost, type HostRecord } from '@myco/host/registry.js';
import {
  createHostMembershipAttachHandler,
  createHostMembershipDetachHandler,
  createHostMembershipJoinHandler,
  createHostMembershipLeaveHandler,
  createHostMembershipStatusHandler,
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
  test('maps project_root/grove_id/host_id and the result to snake_case', async () => {
    let seen: unknown;
    const handler = createHostMembershipAttachHandler({
      attach: (options) => {
        seen = options;
        return {
          projectId: 'proj_x', groveId: options.groveId!, hostId: options.hostId!,
          hostLabel: 'Mac Studio', root: '/checkout', alreadyAttached: false, notes: [],
        };
      },
      mycoHome: '/tmp/myco-home',
    });
    const res = await handler(req({ project_root: '/checkout', host_id: 'host_abc', grove_id: 'grove_x' }));

    expect(seen).toEqual({
      projectPath: '/checkout', hostId: 'host_abc', groveId: 'grove_x', projectId: undefined, mycoHome: '/tmp/myco-home',
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
    expect((await handler(req({ grove_id: 'g' }))).status).toBe(400);
    expect(called).toBe(false);
  });

  test('missing grove_id is NOT pre-validated here — it passes through to attachCommand, whose own richer message surfaces', async () => {
    const handler = createHostMembershipAttachHandler({
      attach: () => { throw new Error("attach requires --grove <groveId> — the id of the Grove on host host_abc that will serve this project."); },
      mycoHome: '/tmp/myco-home',
    });
    const res = await handler(req({ project_root: '/checkout', host_id: 'host_abc' }));
    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toContain('attach requires --grove');
  });

  test('an UNCODED attach error maps to 400 with the route fallback code', async () => {
    const handler = createHostMembershipAttachHandler({
      attach: () => { throw new Error('Could not determine the project id for /checkout.'); },
    });
    const res = await handler(req({ project_root: '/checkout', grove_id: 'g' }));
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('attach_failed');
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
    const res = await handler(req({ project_root: '/checkout', grove_id: 'g' }));
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
    expect(seen).toEqual({ projectPath: '/checkout', projectId: undefined });
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

  beforeEach(() => {
    teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-membership-status-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = teamHome;
  });
  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(teamHome, { recursive: true, force: true });
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
    const handler = createHostMembershipStatusHandler();
    const res = await handler(req({}, {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hosts: [], hint: null });
  });

  test('every joined host appears with its attach refs (no bearer/secret leaks)', async () => {
    const groveId = createGroveId();
    const projectId = createProjectId();
    const host = makeHost({ projects: [{ grove_id: groveId, project_id: projectId, root: '/checkout' }] });
    upsertHost(host);

    const handler = createHostMembershipStatusHandler();
    const res = await handler(req({}, {}));
    expect(res.body).toEqual({
      hosts: [{
        host_id: host.host_id, label: host.label, overlay_address: host.overlay_address,
        proxy_port: host.proxy_port, protocol_version: host.protocol_version, created_at: host.created_at,
        projects: [{ grove_id: groveId, project_id: projectId, root: '/checkout' }],
      }],
      hint: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('bearer');
  });

  test('project_root with an unresolved hint (host not joined) surfaces the hint', async () => {
    const hintedHostId = createHostId();
    const projectId = createProjectId();
    const root = makeCheckout(projectId, hintedHostId);

    const handler = createHostMembershipStatusHandler();
    const res = await handler(req({}, { project_root: root }));
    const body = res.body as { hint: { host_id: string; state: string; message: string } | null };
    expect(body.hint).not.toBeNull();
    expect(body.hint!.host_id).toBe(hintedHostId);
    expect(body.hint!.state).toBe('not_joined');
    expect(body.hint!.message).toContain(`myco join ${hintedHostId}`);
  });

  test('project_root for a project already attached (hint resolved) omits the hint', async () => {
    const host = makeHost();
    upsertHost(host);
    const projectId = createProjectId();
    const root = makeCheckout(projectId, host.host_id);
    // Attach it — resolveTeamHostHintState reads resolveAttach, not the raw hint.
    const { attachProject } = await import('@myco/host/registry.js');
    attachProject(host.host_id, { grove_id: createGroveId(), project_id: projectId, root });

    const handler = createHostMembershipStatusHandler();
    const res = await handler(req({}, { project_root: root }));
    expect((res.body as { hint: unknown }).hint).toBeNull();
  });

  test('project_root pointing at a directory with no manifest degrades to no hint, not an error', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-membership-bare-'));
    const handler = createHostMembershipStatusHandler();
    const res = await handler(req({}, { project_root: bare }));
    expect(res.status).toBe(200);
    expect((res.body as { hint: unknown }).hint).toBeNull();
    fs.rmSync(bare, { recursive: true, force: true });
  });
});
