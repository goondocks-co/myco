/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Shared multi-Grove "pending work" probe for PowerManager deep-sleep holds.
 *
 * The embedding-reconcile and canopy-describe holds both need the same
 * question answered every PowerManager tick: "is there pending work in any
 * Grove this daemon serves?" Each used to carry its own copy of the
 * Grove-walk + caching + warn-rate-limit scaffolding. This factory unifies
 * that scaffolding; callers supply only a per-Grove count via `countForGrove`.
 */

import type { DaemonLogger } from './logger.js';
import type { GroveRuntimeCache } from './grove-runtime-cache.js';
import { listGroves, type GroveRecord } from '@myco/grove/registry.js';
import { resolveMycoHome, resolveGroveDbPath, resolveServiceDirName } from '@myco/grove/paths.js';
import { withDatabase } from '@myco/db/client.js';
import { errorMessage } from '@myco/utils/error-message.js';

// The hold only needs ">0"; a stale value within this window is safe and
// stops the per-tick re-walk (SQLite COUNTs across every Grove). Caching
// BOTH zero and non-zero is the whole point — caching only zero meant a
// draining backlog re-walked every Grove on every tick.
export const GROVE_PENDING_PROBE_TTL_MS = 30_000;

// Rate-limit window for per-Grove probe failures. The probe fires on every
// tick; one warn per hour per Grove surfaces persistent breakage without
// flooding the daemon log.
const PROBE_WARN_INTERVAL_MS = 60 * 60 * 1000;

export interface GrovePendingProbeDeps {
  cache: GroveRuntimeCache;
  logger: DaemonLogger;
  /** The current daemon's service dir; enforces the served-by boundary. */
  daemonStateDir: string;
  /** Override Myco home (tests); defaults to the resolved global home. */
  mycoHome?: string;
  /** Warn LOG_KIND used when a Grove's count throws. */
  logKind: string;
  ttlMs?: number;
  /**
   * Count pending work for ONE Grove. Runs INSIDE `withDatabase(groveDb)`,
   * so ambient-db queries (e.g. `countPendingCanopyDescribe(null, ...)`,
   * `EmbeddingManager.totalPendingCount()`) resolve against the Grove DB.
   * Return >0 to hold the daemon awake. Throwing is caught + rate-limited.
   */
  countForGrove: (ctx: {
    grove: GroveRecord;
    databasePath: string;
    mycoHome: string;
  }) => number;
}

interface ProbeCache {
  total: number;
  expiresAt: number;
}

/**
 * Build a multi-Grove pending probe. `mycoHome`/`servedBy` are resolved once
 * at factory call (not per invocation) since neither changes for the daemon's
 * lifetime. The returned closure walks every served Grove, sums
 * `countForGrove`, short-circuits on the first positive, and caches the
 * result (zero AND non-zero) for `ttlMs`.
 */
export function makeGrovePendingProbe(deps: GrovePendingProbeDeps): () => number {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const servedBy = resolveServiceDirName(deps.daemonStateDir, mycoHome);
  const ttlMs = deps.ttlMs ?? GROVE_PENDING_PROBE_TTL_MS;
  let cache: ProbeCache | null = null;
  // Per-Grove last-warn timestamps so a persistently-broken Grove surfaces
  // in logs without flooding on every tick.
  const lastWarnAt = new Map<string, number>();

  return () => {
    if (cache && Date.now() < cache.expiresAt) return cache.total;
    let total = 0;
    for (const grove of listGroves(mycoHome, { servedBy })) {
      try {
        const databasePath = resolveGroveDbPath(grove.id, mycoHome);
        const db = deps.cache.getDatabase(databasePath);
        // withDatabase is sync (AsyncLocalStorage.run returns fn's value).
        total += withDatabase(db, () => deps.countForGrove({ grove, databasePath, mycoHome }));
        if (total > 0) break; // short-circuit; cached below
      } catch (err) {
        // Swallow per-Grove failure — better to risk an early sleep than
        // hold the whole machine awake on a transiently-broken signal. But
        // surface it at warn level (rate-limited per Grove) so persistent
        // breakage is visible in the daemon log.
        const now = Date.now();
        const last = lastWarnAt.get(grove.id) ?? 0;
        if (now - last >= PROBE_WARN_INTERVAL_MS) {
          lastWarnAt.set(grove.id, now);
          deps.logger.warn(deps.logKind, 'Grove pending-probe failed', {
            grove_id: grove.id,
            grove_slug: grove.slug,
            error: errorMessage(err),
          });
        }
      }
    }
    // Cache BOTH zero and non-zero: the hold only needs ">0", so a stale
    // value within the TTL is safe and avoids re-walking every Grove on
    // every tick while a backlog drains.
    cache = { total, expiresAt: Date.now() + ttlMs };
    return total;
  };
}
