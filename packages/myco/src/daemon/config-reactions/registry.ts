/**
 * In-process registry for "things that should happen after any successful
 * scoped-config write." Reactions register once at daemon startup with a
 * list of path prefixes; `fire(touchedPaths)` runs every reaction whose
 * registered prefixes match.
 *
 * Contract (documented, not enforced):
 * - A reaction MUST be idempotent: firing twice with the same touched paths
 *   produces the same observable state.
 * - A reaction MUST NOT issue a scoped-config write itself (would recurse).
 */

import type { Logger } from '../logger.js';
import type { MycoConfig } from '../../config/schema.js';

export type ConfigReaction = (ctx: MycoConfig) => void | Promise<void>;

export interface ConfigReactionRegistry {
  /**
   * Register a reaction. `paths` is a list of dot-path prefixes. The reaction
   * fires when any touched path matches any listed prefix. Pass `[]` to fire
   * on every write.
   *
   * A prefix `p` matches a touched path `t` when `t === p` or
   * `t.startsWith(p + '.')`. So `'capture'` matches `'capture.plan_dirs'`
   * but not `'captures.x'` or `'capture_mode'`.
   *
   * The reaction receives the post-write merged config (project + local
   * overlay). Use this instead of reloading — the registry has already paid
   * the YAML + schema parse cost once.
   */
  on(paths: string[], reaction: ConfigReaction): void;

  /**
   * Fire every matching reaction in registration order. Awaits each in turn.
   * If a reaction throws, the error is logged and subsequent reactions still
   * run — the scoped write itself has already succeeded by this point.
   */
  fire(touchedPaths: string[], ctx: MycoConfig): Promise<void>;
}

interface Entry {
  paths: string[];
  fn: ConfigReaction;
}

export function createConfigReactionRegistry(logger: Logger): ConfigReactionRegistry {
  const entries: Entry[] = [];

  return {
    on(paths, fn) {
      entries.push({ paths, fn });
    },
    async fire(touchedPaths, ctx) {
      for (const entry of entries) {
        if (!shouldFire(entry.paths, touchedPaths)) continue;
        try {
          await entry.fn(ctx);
        } catch (err) {
          logger.error('config-reactions', 'reaction threw', { error: String(err) });
        }
      }
    },
  };
}

function shouldFire(registeredPaths: string[], touched: string[]): boolean {
  if (registeredPaths.length === 0) return true;
  for (const prefix of registeredPaths) {
    for (const path of touched) {
      if (path === prefix || path.startsWith(`${prefix}.`)) return true;
    }
  }
  return false;
}
