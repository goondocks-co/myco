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
  rowProjectIdFromRequestContext,
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
  /** Resolve the grove EmbeddingManager for the run's context — never the
   *  bootstrap manager (anchor-leak Variant A). Resolved after the request
   *  context is determined below. */
  resolveEmbeddingManager: (requestContext: MycoRequestContext | undefined) => EmbeddingManager;
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
  const { vaultDir, resolveEmbeddingManager, liveConfig, logger } = deps;

  // Resolve the request context BEFORE the config gates so the gates read the
  // REQUEST grove's merged config — not the daemon's bootstrap-home liveConfig.
  // `summary_batch_interval` / `event_tasks_enabled` are grove-tier (PR #394),
  // so gating on liveConfig would gate a tenant op on the wrong grove.
  //
  // The caller (Stop pipeline, /events boundary, manual Complete-Session)
  // threads its own grove-bound request context. We deliberately do NOT fall
  // back to deriving a context from `vaultDir` here: the daemon's vaultDir is
  // the bootstrap anchor, whose phantom `project.toml` yields a GROVELESS
  // context (rowProjectIdFromRequestContext === null). Dispatching under it
  // recorded the title-summary agent run with project_id NULL (RC-4) — a
  // project-owned run mis-attributed to no project. We refuse such runs below.
  const requestContext = deps.requestContext;

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

  // Refuse to record a project-owned run we cannot attribute to a real
  // project. A title-summary run is inherently project-scoped; recording it
  // under project_id NULL (the groveless/anchor shape) corrupts per-project
  // run history and cost accounting. Resolve a real project or skip loudly —
  // never write NULL. (rowProjectIdFromRequestContext is null/undefined for an
  // absent or groveless context, the real project id for a grove-bound one.)
  if (rowProjectIdFromRequestContext(requestContext) == null) {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'Skipping title-summary: unresolved project tenancy for session', {
      session_id: sessionId,
    });
    return;
  }

  try {
    // Grove-scoped manager resolved from the run's context (not the anchor).
    const embeddingManager = resolveEmbeddingManager(requestContext);
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
