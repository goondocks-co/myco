import {
  loadConfig,
  updateConfig,
  updateLocalConfig,
  loadMergedConfig,
  loadLocalConfig,
  clearLocalConfigKeys,
  deepMergeConfig,
} from '../../config/loader.js';
import { z } from 'zod';
import { MycoConfigSchema, type MycoConfig } from '../../config/schema.js';
import { unsetAtPath } from '../../utils/dot-path.js';
import { enumerateLeafPaths } from '../config-reactions/touched-paths.js';
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
  clear?: string[];
}

/**
 * PUT /api/config/scoped — atomic patch + clear against project or local config.
 *
 * Request body:
 *   { scope: 'project' | 'local',
 *     patch?: DeepPartial<MycoConfig>,   // deep-merged into scope
 *     clear?: string[] }                  // dot-paths removed from scope
 *
 * At least one of `patch` (non-empty object) or `clear` (non-empty array) is
 * required. If both are present, overlapping keys are rejected (400). The
 * server applies `clear` first, then merges `patch`, in a single write.
 */
export async function handlePutScopedConfig(vaultDir: string, body: unknown): Promise<RouteResponse> {
  const payload = (body ?? {}) as ScopedPutBody;
  const scope = payload.scope ?? 'project';
  const patch = payload.patch ?? {};
  const clear = payload.clear;

  if (clear !== undefined && !Array.isArray(clear)) {
    return { status: 400, body: { error: 'clear must be an array of dot-paths' } };
  }
  const clearList = clear ?? [];

  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { status: 400, body: { error: 'patch must be an object' } };
  }
  const patchLeaves = enumerateLeafPaths(patch);
  const hasPatch = patchLeaves.length > 0;
  const hasClear = clearList.length > 0;
  if (!hasPatch && !hasClear) {
    return { status: 400, body: { error: 'patch or clear required' } };
  }

  const overlap = patchLeaves.filter((leaf) => clearList.includes(leaf));
  if (overlap.length > 0) {
    return { status: 400, body: { error: 'patch_clear_overlap', keys: overlap } };
  }

  if (scope === 'local') {
    const updated = updateLocalConfig(vaultDir, (local) => {
      const working = structuredClone(local) as Record<string, unknown>;
      for (const key of clearList) unsetAtPath(working, key);
      return deepMergeConfig(working, patch as Record<string, unknown>) as Partial<MycoConfig>;
    });
    return { body: updated };
  }

  try {
    const updated = updateConfig(vaultDir, (current) => {
      const working = structuredClone(current) as Record<string, unknown>;
      for (const key of clearList) unsetAtPath(working, key);
      const merged = deepMergeConfig(working, patch as Record<string, unknown>);
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
