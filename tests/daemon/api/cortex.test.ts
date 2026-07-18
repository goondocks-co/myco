import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import type { RouteRequest } from '@myco/daemon/router';
import { MycoConfigSchema } from '@myco/config/schema';
import { resolveLegacyRequestContext, type MycoRequestContext } from '@myco/grove/request-context';
import { assertGroveProjectId } from '@myco/grove/ids';
import { tenantRoute } from '@myco/daemon/api/route-helpers';
import type { RequestPrincipal } from '@myco/daemon/request-principal';

const {
  getCortexInstructionsSnapshot,
  buildCortexPrompt,
  getCortexPromptResult,
  triggerCortexInstructions,
} = vi.hoisted(() => ({
  getCortexInstructionsSnapshot: vi.fn(),
  buildCortexPrompt: vi.fn(),
  getCortexPromptResult: vi.fn(),
  triggerCortexInstructions: vi.fn(),
}));

mock.module('@myco/daemon/cortex.js', () => ({
  getCortexInstructionsSnapshot,
  buildCortexPrompt,
  getCortexPromptResult,
  triggerCortexInstructions,
}));

import { createCortexHandlers } from '@myco/daemon/api/cortex';

import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';

// The daemon's bootstrap-anchor project (project A). The bug being fixed is
// that Cortex write/trigger handlers used to act against THIS project no
// matter which tenant the request actually came from.
const ANCHOR_VAULT_DIR = '/tmp/myco-anchor/.myco';
const ANCHOR_PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ANCHOR_GROVE_ID = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const PROJECT_B_ID = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PROJECT_B_GROVE_ID = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PROJECT_B_VAULT_DIR = '/tmp/myco-project-b/.myco';

const PROJECT_C_ID = 'proj_cccccccccccccccccccccccccccccccc';
const PROJECT_C_GROVE_ID = 'grove_cccccccccccccccccccccccccccccccc';
const PROJECT_C_VAULT_DIR = '/tmp/myco-project-c/.myco';

/**
 * Build a caller-sourced (authorized) request context for a tenant project.
 * `tenancySource: 'caller'` is what survives the context-switch auth gate and
 * is the only provenance `tenantRoute` accepts.
 */
function callerContext(opts: {
  vaultDir: string;
  projectId: string;
  groveId: string;
}): MycoRequestContext {
  return resolveLegacyRequestContext(opts.vaultDir, {
    projectId: assertGroveProjectId(opts.projectId),
    groveId: opts.groveId,
    machineId: 'test-machine',
    tenancySource: 'caller',
  });
}

/** Derive the principal a `tenantRoute` would hand the cortex handlers. */
function principalFor(ctx: MycoRequestContext): RequestPrincipal {
  return {
    identity: { machineId: ctx.machineId, userId: null },
    tenancy: {
      projectVaultDir: ctx.projectVaultDir as RequestPrincipal['tenancy']['projectVaultDir'],
      projectId: ctx.projectId,
      groveId: ctx.groveId ?? '',
      requestContext: {
        projectVaultDir: ctx.projectVaultDir,
        projectId: ctx.projectId,
        groveId: ctx.groveId ?? '',
      },
    },
  };
}

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    requestContext: TEST_REQUEST_CONTEXT,
    pathname: '/api/cortex',
    ...overrides,
  } as RouteRequest;
}

describe('createCortexHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Handlers no longer take an anchor vault: every op resolves its vault from
  // the REQUEST's tenant. The dead `_anchorVaultDir` param was removed (Fix
  // #10b). A correct handler must act against the request tenant — never any
  // bootstrap anchor — which the ANCHOR_* constants below still assert against.
  function makeHandlers() {
    return createCortexHandlers({
      liveConfig: { current: MycoConfigSchema.parse({ version: 3 }) },
      resolveEmbeddingManager: () => ({ reconcile: vi.fn() } as never),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
  }

  it('returns the stored Cortex snapshot without triggering a task run', async () => {
    getCortexInstructionsSnapshot.mockReturnValue({
      content: 'Stored instructions',
      generatedAt: 123,
      sourceRunId: 'run-1',
      enabled: true,
      stored: true,
    });
    const handlers = makeHandlers();

    const ctx = callerContext({
      vaultDir: PROJECT_B_VAULT_DIR,
      projectId: PROJECT_B_ID,
      groveId: PROJECT_B_GROVE_ID,
    });
    const response = await handlers.handleGetInstructions(makeRequest({ requestContext: ctx }), principalFor(ctx));

    expect(response.body).toEqual({
      content: 'Stored instructions',
      generatedAt: 123,
      sourceRunId: 'run-1',
      enabled: true,
      stored: true,
    });
    expect(getCortexInstructionsSnapshot).toHaveBeenCalledTimes(1);
    expect(triggerCortexInstructions).not.toHaveBeenCalled();
  });

  it('uses the event-driven trigger for manual refresh', async () => {
    triggerCortexInstructions.mockResolvedValue({
      started: true,
      runId: 'run-cortex-refresh',
    });
    const handlers = makeHandlers();

    const ctx = callerContext({
      vaultDir: PROJECT_B_VAULT_DIR,
      projectId: PROJECT_B_ID,
      groveId: PROJECT_B_GROVE_ID,
    });
    const response = await handlers.handleRefreshInstructions(makeRequest({ requestContext: ctx }), principalFor(ctx));

    expect(response.body).toEqual({
      started: true,
      runId: 'run-cortex-refresh',
    });
    expect(triggerCortexInstructions).toHaveBeenCalledTimes(1);
    expect(getCortexInstructionsSnapshot).not.toHaveBeenCalled();
  });

  it('returns 400 when refresh is rejected for misconfig reasons', async () => {
    triggerCortexInstructions.mockResolvedValue({
      started: false,
      reason: 'provider-not-configured',
    });
    const handlers = makeHandlers();

    const ctx = callerContext({
      vaultDir: PROJECT_B_VAULT_DIR,
      projectId: PROJECT_B_ID,
      groveId: PROJECT_B_GROVE_ID,
    });
    const response = await handlers.handleRefreshInstructions(makeRequest({ requestContext: ctx }), principalFor(ctx));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: 'provider-not-configured' },
      started: false,
      reason: 'provider-not-configured',
    });
  });

  it('passes builder requests through to the prompt builder service', async () => {
    buildCortexPrompt.mockResolvedValue({
      started: true,
      runId: 'run-builder-1',
      inlineInstructions: false,
      targetSymbiont: null,
    });
    const handlers = makeHandlers();

    const ctx = callerContext({
      vaultDir: PROJECT_B_VAULT_DIR,
      projectId: PROJECT_B_ID,
      groveId: PROJECT_B_GROVE_ID,
    });
    const response = await handlers.handleBuildPrompt(
      makeRequest({
        requestContext: ctx,
        body: {
          goal: 'Build Cortex',
          symbiont: 'codex',
        },
      }),
      principalFor(ctx),
    );

    expect(response.body).toEqual({
      started: true,
      runId: 'run-builder-1',
      inlineInstructions: false,
      targetSymbiont: null,
    });
    expect(buildCortexPrompt).toHaveBeenCalledTimes(1);
  });

  it('returns prompt-builder run status from the Cortex service', async () => {
    getCortexPromptResult.mockReturnValue({
      runId: 'run-builder-1',
      status: 'completed',
      prompt: 'Prompt output',
      reports: [],
      error: null,
    });
    const handlers = makeHandlers();

    const ctx = callerContext({
      vaultDir: PROJECT_B_VAULT_DIR,
      projectId: PROJECT_B_ID,
      groveId: PROJECT_B_GROVE_ID,
    });
    const response = await handlers.handleGetPromptResult(
      makeRequest({ requestContext: ctx, params: { runId: 'run-builder-1' } }),
      principalFor(ctx),
    );

    expect(response.body).toEqual({
      runId: 'run-builder-1',
      status: 'completed',
      prompt: 'Prompt output',
      reports: [],
      error: null,
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-tenant scoping: the reference fix. The handlers are wired with the
  // daemon's ANCHOR vault (project A). A refresh / prompt-builder request from
  // a DIFFERENT tenant must dispatch against THAT tenant's vault — never the
  // anchor.
  // ---------------------------------------------------------------------------

  describe('multi-tenant scoping (refresh + prompt-builder follow the request, not the anchor)', () => {
    it('refresh for project B dispatches against B, not the bootstrap anchor', async () => {
      triggerCortexInstructions.mockResolvedValue({ started: true, runId: 'run-b' });
      const handlers = makeHandlers();

      const ctx = callerContext({
        vaultDir: PROJECT_B_VAULT_DIR,
        projectId: PROJECT_B_ID,
        groveId: PROJECT_B_GROVE_ID,
      });
      await handlers.handleRefreshInstructions(makeRequest({ requestContext: ctx }), principalFor(ctx));

      expect(triggerCortexInstructions).toHaveBeenCalledTimes(1);
      const arg = triggerCortexInstructions.mock.calls[0][0];
      expect(arg.vaultDir).toBe(PROJECT_B_VAULT_DIR);
      expect(arg.vaultDir).not.toBe(ANCHOR_VAULT_DIR);
      expect(arg.requestContext.projectId).toBe(PROJECT_B_ID);
      expect(arg.requestContext.groveId).toBe(PROJECT_B_GROVE_ID);
      expect(arg.requestContext.projectId).not.toBe(ANCHOR_PROJECT_ID);
    });

    it('refresh for a DIFFERENT project C dispatches against C (follows the request, no hardcode)', async () => {
      triggerCortexInstructions.mockResolvedValue({ started: true, runId: 'run-c' });
      const handlers = makeHandlers();

      const ctx = callerContext({
        vaultDir: PROJECT_C_VAULT_DIR,
        projectId: PROJECT_C_ID,
        groveId: PROJECT_C_GROVE_ID,
      });
      await handlers.handleRefreshInstructions(makeRequest({ requestContext: ctx }), principalFor(ctx));

      const arg = triggerCortexInstructions.mock.calls[0][0];
      expect(arg.vaultDir).toBe(PROJECT_C_VAULT_DIR);
      expect(arg.requestContext.projectId).toBe(PROJECT_C_ID);
      expect(arg.requestContext.groveId).toBe(PROJECT_C_GROVE_ID);
      expect(arg.requestContext.projectId).not.toBe(ANCHOR_PROJECT_ID);
    });

    it('prompt-builder for project B dispatches against B, not the bootstrap anchor', async () => {
      buildCortexPrompt.mockResolvedValue({
        started: true,
        runId: 'run-builder-b',
        inlineInstructions: false,
        targetSymbiont: null,
      });
      const handlers = makeHandlers();

      const ctx = callerContext({
        vaultDir: PROJECT_B_VAULT_DIR,
        projectId: PROJECT_B_ID,
        groveId: PROJECT_B_GROVE_ID,
      });
      await handlers.handleBuildPrompt(
        makeRequest({ requestContext: ctx, body: { goal: 'Build Cortex' } }),
        principalFor(ctx),
      );

      expect(buildCortexPrompt).toHaveBeenCalledTimes(1);
      // buildCortexPrompt(vaultDir, deps, goal, symbiont, requestContext)
      const call = buildCortexPrompt.mock.calls[0];
      const vaultDirArg = call[0];
      const requestContextArg = call[call.length - 1];
      expect(vaultDirArg).toBe(PROJECT_B_VAULT_DIR);
      expect(vaultDirArg).not.toBe(ANCHOR_VAULT_DIR);
      expect(requestContextArg.projectId).toBe(PROJECT_B_ID);
      expect(requestContextArg.groveId).toBe(PROJECT_B_GROVE_ID);
      expect(requestContextArg.projectId).not.toBe(ANCHOR_PROJECT_ID);
    });
  });

  // ---------------------------------------------------------------------------
  // tenantRoute wrapper: a synthesized (anchor-fallback) context must be
  // rejected 400 + `tenancy.violation` before the handler runs against any
  // tenant vault.
  // ---------------------------------------------------------------------------

  describe('tenantRoute wrapper rejects synthesized tenancy', () => {
    it('refresh with a synthesized context returns 400 + tenancy.violation and never dispatches', async () => {
      const handlers = makeHandlers();
      const warn = vi.fn();
      const wrapped = tenantRoute(
        { machineId: 'test-machine', logger: { warn } as never },
        handlers.handleRefreshInstructions,
      );

      // Synthesized = the daemon's bootstrap-anchor fallback (tenancySource
      // defaults to 'synthesized'). This is what every request carries before
      // a caller explicitly supplies project/grove identity.
      const synthesized = resolveLegacyRequestContext(ANCHOR_VAULT_DIR, {
        projectId: assertGroveProjectId(ANCHOR_PROJECT_ID),
        groveId: ANCHOR_GROVE_ID,
        machineId: 'test-machine',
        // tenancySource omitted -> 'synthesized'
      });

      const response = await wrapped(makeRequest({ requestContext: synthesized }));

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: 'tenancy-violation' } });
      expect(warn).toHaveBeenCalledWith(
        'tenancy.violation',
        expect.any(String),
        expect.objectContaining({ pathname: '/api/cortex' }),
      );
      expect(triggerCortexInstructions).not.toHaveBeenCalled();
    });
  });
});
