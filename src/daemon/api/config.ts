import { loadConfig, updateConfig } from '../../config/loader.js';
import { MycoConfigSchema, type MycoConfig } from '../../config/schema.js';
import type { PlanWatchConfig } from '../plan-capture.js';
import type { RouteRequest, RouteResponse } from '../router.js';

/**
 * Section-level deep merge: for each top-level section in `incoming`, merge it
 * into `current` — incoming fields overwrite, but fields in `current` that are
 * absent from `incoming` survive. This prevents a save that only touches
 * `context.digest_tier` from wiping `agent.tasks`.
 */
function mergeConfigSections(current: MycoConfig, incoming: MycoConfig): MycoConfig {
  return {
    ...current,
    daemon: { ...current.daemon, ...incoming.daemon },
    embedding: { ...current.embedding, ...incoming.embedding },
    capture: { ...current.capture, ...incoming.capture },
    agent: { ...current.agent, ...incoming.agent },
    context: { ...current.context, ...incoming.context },
    backup: { ...current.backup, ...incoming.backup },
    team: { ...current.team, ...incoming.team },
    notifications: { ...current.notifications, ...incoming.notifications },
  };
}

export async function handleGetConfig(vaultDir: string): Promise<RouteResponse> {
  const config = loadConfig(vaultDir);
  return { body: config };
}

export async function handlePutConfig(vaultDir: string, body: unknown): Promise<RouteResponse> {
  const result = MycoConfigSchema.safeParse(body);
  if (!result.success) {
    return {
      status: 400,
      body: { error: 'validation_failed', issues: result.error.issues },
    };
  }
  const updated = updateConfig(vaultDir, (current) => mergeConfigSections(current, result.data));
  return { body: updated };
}

// ---------------------------------------------------------------------------
// Plan-dirs factory (requires mutable references to runtime state)
// ---------------------------------------------------------------------------

export interface PlanDirDeps {
  vaultDir: string;
  symbiontPlanDirsByAgent: Record<string, string[]>;
  symbiontPlanDirs: string[];
  planWatchConfig: PlanWatchConfig;
  setPlanWatchConfig: (config: PlanWatchConfig) => void;
}

export function createPlanDirHandlers(deps: PlanDirDeps) {
  const { vaultDir, symbiontPlanDirsByAgent, symbiontPlanDirs } = deps;

  /** GET /api/config/plan-dirs */
  async function handleGetPlanDirs(_req: RouteRequest): Promise<RouteResponse> {
    return {
      body: {
        symbiont: symbiontPlanDirsByAgent,
        custom: deps.planWatchConfig.watchDirs.filter((d) => !symbiontPlanDirs.includes(d)),
      },
    };
  }

  /** POST /api/config/plan-dirs */
  async function handleUpdatePlanDirs(req: RouteRequest): Promise<RouteResponse> {
    const body = req.body as { plan_dirs: string[] };
    if (!Array.isArray(body.plan_dirs)) {
      return { status: 400, body: { error: 'plan_dirs must be an array' } };
    }
    const updated = updateConfig(vaultDir, (cfg) => ({
      ...cfg,
      capture: { ...cfg.capture, plan_dirs: body.plan_dirs },
    }));
    // Refresh in-memory config so plan capture picks up new dirs immediately
    deps.setPlanWatchConfig({
      ...deps.planWatchConfig,
      watchDirs: [...new Set([...symbiontPlanDirs, ...body.plan_dirs])],
    });
    return { body: { custom: updated.capture.plan_dirs } };
  }

  return { handleGetPlanDirs, handleUpdatePlanDirs };
}
