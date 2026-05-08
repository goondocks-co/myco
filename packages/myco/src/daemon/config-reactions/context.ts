import { z } from 'zod';
import { loadMergedConfig, type LoadMergedConfigOptions } from '../../config/loader.js';
import type { MycoConfig } from '../../config/schema.js';
import type { Logger } from '../logger.js';

/**
 * Best-effort merged config load for post-write reactions. A stale invalid
 * local overlay should not turn an already-persisted scoped write into a 500.
 *
 * Pass `options.groveId` so reactions see the full four-tier merge
 * (machine + grove + project + personal) instead of falling back to
 * Grove-tier defaults.
 */
export function loadReactionContext(
  vaultDir: string,
  logger: Logger,
  options: LoadMergedConfigOptions = {},
): MycoConfig | null {
  try {
    return loadMergedConfig(vaultDir, options);
  } catch (err) {
    if (err instanceof z.ZodError) {
      logger.warn('config-reactions', 'skipping reactions because merged config is invalid', {
        issues: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return null;
    }
    throw err;
  }
}
