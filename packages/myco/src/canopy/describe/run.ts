/**
 * canopy-describe run loop.
 *
 * Scans `canopy_entries` for rows whose `llm_updated_at` is older than
 * `mechanical_updated_at` (or NULL) and produces an `llm_description`
 * for each via the single-shot executor + post-process. Idempotent:
 * unchanged rows are skipped because the freshness predicate
 * eliminates them at the SQL layer.
 *
 * On post-process rejection, the loop retries up to
 * `cortex.canopy.llm.max_attempts`. After the final attempt, the row's
 * `llm_description` stays NULL and the blob composer falls back to the
 * mechanical `top` line. A single row failing must not block the rest
 * of the batch — per-row errors are caught and counted.
 */

import type { Database } from 'bun:sqlite';
import type { MycoConfig } from '@myco/config/schema.js';
import type { CanopyEntry } from '@myco/db/schema.js';
import { runDescriber, type CanopyDescribeExecutorContext } from './executor.js';
import { postProcess } from './post-process.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CanopyDescribeRunContext {
  db: Database;
  projectId: string;
  projectRoot: string;
  config: MycoConfig;
  /** Optional cap on rows processed per invocation — defaults to 50. */
  rowLimit?: number;
  /** Override the executor for tests. */
  executor?: typeof runDescriber;
  /** Override the clock for deterministic tests. */
  now?: () => number;
}

export interface CanopyDescribeRunResult {
  scanned: number;
  written: number;
  rejected: number;
  errored: number;
  /** True when the run skipped because the feature is disabled or no provider is configured. */
  skipped: boolean;
  /** Reason for a skip — populated only when `skipped` is true. */
  skipReason?: 'disabled' | 'no-provider' | 'no-rows';
}

const DEFAULT_ROW_LIMIT = 50;

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

// Order: oldest mechanical timestamp first so freshly-rescanned files (likely
// the ones the user just edited) are described promptly. NULL-first via
// `llm_updated_at IS NULL DESC` puts never-described rows ahead of stale ones.
const SELECT_PENDING_SQL = `
  SELECT *
  FROM canopy_entries
  WHERE project_id = ?
    AND (
      llm_updated_at IS NULL
      OR llm_updated_at < mechanical_updated_at
    )
  ORDER BY (llm_updated_at IS NULL) DESC, mechanical_updated_at ASC
  LIMIT ?
`;

const UPDATE_DESCRIPTION_SQL = `
  UPDATE canopy_entries
  SET llm_description = ?,
      llm_updated_at  = ?
  WHERE project_id = ? AND path = ?
`;

// ---------------------------------------------------------------------------
// DB helpers (kept here — no other module needs these and the surface is small)
// ---------------------------------------------------------------------------

function listPending(db: Database, projectId: string, limit: number): CanopyEntry[] {
  return db.prepare(SELECT_PENDING_SQL).all(projectId, limit) as CanopyEntry[];
}

function writeDescription(
  db: Database,
  projectId: string,
  path: string,
  description: string,
  updatedAt: number,
): void {
  db.prepare(UPDATE_DESCRIPTION_SQL).run(description, updatedAt, projectId, path);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a single batch of canopy-describe over rows needing a description.
 *
 * Returns counts so the caller (PowerManager job, on-demand trigger) can
 * log a single line per batch instead of N lines per row.
 */
export async function runCanopyDescribe(
  ctx: CanopyDescribeRunContext,
): Promise<CanopyDescribeRunResult> {
  const llmConfig = ctx.config.cortex.canopy.llm;
  if (!llmConfig.enabled) {
    return zeroResult(true, 'disabled');
  }

  const limit = ctx.rowLimit ?? DEFAULT_ROW_LIMIT;
  const pending = listPending(ctx.db, ctx.projectId, limit);
  if (pending.length === 0) {
    return zeroResult(true, 'no-rows');
  }

  const executor = ctx.executor ?? runDescriber;
  const now = ctx.now ?? (() => Math.floor(Date.now() / 1000));
  const exeCtx: CanopyDescribeExecutorContext = {
    config: ctx.config,
    projectRoot: ctx.projectRoot,
  };

  const result: CanopyDescribeRunResult = {
    scanned: pending.length,
    written: 0,
    rejected: 0,
    errored: 0,
    skipped: false,
  };

  const maxAttempts = Math.max(1, llmConfig.max_attempts);
  const maxChars = llmConfig.max_description_chars;

  for (const entry of pending) {
    const exportsList = parseJsonArray(entry.exports_json);
    let cleaned: string | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const out = await executor({ entry }, exeCtx);
        cleaned = postProcess(out.raw, maxChars, exportsList);
      } catch (err) {
        // No-provider is a whole-batch problem, not a per-row one — bail
        // out so the caller can log once and retry the entire run later.
        if (isNoProviderError(err)) {
          return zeroResult(true, 'no-provider');
        }
        lastError = err;
      }
      if (cleaned) break;
    }

    if (cleaned) {
      writeDescription(ctx.db, ctx.projectId, entry.path, cleaned, now());
      result.written += 1;
    } else if (lastError !== null) {
      result.errored += 1;
    } else {
      result.rejected += 1;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroResult(
  skipped: boolean,
  reason: CanopyDescribeRunResult['skipReason'],
): CanopyDescribeRunResult {
  return { scanned: 0, written: 0, rejected: 0, errored: 0, skipped, skipReason: reason };
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// runDescriber throws an Error with a stable substring when the provider
// can't be resolved. We pattern-match on the message so a config rename
// doesn't go unnoticed; see executor.ts for the source string.
function isNoProviderError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('canopy-describe: no provider configured');
}
