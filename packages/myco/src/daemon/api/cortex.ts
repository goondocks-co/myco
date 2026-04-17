import { z } from 'zod';
import type { MycoConfig } from '@myco/config/schema.js';
import type { TeamSyncClient } from '../team-sync.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import {
  buildCortexPrompt,
  getCortexInstructionsSnapshot,
  refreshCortexInstructions,
} from '@myco/services/cortex.js';

export interface CortexDeps {
  liveConfig: { current: MycoConfig };
  getTeamClient?: () => TeamSyncClient | null;
}

const PromptBuilderBody = z.object({
  goal: z.string().trim().min(1),
  symbiont: z.string().trim().optional(),
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
    const snapshot = await refreshCortexInstructions(vaultDir, {
      config: deps.liveConfig.current,
      getTeamClient: deps.getTeamClient,
    });
    return { body: snapshot };
  }

  async function handleBuildPrompt(req: RouteRequest): Promise<RouteResponse> {
    const { goal, symbiont } = PromptBuilderBody.parse(req.body);
    const result = await buildCortexPrompt(
      vaultDir,
      {
        config: deps.liveConfig.current,
        getTeamClient: deps.getTeamClient,
      },
      goal,
      symbiont,
    );
    return { body: result };
  }

  return {
    handleGetInstructions,
    handleRefreshInstructions,
    handleBuildPrompt,
  };
}
