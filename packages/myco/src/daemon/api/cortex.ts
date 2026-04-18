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
} from '@myco/services/cortex.js';
import { triggerCortexInstructions } from '../trigger-cortex-instructions.js';

export interface CortexDeps {
  liveConfig: { current: MycoConfig };
  getTeamClient?: () => TeamSyncClient | null;
  embeddingManager: EmbeddingManager;
  logger: DaemonLogger;
}

const PromptBuilderBody = z.object({
  goal: z.string().trim().min(1),
  symbiont: z.string().trim().optional(),
});
const PromptBuilderStatusParams = z.object({
  runId: z.string().trim().min(1),
});

export function createCortexHandlers(vaultDir: string, deps: CortexDeps) {
  async function handleGetInstructions(): Promise<RouteResponse> {
    const snapshot = await getCortexInstructionsSnapshot(vaultDir, {
      config: deps.liveConfig.current,
      getTeamClient: deps.getTeamClient,
    });
    return { body: snapshot };
  }

  async function handleRefreshInstructions(): Promise<RouteResponse> {
    const result = await triggerCortexInstructions({
      vaultDir,
      embeddingManager: deps.embeddingManager,
      liveConfig: deps.liveConfig,
      logger: deps.logger,
      getTeamClient: deps.getTeamClient,
    });
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
      },
      goal,
      symbiont,
    );
    return { body: result };
  }

  async function handleGetPromptResult(req: RouteRequest): Promise<RouteResponse> {
    const { runId } = PromptBuilderStatusParams.parse(req.params);
    const result = getCortexPromptResult(runId);
    if (!result) {
      return { status: 404, body: { error: 'Run not found' } };
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
