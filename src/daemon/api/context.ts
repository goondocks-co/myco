/**
 * Context injection API handlers — digest at session start, semantic spore search per prompt.
 *
 * - POST /context: Injects digest extract + branch/session metadata at session start
 * - POST /context/prompt: Searches spore embeddings for relevant observations per prompt
 */

import { z } from 'zod';
import { getDigestExtract } from '@myco/db/queries/digest-extracts.js';
import { hydrateSearchResults } from '@myco/db/queries/search.js';
import {
  DEFAULT_AGENT_ID,
  EXCLUDED_SPORE_STATUSES,
  PROMPT_CONTEXT_MIN_LENGTH,
  PROMPT_CONTEXT_MIN_SIMILARITY,
  PROMPT_CONTEXT_MAX_TOKENS,
  PROMPT_VECTOR_OVER_FETCH,
  estimateTokens,
} from '@myco/constants.js';
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
  config: MycoConfig;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const SessionContextBody = z.object({
  session_id: z.string().optional(),
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
    const { logger, config } = deps;

    logger.debug('context', 'Session context query', { session_id });

    try {
      const parts: string[] = [];

      // Digest extract — the primary session context payload
      const tier = config.context.digest_tier;
      const extract = getDigestExtract(DEFAULT_AGENT_ID, tier);

      if (extract) {
        parts.push(extract.content);
        logger.info('context', 'Digest extract found', {
          session_id,
          tier,
          content_length: extract.content.length,
          generated_at: extract.generated_at,
        });
      } else {
        logger.debug('context', 'No digest extract available', { session_id, tier });
      }

      // Branch info
      if (branch) {
        parts.push(`Branch:: \`${branch}\``);
      }

      // Session ID — always included
      parts.push(`Session:: \`${session_id}\``);

      const source = extract ? 'digest' : 'basic';
      const contextText = parts.join('\n\n');

      logger.info('context', 'Session context injected', {
        session_id,
        source,
        tier: extract ? tier : undefined,
        text_length: contextText.length,
      });
      logger.debug('context', 'Injected context content', {
        session_id,
        text: contextText,
      });

      return {
        body: {
          text: contextText,
          source,
          ...(extract ? { tier } : {}),
        },
      };
    } catch (error) {
      logger.error('context', 'Session context failed', { error: (error as Error).message });
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
    const { logger, config, embeddingManager } = deps;

    // Guard: prompt search disabled
    if (!config.context.prompt_search) {
      logger.debug('context', 'Prompt search disabled by config', { session_id });
      return { body: { text: '' } };
    }

    // Guard: prompt too short
    if (prompt.length < PROMPT_CONTEXT_MIN_LENGTH) {
      logger.debug('context', 'Prompt too short for search', {
        session_id,
        length: prompt.length,
        min: PROMPT_CONTEXT_MIN_LENGTH,
      });
      return { body: { text: '' } };
    }

    // Guard: max spores is 0 (disabled)
    const maxSpores = config.context.prompt_max_spores;
    if (maxSpores === 0) {
      logger.debug('context', 'Prompt spore injection disabled (max_spores=0)', { session_id });
      return { body: { text: '' } };
    }

    // Embed the prompt
    const queryVector = await embeddingManager.embedQuery(prompt);
    if (!queryVector) {
      logger.debug('context', 'Embedding provider unavailable for prompt search', { session_id });
      return { body: { text: '' } };
    }

    // Search spores namespace — over-fetch to compensate for post-filtering
    const vectorResults = embeddingManager.searchVectors(queryVector, {
      namespace: 'spores',
      limit: maxSpores * PROMPT_VECTOR_OVER_FETCH,
      threshold: PROMPT_CONTEXT_MIN_SIMILARITY,
    });

    logger.debug('context', 'Prompt vector search completed', {
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
      logger.debug('context', 'All spore results excluded by status filter', { session_id });
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

    logger.info('context', 'Prompt context injected', {
      session_id,
      spore_count: spores.length,
      scores: spores.map((s) => s.score.toFixed(3)),
    });
    logger.debug('context', 'Prompt context content', { session_id, text });

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
