import { z } from 'zod';
import { loadMergedConfig } from '../../config/loader.js';
import type { MycoConfig } from '../../config/schema.js';
import type { Logger } from '../logger.js';

/**
 * Best-effort merged config load for post-write reactions. A stale invalid
 * local overlay should not turn an already-persisted scoped write into a 500.
 */
export function loadReactionContext(vaultDir: string, logger: Logger): MycoConfig | null {
  try {
    return loadMergedConfig(vaultDir);
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
