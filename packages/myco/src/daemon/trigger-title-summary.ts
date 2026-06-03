/**
 * Fire-and-forget trigger for the title-summary agent task.
 *
 * Shared between the Stop-hook pipeline (per-session activity) and the
 * manual "Complete Session" API (user-initiated regenerate). Both paths
 * need the same config gates and the same dynamic-import guard against a
 * missing agent module; sharing avoids drift when either concern changes.
 */

import type { EmbeddingManager } from './embedding/manager.js';
import type { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import {
  tryResolveRequestContextForVault,
  type MycoRequestContext,
} from '@myco/grove/request-context.js';
import { resolveTenantConfig } from './request-config.js';
import {
  countBatchesBySession,
  PROMPT_BATCH_ORIGIN,
  type PromptBatchOrigin,
} from '@myco/db/queries/batches.js';

export interface TriggerTitleSummaryDeps {
  vaultDir: string;
  embeddingManager: EmbeddingManager;
  // Holder rather than snapshot so the gates below observe toggle flips
  // (agent.event_tasks_enabled, agent.summary_batch_interval) from Settings
  // without a daemon restart.
  liveConfig: { current: MycoConfig };
  logger: DaemonLogger;
  /**
   * Caller-supplied request context. The title-summary task runs through
   * `runAgent`, which threads context into `projectScopeFromRequestContext`
   * for project-scoped reads/writes. When omitted, we fall back to deriving
   * a context from `vaultDir` so the task doesn't crash on the first call
   * — see the catch in the body for the legacy-vault case.
   */
  requestContext?: MycoRequestContext;
}

/**
 * Trigger `title-summary` for one session.
 *
 * Returns without scheduling a run when:
 * - `agent.summary_batch_interval <= 0` (summaries disabled entirely), or
 * - `agent.event_tasks_enabled === false` (event-driven tasks globally off), or
 * - the agent module can't be loaded, or
 * - `trigger.evaluateBoundary` is set and the human-origin batch count
 *   has not crossed a `summary_batch_interval` boundary (live `/events`
 *   path). The summary task consumes human-origin batches via
 *   `INTELLIGENCE_DEFAULT_ORIGINS`, so the cadence is measured against
 *   the same population — system/agent_dispatch batches don't move it.
 *
 * Stop-phase callers omit `trigger`; they want an unconditional fire
 * if the session still needs a title (the wrapper already decided that).
 *
 * Rejections from the executor surface via `logger.warn` — the task's own
 * per-task concurrency guard handles overlap with in-flight runs.
 */
export async function triggerTitleSummary(
  sessionId: string,
  deps: TriggerTitleSummaryDeps,
  trigger?: { evaluateBoundary: true; promptOrigin: PromptBatchOrigin },
): Promise<void> {
  const { vaultDir, embeddingManager, liveConfig, logger } = deps;

  // Resolve the request context BEFORE the config gates so the gates read the
  // REQUEST grove's merged config — not the daemon's bootstrap-home liveConfig.
  // `summary_batch_interval` / `event_tasks_enabled` are grove-tier (PR #394),
  // so gating on liveConfig would gate a tenant op on the wrong grove.
  //
  // runAgent calls projectScopeFromRequestContext, which throws when no
  // context is supplied. The Stop pipeline used to pass no context here
  // and every title-summary task failed with that exact error. Supply the
  // caller's context if we got one; otherwise resolve from vaultDir with
  // the sessionId as an override so the task gets project-scoped reads.
  let requestContext = deps.requestContext;
  if (!requestContext) {
    const resolved = tryResolveRequestContextForVault(vaultDir, { sessionId });
    if (resolved.kind === 'grove') {
      requestContext = resolved.context;
    }
    // Legacy non-Grove vaults fall through with requestContext undefined;
    // runAgent will surface the underlying error via its own try/catch.
  }

  // Legacy non-Grove vaults (requestContext undefined) fall back to liveConfig;
  // resolveTenantConfig returns the fallback when no tenant context resolves.
  const config = resolveTenantConfig(requestContext, liveConfig.current, { logger });

  if (config.agent.summary_batch_interval <= 0) return;
  if (config.agent.event_tasks_enabled === false) return;

  if (trigger?.evaluateBoundary) {
    if (trigger.promptOrigin !== PROMPT_BATCH_ORIGIN.HUMAN) return;
    const humanCount = countBatchesBySession(sessionId, { origins: [PROMPT_BATCH_ORIGIN.HUMAN] });
    if (humanCount <= 0 || humanCount % config.agent.summary_batch_interval !== 0) return;
  }

  try {
    const { dispatchAgentRun } = await import('../agent/runner-host.js');
    dispatchAgentRun(vaultDir, {
      task: 'title-summary',
      instruction: `Process session ${sessionId} only`,
      embeddingManager,
      logger,
      requestContext,
    }).catch((err) => {
      logger.warn(LOG_KINDS.AGENT_ERROR, 'Title-summary task failed', {
        session_id: sessionId,
        error: String(err),
      });
    });
  } catch {
    // agent module unavailable — silently no-op
  }
}
