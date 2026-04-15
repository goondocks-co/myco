/**
 * Context injection API handlers — digest at session start, semantic spore search per prompt.
 *
 * - POST /context: Injects digest extract + branch/session metadata at session start
 * - POST /context/prompt: Searches spore embeddings for relevant observations per prompt
 */

import { z } from 'zod';
import { getDigestExtract } from '@myco/db/queries/digest-extracts.js';
import { hydrateSearchResults } from '@myco/db/queries/search.js';
import { getSession } from '@myco/db/queries/sessions.js';
import {
  DEFAULT_AGENT_ID,
  EXCLUDED_SPORE_STATUSES,
  PROMPT_CONTEXT_MIN_LENGTH,
  PROMPT_CONTEXT_MIN_SIMILARITY,
  PROMPT_CONTEXT_MAX_TOKENS,
  PROMPT_VECTOR_OVER_FETCH,
  estimateTokens,
} from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import type { DaemonLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected by the daemon when registering context routes. */
export interface ContextDeps {
  embeddingManager: EmbeddingManager;
  logger: DaemonLogger;
  // Holder so each request reads the current merged config — a user can
  // flip `context.prompt_search` or bump `context.digest_tier` and the
  // very next request sees the change without a daemon restart.
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
 * Create a handler that injects digest extract + metadata at session start.
 *
 * Reads the configured digest tier from digest_extracts. If an extract exists,
 * it becomes the primary context payload. Branch and session ID are always included.
 */
export function createSessionContextHandler(deps: ContextDeps) {
  return async function handleSessionContext(req: RouteRequest): Promise<RouteResponse> {
    const { session_id, branch } = SessionContextBody.parse(req.body);
    const { logger, liveConfig } = deps;
    const config = liveConfig.current;

    logger.debug(LOG_KINDS.CONTEXT_QUERY, 'Session context query', { session_id });

    try {
      const parts: string[] = [];

      // Digest extract — the primary session context payload
      const tier = config.context.digest_tier;
      const extract = getDigestExtract(DEFAULT_AGENT_ID, tier);

      if (extract) {
        parts.push(extract.content);
        logger.info(LOG_KINDS.CONTEXT_DIGEST, 'Digest extract found', {
          session_id,
          tier,
          content_length: extract.content.length,
          generated_at: extract.generated_at,
        });
      } else {
        logger.debug(LOG_KINDS.CONTEXT_DIGEST, 'No digest extract available', { session_id, tier });
      }

      // Branch info
      if (branch) {
        parts.push(`Branch:: \`${branch}\``);
      }

      // Session ID — always included
      parts.push(`Session:: \`${session_id}\``);

      const source = extract ? 'digest' : 'basic';
      const contextText = parts.join('\n\n');

      const estimatedTokens = estimateTokens(contextText);
      logger.info(
        LOG_KINDS.CONTEXT_SESSION,
        `Session context: ${estimatedTokens} est. tokens, source=${source}${extract ? `, tier=${tier}` : ''}`,
        {
          session_id,
          source,
          tier: extract ? tier : undefined,
          text_length: contextText.length,
          estimated_tokens: estimatedTokens,
          generated_at: extract?.generated_at,
          injected_text: contextText,
        },
      );

      return {
        body: {
          text: contextText,
          source,
          ...(extract ? { tier } : {}),
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
 * Create a handler that searches spore embeddings for observations relevant to the prompt.
 *
 * Embeds the prompt, searches the 'spores' namespace via vector similarity,
 * post-filters by status, and returns formatted spore context.
 */
export function createPromptContextHandler(deps: ContextDeps) {
  return async function handlePromptContext(req: RouteRequest): Promise<RouteResponse> {
    const { prompt, session_id } = PromptContextBody.parse(req.body);
    const { logger, liveConfig, embeddingManager } = deps;
    const config = liveConfig.current;

    // Guard: prompt search disabled
    if (!config.context.prompt_search) {
      logger.debug(LOG_KINDS.CONTEXT_PROMPT, 'Prompt search disabled by config', { session_id });
      return { body: { text: '' } };
    }

    // Guard: prompt too short
    if (prompt.length < PROMPT_CONTEXT_MIN_LENGTH) {
      logger.debug(LOG_KINDS.CONTEXT_PROMPT, 'Prompt too short for search', {
        session_id,
        length: prompt.length,
        min: PROMPT_CONTEXT_MIN_LENGTH,
      });
      return { body: { text: '' } };
    }

    // Guard: max spores is 0 (disabled)
    const maxSpores = config.context.prompt_max_spores;
    if (maxSpores === 0) {
      logger.debug(LOG_KINDS.CONTEXT_PROMPT, 'Prompt spore injection disabled (max_spores=0)', { session_id });
      return { body: { text: '' } };
    }

    // Embed the prompt
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

    if (vectorResults.length === 0) {
      return { body: { text: '' } };
    }

    // Post-filter: exclude superseded/archived spores via domain_metadata
    const eligible = vectorResults.filter(
      (r) => !EXCLUDED_SPORE_STATUSES.has(r.metadata.status as string),
    );

    if (eligible.length === 0) {
      logger.debug(LOG_KINDS.CONTEXT_FILTER, 'All spore results excluded by status filter', { session_id });
      return { body: { text: '' } };
    }

    // Take top N and hydrate with full record data
    const topResults = eligible.slice(0, maxSpores);
    const hydrated = hydrateSearchResults(topResults);
    const spores = hydrated.filter((r) => r.type === 'spore');

    if (spores.length === 0) {
      return { body: { text: '' } };
    }

    // Format spore context with token budget enforcement
    const text = formatSporeContext(spores);

    const promptTokens = estimateTokens(text);
    const titles = spores.map((s) => s.title);
    // Single log line: summary in the message, full injected text in the data
    // blob so the log detail panel shows exactly what the model received.
    // No separate debug line — debug mode shouldn't hide information, and
    // splitting summary vs. detail across two rows just doubles clicks.
    logger.info(LOG_KINDS.CONTEXT_PROMPT, `Prompt context: ${spores.length} spores [${titles.join(', ')}] (~${promptTokens} tokens)`, {
      session_id,
      spore_count: spores.length,
      spore_titles: titles,
      scores: spores.map((s) => s.score.toFixed(3)),
      estimated_tokens: promptTokens,
      injected_text: text,
    });

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
