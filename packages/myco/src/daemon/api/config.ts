import {
  loadConfig,
  updateConfig,
  loadMergedConfig,
  loadLocalConfig,
  saveLocalConfig,
  clearLocalConfigKeys,
  deepMergeConfig,
} from '../../config/loader.js';
import { z } from 'zod';
import { MycoConfigSchema, type MycoConfig } from '../../config/schema.js';
import type { PlanWatchConfig } from '../plan-capture.js';
import type { RouteRequest, RouteResponse } from '../router.js';

export async function handleGetConfig(vaultDir: string): Promise<RouteResponse> {
  const config = loadConfig(vaultDir);
  return { body: config };
}

// ---------------------------------------------------------------------------
// Scoped config handlers (project vs. local overlay)
// ---------------------------------------------------------------------------

/** GET /api/config/merged — project config with local overlay applied. */
export async function handleGetMergedConfig(vaultDir: string): Promise<RouteResponse> {
  const config = loadMergedConfig(vaultDir);
  return { body: config };
}

/** GET /api/config/local — raw local overrides (may be empty). */
export async function handleGetLocalConfig(vaultDir: string): Promise<RouteResponse> {
  return { body: loadLocalConfig(vaultDir) };
}

interface ScopedPutBody {
  scope?: 'project' | 'local';
  patch?: Record<string, unknown>;
}

/** PUT /api/config/scoped — deep-merge a partial patch into project or local config. */
export async function handlePutScopedConfig(vaultDir: string, body: unknown): Promise<RouteResponse> {
  const payload = (body ?? {}) as ScopedPutBody;
  const scope = payload.scope ?? 'project';
  const patch = payload.patch;

  if (!patch || typeof patch !== 'object') {
    return { status: 400, body: { error: 'patch required' } };
  }

  if (scope === 'local') {
    const updated = saveLocalConfig(vaultDir, patch as Partial<MycoConfig>);
    return { body: updated };
  }

  try {
    const updated = updateConfig(vaultDir, (current) => {
      const merged = deepMergeConfig(current as Record<string, unknown>, patch as Record<string, unknown>);
      return MycoConfigSchema.parse(merged);
    });
    return { body: updated };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { status: 400, body: { error: 'validation_failed', issues: err.issues } };
    }
    throw err;
  }
}

interface ClearLocalBody { keys?: string[]; }

/** POST /api/config/local/clear — delete specific keys (supports dotted paths) from local overrides. */
export async function handleClearLocalConfig(vaultDir: string, body: unknown): Promise<RouteResponse> {
  const { keys } = (body ?? {}) as ClearLocalBody;
  if (!Array.isArray(keys) || keys.length === 0) {
    return { status: 400, body: { error: 'keys array required' } };
  }
  const updated = clearLocalConfigKeys(vaultDir, keys);
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
  reconcileProjectFiles?: () => void;
}

interface PlanDirRequestBody {
  plan_dirs: string[];
  ignore_plan_dirs_in_git?: boolean;
}

export function createPlanDirHandlers(deps: PlanDirDeps) {
  const { vaultDir, symbiontPlanDirsByAgent, symbiontPlanDirs } = deps;

  /** GET /api/config/plan-dirs */
  async function handleGetPlanDirs(_req: RouteRequest): Promise<RouteResponse> {
    const config = loadConfig(vaultDir);
    return {
      body: {
        symbiont: symbiontPlanDirsByAgent,
        custom: deps.planWatchConfig.watchDirs.filter((d) => !symbiontPlanDirs.includes(d)),
        ignore_plan_dirs_in_git: config.capture.ignore_plan_dirs_in_git,
      },
    };
  }

  /** POST /api/config/plan-dirs */
  async function handleUpdatePlanDirs(req: RouteRequest): Promise<RouteResponse> {
    const body = req.body as PlanDirRequestBody;
    if (!Array.isArray(body.plan_dirs)) {
      return { status: 400, body: { error: 'plan_dirs must be an array' } };
    }
    if (body.ignore_plan_dirs_in_git !== undefined && typeof body.ignore_plan_dirs_in_git !== 'boolean') {
      return { status: 400, body: { error: 'ignore_plan_dirs_in_git must be a boolean' } };
    }
    const updated = updateConfig(vaultDir, (cfg) => ({
      ...cfg,
      capture: {
        ...cfg.capture,
        plan_dirs: body.plan_dirs,
        ignore_plan_dirs_in_git: body.ignore_plan_dirs_in_git ?? cfg.capture.ignore_plan_dirs_in_git,
      },
    }));
    // Refresh in-memory config so plan capture picks up new dirs immediately
    deps.setPlanWatchConfig({
      ...deps.planWatchConfig,
      watchDirs: [...new Set([...symbiontPlanDirs, ...body.plan_dirs])],
    });
    deps.reconcileProjectFiles?.();
    return {
      body: {
        custom: updated.capture.plan_dirs,
        ignore_plan_dirs_in_git: updated.capture.ignore_plan_dirs_in_git,
      },
    };
  }

  return { handleGetPlanDirs, handleUpdatePlanDirs };
}
