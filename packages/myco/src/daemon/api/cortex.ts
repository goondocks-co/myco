import { z } from 'zod';
import type { MycoConfig } from '@myco/config/schema.js';
import { resolveTenantConfig } from '../request-config.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import type { DaemonLogger } from '../logger.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { RequestPrincipal } from '../request-principal.js';
import {
  buildCortexPrompt,
  getCortexPromptResult,
  getCortexInstructionsSnapshot,
  triggerCortexInstructions,
} from '../cortex.js';
import { errorBody } from './error-envelope.js';

export interface CortexDeps {
  liveConfig: { current: MycoConfig };
  /** Resolve the grove EmbeddingManager for the request — never the bootstrap
   *  manager (anchor-leak Variant A). */
  resolveEmbeddingManager: (requestContext: MycoRequestContext) => EmbeddingManager;
  logger: DaemonLogger;
  /** Optional registry that tracks fire-and-forget runs so daemon shutdown can await them. */
  registerInflightRun?: (promise: Promise<unknown>) => void;
}

const PromptBuilderBody = z.object({
  goal: z.string().trim().min(1),
  symbiont: z.string().trim().optional(),
});
const PromptBuilderStatusParams = z.object({
  runId: z.string().trim().min(1),
});

export function createCortexHandlers(deps: CortexDeps) {
  // Resolve config for the REQUEST's tenant (grove/project-tier `cortex.*`),
  // falling back to the daemon's `liveConfig` only when no tenant context is
  // resolved. Mirrors the pattern in event-dispatch / stop-processing.
  function configForRequest(req: RouteRequest): MycoConfig {
    return resolveTenantConfig(req.requestContext, deps.liveConfig.current, { logger: deps.logger });
  }

  async function handleGetInstructions(
    req: RouteRequest,
    principal: RequestPrincipal,
  ): Promise<RouteResponse> {
    const scope: import('@myco/grove/ids.js').ProjectScope = {
      kind: 'project',
      id: principal.tenancy.projectId as import('@myco/grove/ids.js').GroveProjectId,
    };
    // The snapshot's `enabled` flag reads grove/project-tier `cortex.*` config,
    // so resolve it from the REQUEST's tenant — not the daemon's bootstrap-home
    // `liveConfig` (a phantom home post-Phase-5).
    const config = configForRequest(req);
    const snapshot = getCortexInstructionsSnapshot(config, scope);
    return { body: snapshot };
  }

  async function handleRefreshInstructions(
    req: RouteRequest,
    principal: RequestPrincipal,
  ): Promise<RouteResponse> {
    const result = await triggerCortexInstructions({
      vaultDir: principal.tenancy.projectVaultDir,
      requestContext: req.requestContext!,
      resolveEmbeddingManager: deps.resolveEmbeddingManager,
      logger: deps.logger,
      registerInflightRun: deps.registerInflightRun,
    });
    if (!result.started && (result.reason === 'provider-not-configured' || result.reason === 'event-tasks-disabled')) {
      return {
        status: 400,
        body: {
          ...errorBody(
            result.reason,
            result.reason === 'provider-not-configured'
              ? 'No agent provider configured. Configure one in Settings.'
              : 'Event-driven tasks are disabled. Enable them in Settings.',
          ),
          started: false,
          reason: result.reason,
        },
      };
    }
    return { body: result };
  }

  async function handleBuildPrompt(
    req: RouteRequest,
    principal: RequestPrincipal,
  ): Promise<RouteResponse> {
    const { goal, symbiont } = PromptBuilderBody.parse(req.body);
    const result = await buildCortexPrompt(
      principal.tenancy.projectVaultDir,
      {
        resolveEmbeddingManager: deps.resolveEmbeddingManager,
        logger: deps.logger,
        registerInflightRun: deps.registerInflightRun,
      },
      goal,
      symbiont,
      req.requestContext!,
    );
    return { body: result };
  }

  async function handleGetPromptResult(
    req: RouteRequest,
    principal: RequestPrincipal,
  ): Promise<RouteResponse> {
    const { runId } = PromptBuilderStatusParams.parse(req.params);
    const promptScope: import('@myco/grove/ids.js').ProjectScope = {
      kind: 'project',
      id: principal.tenancy.projectId as import('@myco/grove/ids.js').GroveProjectId,
    };
    const result = getCortexPromptResult(runId, promptScope);
    if (!result) {
      return { status: 404, body: errorBody('run-not-found', 'Run not found') };
    }
    return { body: result };
  }

  return {
    handleGetInstructions,
    handleRefreshInstructions,
    handleBuildPrompt,
    handleGetPromptResult,
  };
}
