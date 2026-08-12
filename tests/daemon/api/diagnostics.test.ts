/**
 * Diagnostic export bundle daemon routes: create, list, download.
 *
 * Handler-factory style (see `database-scope.test.ts` / `attachments.test.ts`):
 * handlers are constructed directly against a `GroveRuntimeCache` and exercised
 * without an HTTP server, mirroring how `main.ts` wires them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { createDiagnosticsHandlers } from '@myco/daemon/api/diagnostics';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache';
import { withDatabase } from '@myco/db/client';
import { upsertSession } from '@myco/db/queries/sessions';
import { createGrove, type GroveRecord } from '@myco/grove/registry';
import { resolveGroveDbPath } from '@myco/grove/paths';
import { assertGroveProjectId } from '@myco/grove/ids';
import type { RouteRequest } from '@myco/daemon/router';
import { makeTestRequestContext } from '../../helpers/request-context.js';

const VALID_PROJECT_ID = assertGroveProjectId('proj_' + 'a'.repeat(32));

function emptyRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    body: undefined,
    query: {},
    params: {},
    pathname: '/api/diagnostics/export',
    ...overrides,
  };
}

describe('diagnostics export/list/download routes', () => {
  let workDir: string;
  let mycoHome: string;
  let diagnosticsDir: string;
  let logDir: string;
  let cache: GroveRuntimeCache;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-api-'));
    mycoHome = path.join(workDir, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    diagnosticsDir = path.join(workDir, 'diagnostics');
    logDir = path.join(workDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    cache = new GroveRuntimeCache();
  });

  afterEach(() => {
    cache.closeAll();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function makeHandlers(overrides: { config?: () => unknown } = {}) {
    return createDiagnosticsHandlers({
      cache,
      mycoHome,
      vaultDir: path.join(workDir, 'bootstrap-vault'),
      logDir,
      config: overrides.config ?? (() => ({ daemon: { port: 4155 } })),
      mycoVersion: '9.9.9-test',
      diagnosticsDir,
    });
  }

  /** Seed one in-window session into the given Grove's DB via the shared cache. */
  function seedSession(grove: GroveRecord, sessionId: string, startedAt = 1200, endedAt = 1800) {
    const db = cache.getDatabase(resolveGroveDbPath(grove.id, mycoHome));
    withDatabase(db, () => {
      upsertSession({ id: sessionId, agent: 'claude-code', started_at: startedAt, ended_at: endedAt, created_at: startedAt });
    });
  }

  // ---------------------------------------------------------------------
  // POST /api/diagnostics/export — scope + window validation
  // ---------------------------------------------------------------------

  it('grove_required when no request context and no body scope', async () => {
    const handlers = makeHandlers();
    const res = await handlers.handleExport(emptyRequest({ body: { window: { since: 0, until: 100 } } }));
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('grove_required');
  });

  it('invalid_scope for kind: project — diagnostics are per-Grove', async () => {
    const grove = createGrove('alpha', mycoHome);
    const handlers = makeHandlers();
    const res = await handlers.handleExport(
      emptyRequest({
        body: {
          scope: { kind: 'project', grove_id: grove.id, project_id: VALID_PROJECT_ID },
          window: { since: 0, until: 100 },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_scope');
  });

  it('invalid_scope for kind: all-groves — one bundle is one Grove', async () => {
    const handlers = makeHandlers();
    const res = await handlers.handleExport(
      emptyRequest({ body: { scope: { kind: 'all-groves' }, window: { since: 0, until: 100 } } }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_scope');
  });

  it('invalid_window when both session_id and window are present', async () => {
    const grove = createGrove('alpha', mycoHome);
    seedSession(grove, 's1');
    const handlers = makeHandlers();
    const res = await handlers.handleExport(
      emptyRequest({
        body: {
          scope: { kind: 'grove', grove_id: grove.id },
          session_id: 's1',
          window: { since: 0, until: 100 },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_window');
  });

  it('invalid_window when neither session_id nor window is present', async () => {
    const grove = createGrove('alpha', mycoHome);
    const handlers = makeHandlers();
    const res = await handlers.handleExport(
      emptyRequest({ body: { scope: { kind: 'grove', grove_id: grove.id } } }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_window');
  });

  it('invalid_body for a structurally malformed window (not the session_id/window ambiguity rule)', async () => {
    const grove = createGrove('alpha', mycoHome);
    const handlers = makeHandlers();
    const res = await handlers.handleExport(
      emptyRequest({
        body: { scope: { kind: 'grove', grove_id: grove.id }, window: { since: 'nope', until: 100 } },
      }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_body');
  });

  it('session_not_found (404) for an unknown session_id, not a raw 500', async () => {
    const grove = createGrove('alpha', mycoHome);
    const handlers = makeHandlers();
    const res = await handlers.handleExport(
      emptyRequest({
        body: { scope: { kind: 'grove', grove_id: grove.id }, session_id: 'does-not-exist' },
      }),
    );
    expect(res.status).toBe(404);
    const body = res.body as { error: string; message: string };
    expect(body.error).toBe('session_not_found');
    expect(body.message).toMatch(/does-not-exist/);
  });

  it('empty_window with nearest_sessions when the resolved window has no sessions and no log entries', async () => {
    const grove = createGrove('alpha', mycoHome);
    seedSession(grove, 's1', 1_000_000, 1_000_100);
    const handlers = makeHandlers();
    const res = await handlers.handleExport(
      emptyRequest({
        body: { scope: { kind: 'grove', grove_id: grove.id }, window: { since: 1, until: 2 } },
      }),
    );
    expect(res.status).toBe(404);
    const body = res.body as { error: string; nearest_sessions: Array<{ id: string }> };
    expect(body.error).toBe('empty_window');
    expect(body.nearest_sessions.length).toBeGreaterThan(0);
    expect(body.nearest_sessions[0]!.id).toBe('s1');
  });

  // ---------------------------------------------------------------------
  // Happy path + Grove isolation
  // ---------------------------------------------------------------------

  it('builds a bundle for the resolved Grove — 200 with the zip present at file_path', async () => {
    const grove = createGrove('alpha', mycoHome);
    seedSession(grove, 's1');
    const handlers = makeHandlers();
    const res = await handlers.handleExport(
      emptyRequest({
        body: { scope: { kind: 'grove', grove_id: grove.id }, window: { since: 1000, until: 2000 } },
      }),
    );
    expect(res.status === undefined || res.status < 400).toBe(true);
    const body = res.body as { file_path: string; file_name: string; size_bytes: number; manifest: unknown };
    expect(fs.existsSync(body.file_path)).toBe(true);
    expect(body.size_bytes).toBeGreaterThan(0);
    expect(body.file_name).toMatch(/^myco-diagnostic-.*\.zip$/);
    expect(body.manifest).toBeTruthy();
  });

  it('dereferences the config getter fresh on every export (no boot-time snapshot)', async () => {
    const grove = createGrove('alpha', mycoHome);
    seedSession(grove, 's1');
    let callCount = 0;
    let currentPort = 4155;
    const handlers = makeHandlers({
      config: () => {
        callCount += 1;
        return { daemon: { port: currentPort } };
      },
    });

    const first = await handlers.handleExport(
      emptyRequest({ body: { scope: { kind: 'grove', grove_id: grove.id }, window: { since: 1000, until: 2000 } } }),
    );
    expect(callCount).toBe(1);
    currentPort = 9999;
    const second = await handlers.handleExport(
      emptyRequest({ body: { scope: { kind: 'grove', grove_id: grove.id }, window: { since: 1000, until: 2000 } } }),
    );
    expect(callCount).toBe(2);

    const firstEnv = JSON.parse(
      strFromU8(unzipSync(fs.readFileSync((first.body as { file_path: string }).file_path))['environment.json']!),
    ) as { config: { daemon: { port: number } } };
    const secondEnv = JSON.parse(
      strFromU8(unzipSync(fs.readFileSync((second.body as { file_path: string }).file_path))['environment.json']!),
    ) as { config: { daemon: { port: number } } };
    expect(firstEnv.config.daemon.port).toBe(4155);
    expect(secondEnv.config.daemon.port).toBe(9999);
  });

  it('defaults to the request-context Grove when no body scope is given', async () => {
    const grove = createGrove('alpha', mycoHome);
    seedSession(grove, 's1');
    const handlers = makeHandlers();
    const res = await handlers.handleExport(
      emptyRequest({
        body: { window: { since: 1000, until: 2000 } },
        requestContext: makeTestRequestContext({ groveId: grove.id }),
      }),
    );
    expect(res.status === undefined || res.status < 400).toBe(true);
    const body = res.body as { file_path: string };
    expect(fs.existsSync(body.file_path)).toBe(true);
  });

  it('Grove isolation: exporting Grove A never leaks Grove B session ids into vault-derived files', async () => {
    const groveA = createGrove('alpha', mycoHome);
    const groveB = createGrove('beta', mycoHome);
    seedSession(groveA, 'session-A-only', 1000, 1800);
    seedSession(groveB, 'session-B-only', 1000, 1800);

    const handlers = makeHandlers();
    const res = await handlers.handleExport(
      emptyRequest({
        body: { scope: { kind: 'grove', grove_id: groveA.id }, window: { since: 500, until: 2500 } },
      }),
    );
    expect(res.status === undefined || res.status < 400).toBe(true);
    const body = res.body as { file_path: string };

    const unzipped = unzipSync(fs.readFileSync(body.file_path));
    const vaultDerivedNames = Object.keys(unzipped).filter((name) =>
      ['sessions.jsonl', 'agent-runs.jsonl', 'log-entries.jsonl'].includes(name)
      || name.startsWith('transcripts/')
      || name.startsWith('buffers/'),
    );
    expect(vaultDerivedNames.length).toBeGreaterThan(0);
    let sawGroveASessionId = false;
    for (const name of vaultDerivedNames) {
      const text = strFromU8(unzipped[name]!);
      expect(text).not.toContain('session-B-only');
      if (text.includes('session-A-only')) sawGroveASessionId = true;
    }
    // sessions.jsonl itself, at minimum, must carry the exported Grove's own
    // session id — proves the negative assertion above isn't vacuous.
    expect(sawGroveASessionId).toBe(true);
    // daemon-log.jsonl is machine-global and exempt from this check (its own
    // payload allowlist is what protects other Groves' content there).
  });

  // ---------------------------------------------------------------------
  // GET /api/diagnostics/exports
  // ---------------------------------------------------------------------

  it('lists exports for the resolved Grove only, newest first', async () => {
    const groveA = createGrove('alpha', mycoHome);
    const groveB = createGrove('beta', mycoHome);
    seedSession(groveA, 's-a1', 1000, 1800);
    seedSession(groveB, 's-b1', 1000, 1800);
    const handlers = makeHandlers();

    const first = await handlers.handleExport(
      emptyRequest({ body: { scope: { kind: 'grove', grove_id: groveA.id }, window: { since: 500, until: 2500 } } }),
    );
    const second = await handlers.handleExport(
      emptyRequest({ body: { scope: { kind: 'grove', grove_id: groveA.id }, window: { since: 500, until: 2500 } } }),
    );
    await handlers.handleExport(
      emptyRequest({ body: { scope: { kind: 'grove', grove_id: groveB.id }, window: { since: 500, until: 2500 } } }),
    );

    const firstName = (first.body as { file_name: string }).file_name;
    const secondName = (second.body as { file_name: string }).file_name;
    // Force distinct, ordered mtimes (integer-second resolution) so the
    // newest-first sort assertion below isn't racing real wall-clock time.
    const now = Math.floor(Date.now() / 1000);
    fs.utimesSync(path.join(diagnosticsDir, firstName), now - 10, now - 10);
    fs.utimesSync(path.join(diagnosticsDir, secondName), now, now);

    const listRes = await handlers.handleListExports(
      emptyRequest({ pathname: '/api/diagnostics/exports', requestContext: makeTestRequestContext({ groveId: groveA.id }) }),
    );
    expect(listRes.status === undefined || listRes.status < 400).toBe(true);
    const listBody = listRes.body as { exports: Array<{ file_name: string; size_bytes: number; modified_at: string }> };
    const names = listBody.exports.map((e) => e.file_name);
    expect(names).toContain(firstName);
    expect(names).toContain(secondName);
    // Only Grove A's bundles are listed — Grove B's export is excluded even
    // though it exists in the same diagnostics root.
    expect(names.length).toBe(2);
    expect(names.every((n) => !n.includes(groveB.id))).toBe(true);
    // Sorted newest first.
    expect(listBody.exports[0]!.file_name).toBe(secondName);
    // modified_at is an ISO string, matching backup's list shape.
    for (const entry of listBody.exports) {
      expect(entry.modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(entry.modified_at).toISOString()).toBe(entry.modified_at);
    }
  });

  it('list is grove_required without a resolved Grove context', async () => {
    const handlers = makeHandlers();
    const res = await handlers.handleListExports(emptyRequest({ pathname: '/api/diagnostics/exports' }));
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('grove_required');
  });

  // ---------------------------------------------------------------------
  // GET /api/diagnostics/export/:file/download
  // ---------------------------------------------------------------------

  it('download: grove_required (400) when the request carries no Grove context', async () => {
    const handlers = makeHandlers();
    const res = await handlers.handleDownload(
      emptyRequest({ params: { file: 'myco-diagnostic-whatever-2026-01-01T00-00-00-000Z.zip' } }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('grove_required');
  });

  it('download: 404 on a traversal-shaped file param', async () => {
    const grove = createGrove('alpha', mycoHome);
    const handlers = makeHandlers();
    const res = await handlers.handleDownload(
      emptyRequest({
        params: { file: '..%2Fdaemon.log' },
        pathname: '/api/diagnostics/export/..%2Fdaemon.log/download',
        requestContext: makeTestRequestContext({ groveId: grove.id }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('download: 404 for a non-bundle file name (daemon.log)', async () => {
    const grove = createGrove('alpha', mycoHome);
    const handlers = makeHandlers();
    const res = await handlers.handleDownload(
      emptyRequest({
        params: { file: 'daemon.log' },
        pathname: '/api/diagnostics/export/daemon.log/download',
        requestContext: makeTestRequestContext({ groveId: grove.id }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('download: 404 for a valid-shaped but nonexistent file name', async () => {
    const grove = createGrove('alpha', mycoHome);
    const handlers = makeHandlers();
    const res = await handlers.handleDownload(
      emptyRequest({
        params: { file: `myco-diagnostic-${grove.id}-nonexistent-2026-01-01T00-00-00-000Z.zip` },
        pathname: '/api/diagnostics/export/x/download',
        requestContext: makeTestRequestContext({ groveId: grove.id }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('download: 404 when a Grove A context requests Grove B\'s bundle filename', async () => {
    const groveA = createGrove('alpha', mycoHome);
    const groveB = createGrove('beta', mycoHome);
    seedSession(groveB, 's1');
    const handlers = makeHandlers();
    const exportRes = await handlers.handleExport(
      emptyRequest({ body: { scope: { kind: 'grove', grove_id: groveB.id }, window: { since: 1000, until: 2000 } } }),
    );
    const groveBFileName = (exportRes.body as { file_name: string }).file_name;

    const res = await handlers.handleDownload(
      emptyRequest({
        params: { file: groveBFileName },
        pathname: `/api/diagnostics/export/${groveBFileName}/download`,
        requestContext: makeTestRequestContext({ groveId: groveA.id }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('download: 200 with application/zip + Content-Disposition for a real bundle', async () => {
    const grove = createGrove('alpha', mycoHome);
    seedSession(grove, 's1');
    const handlers = makeHandlers();
    const exportRes = await handlers.handleExport(
      emptyRequest({ body: { scope: { kind: 'grove', grove_id: grove.id }, window: { since: 1000, until: 2000 } } }),
    );
    const fileName = (exportRes.body as { file_name: string }).file_name;

    const res = await handlers.handleDownload(
      emptyRequest({
        params: { file: fileName },
        pathname: `/api/diagnostics/export/${fileName}/download`,
        requestContext: makeTestRequestContext({ groveId: grove.id }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers?.['Content-Type']).toBe('application/zip');
    expect(res.headers?.['Content-Disposition']).toBe(`attachment; filename="${fileName}"`);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).length).toBeGreaterThan(0);
  });
});
