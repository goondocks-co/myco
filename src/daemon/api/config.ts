import { loadConfig, updateConfig } from '../../config/loader.js';
import { MycoConfigSchema, type MycoConfig } from '../../config/schema.js';
import type { RouteResponse } from '../router.js';

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
