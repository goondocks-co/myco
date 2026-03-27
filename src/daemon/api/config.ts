import { loadConfig, updateConfig } from '../../config/loader.js';
import { MycoConfigSchema } from '../../config/schema.js';
import type { RouteResponse } from '../router.js';

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
  const updated = updateConfig(vaultDir, () => result.data);
  return { body: updated };
}
