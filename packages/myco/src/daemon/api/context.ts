/**
 * Context injection API handlers — Cortex session-start instructions, semantic
 * spore search per prompt, and resume summaries for resumed sessions.
 */

import { z } from 'zod';
import { hydrateSearchResults } from '@myco/db/queries/search.js';
import { getSession } from '@myco/db/queries/sessions.js';
import {
  EXCLUDED_SPORE_STATUSES,
  PROMPT_CONTEXT_MIN_LENGTH,
  PROMPT_CONTEXT_MIN_SIMILARITY,
  PROMPT_CONTEXT_MAX_TOKENS,
  PROMPT_VECTOR_OVER_FETCH,
  estimateTokens,
} from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { MycoConfig } from '@myco/config/schema.js';
import {
  shouldInjectOperatingBrief,
} from '@myco/context/operating-brief.js';
import { getCortexInstructionsSnapshot } from '@myco/services/cortex.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { DaemonLogger } from '../logger.js';
import type { TeamSyncClient } from '../team-sync.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected by the daemon when registering context routes. */
export interface ContextDeps {
  vaultDir: string;
  embeddingManager: EmbeddingManager;
  logger: DaemonLogger;
  getTeamClient?: () => TeamSyncClient | null;
  // Holder so each request reads the current merged config — a user can
  // update context knobs and the very next request sees the change without
  // a daemon restart.
  liveConfig: { current: MycoConfig };
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const SessionContextBody = z.object({
  session_id: z.string().optional(),
  branch: z.string().optional(),
});

const ResumeContextBody = z.object({
  session_id: z.string(),
  parent_session_id: z.string().optional(),
  branch: z.string().optional(),
});

const PromptContextBody = z.object({
  prompt: z.string(),
  session_id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Session-start context handler
// ---------------------------------------------------------------------------

/**
 * Create a handler that injects stored Cortex instructions at session start.
 */
export function createSessionContextHandler(deps: ContextDeps) {
  return async function handleSessionContext(req: RouteRequest): Promise<RouteResponse> {
    const { session_id, branch } = SessionContextBody.parse(req.body);
    const { logger, liveConfig } = deps;
    const config = liveConfig.current;

    logger.debug(LOG_KINDS.CONTEXT_QUERY, 'Session context query', { session_id });

    try {
      if (!shouldInjectOperatingBrief(config.context, 'session_start')) {
        logger.debug(LOG_KINDS.CONTEXT_SESSION, 'Session-start operating brief disabled', { session_id });
        return { body: { text: '' } };
      }

      const snapshot = await getCortexInstructionsSnapshot(deps.vaultDir, {
        config,
        getTeamClient: deps.getTeamClient,
      });
      if (!snapshot.content) {
        logger.debug(LOG_KINDS.CONTEXT_SESSION, 'No stored Cortex instructions available for session start', {
          session_id,
        });
        return { body: { text: '' } };
      }

      const parts = [snapshot.content];
      if (branch) {
        parts.push(`Branch:: \`${branch}\``);
      }
      parts.push(`Session:: \`${session_id}\``);

      const source = 'cortex';
      const contextText = parts.join('\n\n');
      const estimatedTokens = estimateTokens(contextText);
      logger.info(
        LOG_KINDS.CONTEXT_SESSION,
        `Session context: ${estimatedTokens} est. tokens, source=${source}`,
        {
          session_id,
          source,
          branch,
          source_run_id: snapshot.sourceRunId,
          text_length: contextText.length,
          estimated_tokens: estimatedTokens,
          injected_text: contextText,
        },
      );

      return {
        body: {
          text: contextText,
          source,
        },
      };
    } catch (error) {
      logger.error(LOG_KINDS.CONTEXT_SESSION, 'Session context failed', { error: (error as Error).message });
      return { body: { text: '' } };
    }
  };
}

// ---------------------------------------------------------------------------
// Resume context handler
// ---------------------------------------------------------------------------

/**
 * Create a handler that injects a small resume-specific recap for opencode.
 *
 * Resume sessions already inherit their chat history, so this endpoint avoids
 * repeating the full digest. It returns only a terse recap from the parent
 * session when there is meaningful prior context to surface.
 */
export function createResumeContextHandler(deps: ContextDeps) {
  return async function handleResumeContext(req: RouteRequest): Promise<RouteResponse> {
    const { session_id, parent_session_id, branch } = ResumeContextBody.parse(req.body);
    const { logger } = deps;

    logger.debug(LOG_KINDS.CONTEXT_QUERY, 'Resume context query', {
      session_id,
      parent_session_id,
    });

    try {
      const parentSession = parent_session_id ? getSession(parent_session_id) : null;
      const resolvedBranch = branch ?? parentSession?.branch ?? null;
      const parts: string[] = [];

      if (parentSession?.title) {
        parts.push(`Resuming work from: ${parentSession.title}`);
      }

      if (parentSession?.summary) {
        parts.push(parentSession.summary);
      }

      if (resolvedBranch) {
        parts.push(`Branch:: \`${resolvedBranch}\``);
      }

      if (parentSession && parent_session_id) {
        parts.push(`Previous Session:: \`${parent_session_id}\``);
      }

      if (parts.length === 0) {
        logger.debug(LOG_KINDS.CONTEXT_SESSION, 'No resume context available', { session_id, parent_session_id });
        return { body: { text: '' } };
      }

      parts.push(`Session:: \`${session_id}\``);
      const contextText = parts.join('\n\n');
      const estimatedTokens = estimateTokens(contextText);

      logger.info(
        LOG_KINDS.CONTEXT_SESSION,
        `Resume context: ${estimatedTokens} est. tokens`,
        {
          session_id,
          parent_session_id,
          branch: resolvedBranch ?? undefined,
          text_length: contextText.length,
          estimated_tokens: estimatedTokens,
          injected_text: contextText,
        },
      );

      return {
        body: {
          text: contextText,
          source: 'resume',
        },
      };
    } catch (error) {
      logger.error(LOG_KINDS.CONTEXT_SESSION, 'Resume context failed', {
        session_id,
        parent_session_id,
        error: (error as Error).message,
      });
      return { body: { text: '' } };
    }
  };
}

// ---------------------------------------------------------------------------
// Per-prompt context handler
// ---------------------------------------------------------------------------

/**
 * Create a handler that searches spore embeddings for prompt-relevant observations.
 */
export function createPromptContextHandler(deps: ContextDeps) {
  return async function handlePromptContext(req: RouteRequest): Promise<RouteResponse> {
    const { prompt, session_id } = PromptContextBody.parse(req.body);
    const { logger, liveConfig, embeddingManager } = deps;
    const config = liveConfig.current;
    if (!config.context.prompt_search) {
      logger.debug(LOG_KINDS.CONTEXT_PROMPT, 'Prompt search disabled by config', { session_id });
      return { body: { text: '' } };
    }

    if (prompt.length < PROMPT_CONTEXT_MIN_LENGTH) {
      logger.debug(LOG_KINDS.CONTEXT_PROMPT, 'Prompt too short for search', {
        session_id,
        length: prompt.length,
        min: PROMPT_CONTEXT_MIN_LENGTH,
      });
      return { body: { text: '' } };
    }

    const maxSpores = config.context.prompt_max_spores;
    if (maxSpores === 0) {
      logger.debug(LOG_KINDS.CONTEXT_PROMPT, 'Prompt spore injection disabled (max_spores=0)', { session_id });
      return { body: { text: '' } };
    }

    const queryVector = await embeddingManager.embedQuery(prompt);
    if (!queryVector) {
      logger.debug(LOG_KINDS.CONTEXT_EMBED, 'Embedding provider unavailable for prompt search', { session_id });
      return { body: { text: '' } };
    }

    // Search spores namespace — over-fetch to compensate for post-filtering
    const vectorResults = embeddingManager.searchVectors(queryVector, {
      namespace: 'spores',
      limit: maxSpores * PROMPT_VECTOR_OVER_FETCH,
      threshold: PROMPT_CONTEXT_MIN_SIMILARITY,
    });

    logger.debug(LOG_KINDS.CONTEXT_SEARCH, 'Prompt vector search completed', {
      session_id,
      raw_results: vectorResults.length,
      top_similarity: vectorResults[0]?.similarity,
    });

    if (vectorResults.length === 0) return { body: { text: '' } };

    const eligible = vectorResults.filter(
      (r) => !EXCLUDED_SPORE_STATUSES.has(r.metadata.status as string),
    );

    if (eligible.length === 0) {
      logger.debug(LOG_KINDS.CONTEXT_FILTER, 'All spore results excluded by status filter', { session_id });
      return { body: { text: '' } };
    }

    const topResults = eligible.slice(0, maxSpores);
    const hydrated = hydrateSearchResults(topResults);
    const spores = hydrated.filter((r) => r.type === 'spore');

    if (spores.length === 0) return { body: { text: '' } };

    const text = formatSporeContext(spores);

    const promptTokens = estimateTokens(text);
    const titles = spores.map((s) => s.title);
    logger.info(
      LOG_KINDS.CONTEXT_PROMPT,
      `Prompt context: ${spores.length} spores [${titles.join(', ')}] (~${promptTokens} tokens)`,
      {
        session_id,
        spore_count: spores.length,
        spore_titles: titles,
        scores: spores.map((s) => s.score.toFixed(3)),
        estimated_tokens: promptTokens,
        injected_text: text,
      },
    );

    return { body: { text } };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format hydrated spore search results as markdown context for injection.
 * Respects PROMPT_CONTEXT_MAX_TOKENS budget.
 */
function formatSporeContext(
  spores: Array<{ title: string; preview: string; score: number }>,
): string {
  const header = 'Relevant vault observations:';
  let text = header;
  let tokens = estimateTokens(text);

  for (const spore of spores) {
    const line = `\n- (${spore.title}) ${spore.preview}`;
    const lineTokens = estimateTokens(line);

    if (tokens + lineTokens > PROMPT_CONTEXT_MAX_TOKENS) break;

    text += line;
    tokens += lineTokens;
  }

  // Don't return just the header with no items
  return text === header ? '' : text;
}
