/**
 * Tests for `tenantRoute` — the HTTP route wrapper that EVERY tenant-scoped
 * route runs through.
 *
 * The load-bearing invariant: the global daemon synthesizes a fallback
 * (bootstrap-anchor) request context for every request before handlers run,
 * so a handler can never trust "is requestContext present?" as authorization.
 * `tenantRoute` resolves the principal and authorizes BEFORE the handler sees
 * the request. On any tenancy violation it must fail closed (reject 400) AND
 * loud (emit a `tenancy.violation` warning) — never swallow, never default to
 * the daemon anchor. These tests pin both halves of that contract: the happy
 * path hands the handler an authorized principal, and every violation path
 * rejects without calling the handler and logs the violation.
 */

import { describe, it, expect } from 'bun:test';
import { tenantRoute } from '@myco/daemon/api/route-helpers.js';
import type { RouteRequest, RouteResponse } from '@myco/daemon/router';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

interface CapturedLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Minimal capturing logger stub matching the `DaemonLogger.warn(kind, message,
 * fields)` shape consumed by `tenantRoute`. Records every call so a test can
 * assert that a `tenancy.violation` warning was actually emitted.
 */
function makeLogger() {
  const logs: CapturedLog[] = [];
  const record = (level: CapturedLog['level']) =>
    (kind: string, message: string, data?: Record<string, unknown>) => {
      logs.push({ level, kind, message, data });
    };
  return {
    logs,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

const CALLER_CONTEXT = {
  projectRoot: '/tenants/acme',
  callerRoot: null,
  projectId: 'proj_00000000000000000000000000000001',
  groveId: 'grove_00000000000000000000000000000002',
  machineId: 'machine-xyz',
  sessionId: null,
  projectVaultDir: '/tenants/acme/.myco',
  databasePath: '/tenants/acme/.myco/vault.db',
  source: 'headers',
  tenancySource: 'caller',
} as const;

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    body: undefined,
    query: {},
    params: {},
    pathname: '/api/tenant/thing',
    requestContext: CALLER_CONTEXT as unknown as RouteRequest['requestContext'],
    ...overrides,
  } as RouteRequest;
}

const DEPS_BASE = { machineId: 'machine-xyz' };

describe('tenantRoute', () => {
  it('runs the handler with an authorized principal for a caller-supplied context', async () => {
    const logger = makeLogger();
    let seenPrincipal: { tenancy: { projectId: string; groveId: string } } | null = null;
    const handlerResponse: RouteResponse = { status: 200, body: { ok: true, data: 42 } };

    const wrapped = tenantRoute(
      { ...DEPS_BASE, logger: logger as never },
      async (_req, principal) => {
        seenPrincipal = principal;
        return handlerResponse;
      },
    );

    const res = await wrapped(makeRequest());

    expect(res).toBe(handlerResponse);
    expect(seenPrincipal).not.toBeNull();
    expect(seenPrincipal!.tenancy.projectId).toBe(CALLER_CONTEXT.projectId);
    expect(seenPrincipal!.tenancy.groveId).toBe(CALLER_CONTEXT.groveId);
    // No tenancy violation should have been logged on the happy path.
    expect(logger.logs.filter((l) => l.kind === LOG_KINDS.TENANCY_VIOLATION)).toHaveLength(0);
  });

  it('passes the resolved principal as the second handler argument', async () => {
    const logger = makeLogger();
    const wrapped = tenantRoute(
      { ...DEPS_BASE, logger: logger as never },
      async (_req, principal) => ({
        status: 200,
        body: { vault: principal.tenancy.projectVaultDir },
      }),
    );

    const res = await wrapped(makeRequest());

    expect(res.status).toBe(200);
    expect((res.body as { vault: string }).vault).toBe(CALLER_CONTEXT.projectVaultDir);
  });

  it('rejects a synthesized context with 400 + reason and does NOT call the handler', async () => {
    const logger = makeLogger();
    let handlerCalled = false;
    const synthesized = { ...CALLER_CONTEXT, tenancySource: 'synthesized' as const };

    const wrapped = tenantRoute(
      { ...DEPS_BASE, logger: logger as never },
      async () => {
        handlerCalled = true;
        return { status: 200, body: { ok: true } };
      },
    );

    const res = await wrapped(
      makeRequest({ requestContext: synthesized as unknown as RouteRequest['requestContext'] }),
    );

    expect(handlerCalled).toBe(false);
    expect(res.status).toBe(400);
    expect((res.body as { reason: string }).reason).toBe('tenancy-violation');
    expect((res.body as { ok: boolean }).ok).toBe(false);
  });

  it('emits a tenancy.violation warning when the context is synthesized', async () => {
    const logger = makeLogger();
    const synthesized = { ...CALLER_CONTEXT, tenancySource: 'synthesized' as const };

    const wrapped = tenantRoute(
      { ...DEPS_BASE, logger: logger as never },
      async () => ({ status: 200, body: { ok: true } }),
    );

    await wrapped(
      makeRequest({
        pathname: '/api/tenant/secrets',
        requestContext: synthesized as unknown as RouteRequest['requestContext'],
      }),
    );

    const violations = logger.logs.filter((l) => l.kind === LOG_KINDS.TENANCY_VIOLATION);
    expect(violations).toHaveLength(1);
    expect(violations[0].level).toBe('warn');
    expect(violations[0].data?.pathname).toBe('/api/tenant/secrets');
    expect(typeof violations[0].data?.detail).toBe('string');
  });

  it('rejects an absent requestContext with 400 + log and does NOT call the handler', async () => {
    const logger = makeLogger();
    let handlerCalled = false;

    const wrapped = tenantRoute(
      { ...DEPS_BASE, logger: logger as never },
      async () => {
        handlerCalled = true;
        return { status: 200, body: { ok: true } };
      },
    );

    const res = await wrapped(makeRequest({ requestContext: undefined }));

    expect(handlerCalled).toBe(false);
    expect(res.status).toBe(400);
    expect((res.body as { reason: string }).reason).toBe('tenancy-violation');
    expect(logger.logs.filter((l) => l.kind === LOG_KINDS.TENANCY_VIOLATION)).toHaveLength(1);
  });
});
