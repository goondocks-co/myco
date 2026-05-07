import { z } from 'zod';
import type { MycoConfig } from '@myco/config/schema.js';
import type { TeamSyncClient } from '../team-sync.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { DaemonLogger } from '../logger.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import {
  buildCortexPrompt,
  getCortexPromptResult,
  getCortexInstructionsSnapshot,
  triggerCortexInstructions,
} from '../cortex.js';
import { errorBody } from './error-envelope.js';

export interface CortexDeps {
  liveConfig: { current: MycoConfig };
  getTeamClient?: () => TeamSyncClient | null;
  embeddingManager: EmbeddingManager;
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

export function createCortexHandlers(vaultDir: string, deps: CortexDeps) {
  async function handleGetInstructions(req: RouteRequest): Promise<RouteResponse> {
    const projectId = req.requestContext?.projectId ?? null;
    const snapshot = getCortexInstructionsSnapshot(deps.liveConfig.current, projectId);
    return { body: snapshot };
  }

  async function handleRefreshInstructions(): Promise<RouteResponse> {
    const result = await triggerCortexInstructions({
      vaultDir,
      embeddingManager: deps.embeddingManager,
      liveConfig: deps.liveConfig,
      logger: deps.logger,
      getTeamClient: deps.getTeamClient,
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

  async function handleBuildPrompt(req: RouteRequest): Promise<RouteResponse> {
    const { goal, symbiont } = PromptBuilderBody.parse(req.body);
    const result = await buildCortexPrompt(
      vaultDir,
      {
        config: deps.liveConfig.current,
        embeddingManager: deps.embeddingManager,
        getTeamClient: deps.getTeamClient,
        logger: deps.logger,
        registerInflightRun: deps.registerInflightRun,
      },
      goal,
      symbiont,
    );
    return { body: result };
  }

  async function handleGetPromptResult(req: RouteRequest): Promise<RouteResponse> {
    const { runId } = PromptBuilderStatusParams.parse(req.params);
    const result = getCortexPromptResult(runId, req.requestContext?.projectId ?? null);
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
