/**
 * Context injection API handlers — Cortex session-start instructions, semantic
 * spore search per prompt, and resume summaries for resumed sessions.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hydrateSearchResults } from '@myco/db/queries/search.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { ensureSessionRowExists, ENSURE_SESSION_SOURCE } from '../session-lifecycle.js';
import {
  EXCLUDED_SPORE_STATUSES,
  PROMPT_CONTEXT_MIN_LENGTH,
  PROMPT_CONTEXT_MAX_TOKENS,
  PROMPT_VECTOR_POOL_SIZE,
  estimateTokens,
} from '@myco/constants.js';
import { selectRelevantSpores } from '@myco/daemon/embedding/relevance.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { MycoConfig } from '@myco/config/schema.js';
import {
  shouldInjectCortex,
} from '@myco/context/cortex-brief.js';
import { composeCortexInstructionInjection } from '@myco/context/cortex-injection-context.js';
import { shouldInjectSessionStartDigest } from '@myco/context/session-start-digest.js';
import { composeSessionStartContext } from '@myco/context/session-start-context.js';
import { projectScopeFromRequestContext, rowProjectIdFromRequestContext } from '@myco/grove/request-context.js';
import { symbiontHasCapability } from '@myco/symbionts/capabilities.js';
import { getCortexInstructionsSnapshot } from '../cortex.js';
import { resolveTenantConfig } from '../request-config.js';
import { recordInjectionAndShouldSuppress, getSessionInjectedSporeIds } from '../injection-records.js';
import { resolvePlanIntentNudge } from './plan-intent.js';
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
  /**
   * Resolve the embedding manager for THIS request's grove. Per-request
   * resolution is mandatory: a fixed/bootstrap manager would search the daemon
   * anchor's vector store for every tenant (anchor-leak Variant A — the prompt
   * search must hit the caller's grove, like `/api/search` does). When tenancy
   * is absent/synthesized this resolves to the phantom anchor, which holds no
   * real data, so the search safe-fails to empty rather than leaking.
   */
  resolveEmbeddingManager: (requestContext: RouteRequest['requestContext']) => EmbeddingManager;
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

const SubagentContextBody = z.object({
  session_id: z.string().optional(),
  agent: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
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
    const config = resolveTenantConfig(req.requestContext, liveConfig.current, { logger });

    logger.debug(LOG_KINDS.CONTEXT_QUERY, 'Session context query', { session_id });

    try {
      const cortexEnabled = shouldInjectCortex(config.cortex);
      const digestEnabled = shouldInjectSessionStartDigest(config.cortex.digest);
      if (!cortexEnabled && !digestEnabled) {
        logger.debug(LOG_KINDS.CONTEXT_SESSION, 'Session-start context disabled', { session_id });
        return { body: { text: '' } };
      }

      const requestProjectId = req.requestContext?.projectId ?? null;
      const requestScope: import('@myco/grove/ids.js').ProjectScope = requestProjectId
        ? { kind: 'project', id: requestProjectId }
        : { kind: 'global' };
      let sourceRunId: string | null = null;
      let cortexContent = '';
      if (cortexEnabled) {
        const snapshot = getCortexInstructionsSnapshot(config, requestScope);
        if (snapshot.content) {
          cortexContent = snapshot.content;
          sourceRunId = snapshot.sourceRunId;
        } else {
          logger.debug(LOG_KINDS.CONTEXT_SESSION, 'No stored Cortex instructions available for session start', {
            session_id,
          });
        }
      }

      const composed = composeSessionStartContext(config, cortexContent, requestScope);
      const textParts: string[] = composed.parts.map((p) => p.text);
      const sourceParts: string[] = composed.parts.map((p) =>
        p.kind === 'cortex' ? 'cortex' : `digest:${p.tier ?? config.cortex.digest.tier}`,
      );

      if (digestEnabled && !composed.parts.some((p) => p.kind === 'digest')) {
        logger.debug(LOG_KINDS.CONTEXT_SESSION, 'No preferred digest extract available for session start', {
          session_id,
          preferred_tier: config.cortex.digest.tier,
        });
      }

      if (textParts.length === 0) {
        return { body: { text: '' } };
      }

      if (branch) {
        textParts.push(`Branch:: \`${branch}\``);
      }
      textParts.push(`Session:: \`${session_id}\``);

      const source = sourceParts.join('+');
      const contextText = textParts.join('\n\n');
      const estimatedTokens = estimateTokens(contextText);
      logger.info(
        LOG_KINDS.CONTEXT_SESSION,
        `Session context: ${estimatedTokens} est. tokens, source=${source}`,
        {
          session_id,
          source,
          branch,
          source_run_id: sourceRunId,
          text_length: contextText.length,
          estimated_tokens: estimatedTokens,
        },
      );

      // Per-(session) dedup gate. UNIQUE on
      // `myco:inject:cortex:<sessionId>` blocks re-entry within the same
      // session.
      //
      // Some symbionts (OpenCode) race `/sessions/register` and
      // `/context` in parallel; `/context` can land first. The
      // injection sentinel-batch creation downstream has an FK to
      // `sessions`, so an absent row makes `recordInjectionActivity`
      // bail with `no_batch` and the cortex activity never gets
      // recorded even though the text was served. Defensively ensure
      // the session row exists FIRST — `ensureSessionRowExists`
      // upserts only when truly missing and logs a warning so the
      // gap is observable.
      if (session_id) {
        try {
          ensureSessionRowExists({
            sessionId: session_id,
            projectId: requestProjectId,
            projectRoot: req.requestContext?.projectRoot ?? null,
            machineId: req.requestContext?.machineId ?? 'local',
            logger,
            source: ENSURE_SESSION_SOURCE.CONTEXT,
          });
        } catch { /* defensive — never block the cortex serve */ }
        const { suppress } = await recordInjectionAndShouldSuppress({
          sessionId: session_id,
          projectId: requestProjectId,
          injectionType: 'cortex',
          trigger: { metadata: { source, branch } },
          fetchContent: async () => ({ text: contextText, metadata: { source } }),
        });
        if (suppress) return { body: { text: '' } };
      }

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
// Subagent-start context handler
// ---------------------------------------------------------------------------

/**
 * Create a handler that injects managed Cortex instructions into supported child agents.
 */
export function createSubagentContextHandler(deps: ContextDeps) {
  return async function handleSubagentContext(req: RouteRequest): Promise<RouteResponse> {
    const { session_id, agent, agent_id, agent_type } = SubagentContextBody.parse(req.body);
    const { logger, liveConfig } = deps;
    const config = resolveTenantConfig(req.requestContext, liveConfig.current, { logger });

    logger.debug(LOG_KINDS.CONTEXT_QUERY, 'Subagent context query', {
      session_id,
      agent,
      agent_id,
      agent_type,
    });

    try {
      if (!session_id) return { body: { text: '' } };
      if (!config.cortex.enabled || !config.cortex.instructions.inject_on_subagent_start) {
        logger.debug(LOG_KINDS.CONTEXT_SESSION, 'Subagent context disabled', { session_id, agent });
        return { body: { text: '' } };
      }
      if (!symbiontHasCapability(agent, 'subagentStartInjection')) {
        logger.debug(LOG_KINDS.CONTEXT_SESSION, 'Symbiont lacks subagent-start injection', {
          session_id,
          agent,
        });
        return { body: { text: '' } };
      }

      const requestProjectId = req.requestContext?.projectId ?? null;
      const requestScope: import('@myco/grove/ids.js').ProjectScope = requestProjectId
        ? { kind: 'project', id: requestProjectId }
        : { kind: 'global' };
      const snapshot = getCortexInstructionsSnapshot(config, requestScope);
      const composed = composeCortexInstructionInjection(snapshot.content, 'subagent-start');
      if (!composed) {
        logger.debug(LOG_KINDS.CONTEXT_SESSION, 'No stored Cortex instructions available for subagent start', {
          session_id,
          agent,
        });
        return { body: { text: '' } };
      }
      const text = composed.text;
      const projectId = rowProjectIdFromRequestContext(req.requestContext);

      try {
        ensureSessionRowExists({
          sessionId: session_id,
          projectId: typeof projectId === 'string' ? projectId : null,
          projectRoot: req.requestContext?.projectRoot ?? null,
          machineId: req.requestContext?.machineId ?? 'local',
          logger,
          source: ENSURE_SESSION_SOURCE.CONTEXT,
        });
      } catch { /* defensive — never block child-agent startup */ }

      const discriminator = subagentDiscriminator(agent_id, agent_type);
      const { suppress } = await recordInjectionAndShouldSuppress({
        sessionId: session_id,
        projectId: typeof projectId === 'string' ? projectId : null,
        injectionType: 'subagent',
        discriminator,
        trigger: {
          metadata: {
            source: 'subagent-start',
            agent,
            agent_id,
            agent_type,
          },
        },
        fetchContent: async () => ({
          text,
          metadata: {
            source: 'cortex-subagent',
            source_run_id: snapshot.sourceRunId,
            generated_at: snapshot.generatedAt,
          },
        }),
      });
      if (suppress) return { body: { text: '' } };

      logger.info(LOG_KINDS.CONTEXT_SESSION, 'Subagent context injected', {
        session_id,
        agent,
        agent_id,
        agent_type,
        source_run_id: snapshot.sourceRunId,
        text_length: text.length,
        estimated_tokens: estimateTokens(text),
      });

      return {
        body: {
          text,
          source: 'cortex-subagent',
          sourceRunId: snapshot.sourceRunId,
          generatedAt: snapshot.generatedAt,
        },
      };
    } catch (error) {
      logger.error(LOG_KINDS.CONTEXT_SESSION, 'Subagent context failed', {
        session_id,
        agent,
        error: (error as Error).message,
      });
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
    const projectId = rowProjectIdFromRequestContext(req.requestContext);
    const scope = projectScopeFromRequestContext(req.requestContext);

    logger.debug(LOG_KINDS.CONTEXT_QUERY, 'Resume context query', {
      session_id,
      parent_session_id,
    });

    try {
      const parentSession = parent_session_id ? getSession(parent_session_id, scope) : null;
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
    const { logger, liveConfig } = deps;
    // Resolve the embedding manager for the caller's grove (per-request).
    const embeddingManager = deps.resolveEmbeddingManager(req.requestContext);
    const config = resolveTenantConfig(req.requestContext, liveConfig.current, { logger });
    const projectId = rowProjectIdFromRequestContext(req.requestContext);
    const scope = projectScopeFromRequestContext(req.requestContext);

    // Plan-intent nudge — an independent injection contributor (plan-intent.ts)
    // owns the toggle, intent heuristic, per-session dedup, and best-effort
    // error handling. Resolved regardless of the spore gates below so it still
    // fires when spore injection is disabled. `respond()` folds it into every
    // return.
    const nudgeText = await resolvePlanIntentNudge({
      enabled: config.cortex.plans.inject_intent_nudge_on_prompt_submit,
      prompt,
      sessionId: session_id,
      projectId: typeof projectId === 'string' ? projectId : null,
    });
    const respond = (sporeText: string): RouteResponse => ({
      body: { text: [sporeText, nudgeText].filter(Boolean).join('\n\n') },
    });

    if (!config.cortex.spores.inject_on_prompt_submit) {
      logger.debug(LOG_KINDS.CONTEXT_PROMPT, 'Prompt search disabled by config', { session_id });
      return respond('');
    }

    if (prompt.length < PROMPT_CONTEXT_MIN_LENGTH) {
      logger.debug(LOG_KINDS.CONTEXT_PROMPT, 'Prompt too short for search', {
        session_id,
        length: prompt.length,
        min: PROMPT_CONTEXT_MIN_LENGTH,
      });
      return respond('');
    }

    const maxSpores = config.cortex.spores.max_per_prompt;
    if (maxSpores === 0) {
      logger.debug(LOG_KINDS.CONTEXT_PROMPT, 'Prompt spore injection disabled (max_spores=0)', { session_id });
      return respond('');
    }

    const queryVector = await embeddingManager.embedQuery(prompt);
    if (!queryVector) {
      logger.debug(LOG_KINDS.CONTEXT_EMBED, 'Embedding provider unavailable for prompt search', { session_id });
      return respond('');
    }

    // Over-fetch a candidate pool (no absolute threshold) so the selector can
    // estimate the query's distance distribution. Relevance is decided by
    // hubness-aware Mutual Proximity, not a magic cosine cutoff.
    const vectorResults = embeddingManager.searchVectors(queryVector, {
      namespace: 'spores',
      limit: PROMPT_VECTOR_POOL_SIZE,
      filters: {
        status: 'active',
        ...(typeof projectId === 'string' ? { project_id: projectId } : {}),
      },
    });

    logger.debug(LOG_KINDS.CONTEXT_SEARCH, 'Prompt vector search completed', {
      session_id,
      raw_results: vectorResults.length,
      top_similarity: vectorResults[0]?.similarity,
    });

    if (vectorResults.length === 0) return respond('');

    const eligible = vectorResults.filter(
      (r) => !EXCLUDED_SPORE_STATUSES.has(r.metadata.status as string),
    );

    if (eligible.length === 0) {
      logger.debug(LOG_KINDS.CONTEXT_FILTER, 'All spore results excluded by status filter', { session_id });
      return respond('');
    }

    // Spores already injected earlier in this session — excluded so the same
    // observation is not re-served prompt after prompt.
    const alreadyInjected = session_id ? getSessionInjectedSporeIds(session_id) : new Set<string>();

    // Hubness-aware relevance gate. Returns [] when no spore is genuinely
    // relevant — we inject nothing rather than poison the context with a hub.
    const selected = selectRelevantSpores(
      eligible.map((r) => ({
        id: r.id,
        similarity: r.similarity,
        neighborMean:
          typeof r.metadata.neighbor_mean === 'number' ? r.metadata.neighbor_mean : undefined,
        neighborStd:
          typeof r.metadata.neighbor_std === 'number' ? r.metadata.neighbor_std : undefined,
        alreadyInjected: alreadyInjected.has(r.id),
      })),
      { maxResults: maxSpores },
    );

    if (selected.length === 0) {
      logger.debug(LOG_KINDS.CONTEXT_FILTER, 'No spore cleared the relevance gate', {
        session_id,
        pool: eligible.length,
        top_similarity: eligible[0]?.similarity,
      });
      return respond('');
    }

    // Hydrate the selected spores, preserving selection order.
    const byId = new Map(eligible.map((r) => [r.id, r]));
    const selectedResults = selected
      .map((s) => byId.get(s.id))
      .filter((r): r is NonNullable<typeof r> => r != null);
    const hydrated = hydrateSearchResults(selectedResults, { scope });
    const spores = hydrated.filter((r) => r.type === 'spore');

    if (spores.length === 0) return respond('');

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
      },
    );

    // Per-(session, prompt) dedup gate. UNIQUE on
    // `myco:inject:spores:<sessionId>:<promptHash>` blocks a second
    // injection for the same prompt content. `no_batch` falls through.
    if (text && session_id) {
      const { suppress } = await recordInjectionAndShouldSuppress({
        sessionId: session_id,
        projectId: typeof projectId === 'string' ? projectId : null,
        injectionType: 'spores',
        discriminator: hashPromptDiscriminator(prompt),
        trigger: {
          metadata: {
            spore_titles: spores.map((s) => s.title),
            spore_ids: spores.map((s) => s.id),
            spore_count: spores.length,
          },
        },
        fetchContent: async () => ({ text, metadata: { spore_count: spores.length } }),
      });
      if (suppress) return respond('');
    }

    return respond(text);
  };
}

/**
 * Hash a prompt to a short, deterministic discriminator suitable for
 * embedding in a `content_hash`. SHA-1 truncated to 16 hex chars — collisions
 * here would only mean a single user submitting two prompts whose first 64
 * bits of SHA-1 collide, which is not a real risk.
 */
function hashPromptDiscriminator(prompt: string): string {
  return createHash('sha1').update(prompt).digest('hex').slice(0, 16);
}

function subagentDiscriminator(agentId: string | undefined, agentType: string | undefined): string {
  return agentId?.trim() || agentType?.trim() || 'unknown';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format hydrated spore search results as markdown context for injection.
 * Respects PROMPT_CONTEXT_MAX_TOKENS budget.
 */
function releaseLabel(release: { state?: string; confidence?: string } | undefined): string {
  if (!release?.state) return '';
  return release.confidence ? ` [${release.state}/${release.confidence}]` : ` [${release.state}]`;
}

function formatSporeContext(
  spores: Array<{ title: string; preview: string; score: number; release_state?: { state?: string; confidence?: string } }>,
): string {
  const header = 'Relevant vault observations:';
  let text = header;
  let tokens = estimateTokens(text);

  for (const spore of spores) {
    const line = `\n- (${spore.title})${releaseLabel(spore.release_state)} ${spore.preview}`;
    const lineTokens = estimateTokens(line);

    if (tokens + lineTokens > PROMPT_CONTEXT_MAX_TOKENS) break;

    text += line;
    tokens += lineTokens;
  }

  // Don't return just the header with no items
  return text === header ? '' : text;
}
