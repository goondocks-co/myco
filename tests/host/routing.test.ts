/**
 * Tests for the Team Host member-side routing decision (`classifyRoute`).
 *
 * Hermetic: `MYCO_TEAM_HOME` points at a fresh tmpdir per test (the same
 * env-override the host-registry tests use, `registry.test.ts`), so the attach
 * registry is empty unless a test seeds it and no developer `~/.myco-team` is
 * touched. `classifyRoute` performs NO Grove/DB resolution, so no `MYCO_HOME`
 * fixture is needed — a non-attached project short-circuits before any registry
 * read.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HOST_BEARER_SECRET } from '@myco/constants';
import {
  assertGroveProjectId,
  createGroveId,
  createHostId,
  createProjectId,
  type GroveProjectId,
} from '@myco/grove/ids';
import { upsertHost, writeHostSecret, type HostRecord } from '@myco/host/registry';
import {
  classifyRoute,
  classifyRouteStamp,
  configHostAuthoritative,
  hostedCapabilityUnavailable,
  overlayHostStampRefusal,
  refusalJson,
  refusalMcpBody,
} from '@myco/host/routing';

function seedAttached(overrides: Partial<HostRecord> = {}): { projectId: GroveProjectId; groveId: string; host: HostRecord } {
  const groveId = createGroveId();
  const projectId = assertGroveProjectId(createProjectId());
  const host: HostRecord = {
    host_id: createHostId(),
    label: 'Mac Studio',
    overlay_address: '100.64.0.1:7433',
    protocol_version: 1,
    created_at: new Date().toISOString(),
    projects: [{ grove_id: groveId, project_id: projectId }],
    ...overrides,
  };
  // Seed the record directly (bypassing attachProject's local-registry guard,
  // which is exercised in registry.test.ts) so the routing table is the subject.
  upsertHost(host);
  return { projectId, groveId, host };
}

describe('classifyRoute', () => {
  let tmp: string;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-routing-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });

  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('null projectId (daemon anchor / no tenancy) → local, never touches the registry', () => {
    expect(classifyRoute({ method: 'GET', pathname: '/api/sessions', projectId: null }))
      .toEqual({ kind: 'local' });
  });

  test('a project with no attach record → local (empty registry)', () => {
    const projectId = assertGroveProjectId(createProjectId());
    expect(classifyRoute({ method: 'GET', pathname: '/api/sessions', projectId }))
      .toEqual({ kind: 'local' });
  });

  test('a project attached to no host → local, even when other projects are attached', () => {
    seedAttached();
    const other = assertGroveProjectId(createProjectId());
    expect(classifyRoute({ method: 'GET', pathname: '/api/sessions', projectId: other }))
      .toEqual({ kind: 'local' });
  });

  test('attached + serve route → remote, target carries hosted tenancy + host record', () => {
    const { projectId, groveId, host } = seedAttached();
    const decision = classifyRoute({ method: 'GET', pathname: '/api/sessions', projectId });
    expect(decision.kind).toBe('remote');
    if (decision.kind !== 'remote') throw new Error('expected remote');
    expect(decision.target.projectId).toBe(projectId);
    expect(decision.target.groveId).toBe(groveId);
    expect(decision.target.host).toEqual({
      host_id: host.host_id,
      label: 'Mac Studio',
      overlay_address: '100.64.0.1:7433',
      protocol_version: 1,
    });
    expect(decision.classification.stamp).toBe('serve');
  });

  test('attached + /mcp → remote (the raw route defaults to serve)', () => {
    const { projectId } = seedAttached();
    const decision = classifyRoute({ method: 'POST', pathname: '/mcp', projectId });
    expect(decision.kind).toBe('remote');
  });

  test('attached + collect route (POST /events) → remote, classified collect', () => {
    const { projectId } = seedAttached();
    const decision = classifyRoute({ method: 'POST', pathname: '/events', projectId });
    expect(decision.kind).toBe('remote');
    if (decision.kind !== 'remote') throw new Error('expected remote');
    expect(decision.classification.stamp).toBe('collect');
  });

  test('the host bearer flows into the remote target from secrets.env', () => {
    const { projectId, host } = seedAttached();
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, 'host-bearer-xyz');
    const decision = classifyRoute({ method: 'GET', pathname: '/api/spores', projectId });
    if (decision.kind !== 'remote') throw new Error('expected remote');
    expect(decision.target.bearer).toBe('host-bearer-xyz');
  });

  test('attached + git-status (degrade) → degraded refusal, HTTP 409', () => {
    const { projectId } = seedAttached();
    const decision = classifyRoute({ method: 'GET', pathname: '/api/git/status', projectId });
    expect(decision.kind).toBe('degraded');
    if (decision.kind !== 'degraded') throw new Error('expected degraded');
    expect(decision.refusal.status).toBe(409);
    expect(decision.refusal.error).toBe('capability_unavailable_hosted');
    expect(decision.refusal.capability).toBe('Git provenance');
    expect(decision.refusal.retryable).toBe(false);
  });

  test('attached + canopy map (degrade) → degraded refusal', () => {
    const { projectId } = seedAttached();
    const decision = classifyRoute({ method: 'GET', pathname: '/api/canopy/map', projectId });
    if (decision.kind !== 'degraded') throw new Error('expected degraded');
    expect(decision.refusal.capability).toBe('Code intelligence (Canopy)');
  });

  test('attached + per-session canopy read (degrade) matches the param pattern', () => {
    const { projectId } = seedAttached();
    const decision = classifyRoute({
      method: 'GET',
      pathname: '/api/sessions/sess_0123456789abcdef0123456789abcdef/canopy',
      projectId,
    });
    expect(decision.kind).toBe('degraded');
  });

  test('attached + grove-config write (config-lock) → config_locked refusal', () => {
    const { projectId } = seedAttached();
    const decision = classifyRoute({ method: 'PUT', pathname: '/api/grove-config', projectId });
    expect(decision.kind).toBe('config_locked');
    if (decision.kind !== 'config_locked') throw new Error('expected config_locked');
    expect(decision.refusal.error).toBe('config_host_authoritative');
    expect(decision.refusal.status).toBe(409);
  });

  test('attached + agent-task-def write (config-lock) → config_locked refusal', () => {
    const { projectId } = seedAttached();
    const decision = classifyRoute({ method: 'POST', pathname: '/api/agent/tasks', projectId });
    expect(decision.kind).toBe('config_locked');
  });

  test('attached + localhost-only (GET /api/logs) → local', () => {
    const { projectId } = seedAttached();
    expect(classifyRoute({ method: 'GET', pathname: '/api/logs', projectId }).kind).toBe('local');
  });

  test('attached + machine-config write (localhost-only) → local, never proxied', () => {
    const { projectId } = seedAttached();
    expect(classifyRoute({ method: 'PUT', pathname: '/api/machine-config', projectId }).kind).toBe('local');
  });

  test('method differentiates: GET /api/agent/tasks is serve, POST is config-lock', () => {
    const { projectId } = seedAttached();
    expect(classifyRoute({ method: 'GET', pathname: '/api/agent/tasks', projectId }).kind).toBe('remote');
    expect(classifyRoute({ method: 'POST', pathname: '/api/agent/tasks', projectId }).kind).toBe('config_locked');
  });

  // config-carve routing + the groveTierWriteRefusal gate are covered in the
  // canonical tree (tests/host/attached-config-routing.test.ts, run by npm test).
});

describe('classifyRouteStamp — scope-map coverage spot-checks', () => {
  const cases: Array<[string, string, string]> = [
    // [method, pathname, expected stamp] — one representative per scope-map section.
    ['POST', '/events', 'collect'],
    ['POST', '/sessions/register', 'collect'],
    ['GET', '/api/sessions', 'serve'],
    ['GET', '/api/search', 'serve'],
    ['GET', '/api/grove-config', 'serve'],
    ['POST', '/mcp', 'serve'],
    ['GET', '/api/git/status', 'degrade'],
    ['GET', '/api/canopy/rollup', 'degrade'],
    ['POST', '/canopy/inject', 'degrade'],
    ['POST', '/api/maintenance/release-provenance/reconcile', 'degrade'],
    ['POST', '/api/backup', 'degrade'],
    ['POST', '/api/restore', 'degrade'],
    ['POST', '/api/restore/preview', 'degrade'],
    ['PATCH', '/api/groves/grove_0123456789abcdef0123456789abcdef', 'degrade'],
    ['DELETE', '/api/groves/grove_0123456789abcdef0123456789abcdef', 'degrade'],
    ['POST', '/api/groves/grove_0123456789abcdef0123456789abcdef/projects/proj_0123456789abcdef0123456789abcdef', 'degrade'],
    ['POST', '/api/groves/grove_0123456789abcdef0123456789abcdef/projects/proj_0123456789abcdef0123456789abcdef/archive', 'degrade'],
    ['POST', '/api/groves/grove_0123456789abcdef0123456789abcdef/projects/proj_0123456789abcdef0123456789abcdef/unarchive', 'degrade'],
    ['DELETE', '/api/groves/grove_0123456789abcdef0123456789abcdef/projects/proj_0123456789abcdef0123456789abcdef', 'degrade'],
    // the GET reads adjacent to the backup/grove mutations stay localhost-only
    ['GET', '/api/backups', 'localhost-only'],
    ['GET', '/api/restore/status', 'localhost-only'],
    ['POST', '/api/groves', 'localhost-only'],
    ['POST', '/api/groves/grove_0123456789abcdef0123456789abcdef/default', 'localhost-only'],
    // Team Host membership admin surfaces (E-4 W2 Task 7, item e) — machine-
    // local admin, never proxied.
    ['GET', '/api/host-membership/health', 'localhost-only'],
    ['GET', '/api/host-serve/status', 'localhost-only'],
    ['PUT', '/api/grove-config', 'config-lock'],
    ['DELETE', '/api/agent/tasks/task_0123456789abcdef0123456789abcdef', 'config-lock'],
    // config carve: the per-tier member-side config surfaces (routing-layer §6.3).
    ['GET', '/api/config', 'config-carve'],
    ['GET', '/api/config/merged', 'config-carve'],
    ['GET', '/api/config/local', 'config-carve'],
    ['PUT', '/api/config/scoped', 'config-carve'],
    ['GET', '/api/logs/stream', 'localhost-only'],
    ['PUT', '/api/machine-config', 'localhost-only'],
    ['GET', '/api/providers/secrets', 'localhost-only'],
    ['POST', '/api/groves', 'localhost-only'],
  ];

  for (const [method, pathname, stamp] of cases) {
    test(`${method} ${pathname} → ${stamp}`, () => {
      expect(classifyRouteStamp(method, pathname).stamp as string).toBe(stamp);
    });
  }

  test('an unlisted route defaults to serve', () => {
    expect(classifyRouteStamp('GET', '/api/some/future/read').stamp).toBe('serve');
  });
});

describe('refusal serializers', () => {
  test('refusalJson splits status from the wire body', () => {
    const { status, body } = refusalJson(hostedCapabilityUnavailable('Git provenance'));
    expect(status).toBe(409);
    expect(body).toEqual({
      error: 'capability_unavailable_hosted',
      capability: 'Git provenance',
      message: 'Git provenance is unavailable for projects served by a host in this version.',
      retryable: false,
    });
  });

  test('refusalMcpBody wraps the refusal in the -32004 JSON-RPC envelope', () => {
    const body = JSON.parse(refusalMcpBody(configHostAuthoritative('Config administration')));
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32004);
    expect(body.error.data.code).toBe('config_host_authoritative');
    expect(body.error.data.capability).toBe('Config administration');
    expect(body.id).toBeNull();
  });
});

describe('overlayHostStampRefusal (host-side overlay backstop)', () => {
  // The host's independent enforcement of the scope-map stamp on a matched route,
  // by stamp class. Pure over (method, matched pathname) — no registry, no attach.

  test('localhost-only → 404 not_found (operator/machine-local; the secret routes)', () => {
    // The Critical credential route resolves through the :param tier correctly.
    const secret = overlayHostStampRefusal('PUT', '/api/providers/secrets/openai');
    expect(secret).toEqual({
      status: 404,
      error: 'not_found',
      message: 'This route is served on localhost only, not over the overlay.',
      retryable: false,
    });
    expect(overlayHostStampRefusal('GET', '/api/providers/secrets')?.status).toBe(404);
    expect(overlayHostStampRefusal('POST', '/api/restart')?.error).toBe('not_found');
  });

  test('degrade → 409 capability_unavailable_hosted (same payload the member returns)', () => {
    expect(overlayHostStampRefusal('GET', '/api/git/status')).toEqual(
      hostedCapabilityUnavailable('Git provenance'),
    );
  });

  test('config-lock → 409 config_host_authoritative (same payload the member returns)', () => {
    expect(overlayHostStampRefusal('PUT', '/api/grove-config')).toEqual(
      configHostAuthoritative('Config administration'),
    );
  });

  test('config-carve → 404 not_found (member-assembled; never a valid overlay surface)', () => {
    expect(overlayHostStampRefusal('PUT', '/api/config/scoped')?.status).toBe(404);
    expect(overlayHostStampRefusal('GET', '/api/config/merged')?.error).toBe('not_found');
  });

  test('serve / collect → null (served locally: the host answers for its own Grove)', () => {
    expect(overlayHostStampRefusal('GET', '/api/sessions')).toBeNull(); // default serve
    expect(overlayHostStampRefusal('GET', '/api/grove-config')).toBeNull(); // GET is serve, PUT is config-lock
    expect(overlayHostStampRefusal('POST', '/events')).toBeNull(); // collect
  });
});
