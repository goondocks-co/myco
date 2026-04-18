import type { MycoConfig } from '@myco/config/schema.js';
import { estimateTokens, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { getCortexInstructions } from '@myco/db/queries/cortex-instructions.js';
import { shouldInjectCortex } from './cortex-brief.js';
import { getSessionStartDigestPayload, shouldInjectSessionStartDigest } from './session-start-digest.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InjectionContext {
  branch?: string;
}

interface InjectedContext {
  text: string;
  tokenEstimate: number;
  brief: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the degraded-path session-start context.
 *
 * The normal session-start path goes through the daemon. If the daemon is
 * unavailable, read the last stored Cortex instructions locally so degraded
 * mode matches daemon semantics instead of regenerating ad hoc text.
 */
export async function buildInjectedContext(
  config: MycoConfig,
  _context: InjectionContext,
): Promise<InjectedContext> {
  const includeBrief = shouldInjectCortex(config.context);
  const includeDigest = shouldInjectSessionStartDigest(config.context);
  if (!includeBrief && !includeDigest) {
    return emptyContext();
  }

  const brief = includeBrief ? getCortexInstructions(DEFAULT_AGENT_ID)?.content ?? '' : '';
  const digest = includeDigest ? getSessionStartDigestPayload(config.context) : { content: '', tier: null };
  const parts: string[] = [];

  if (brief) {
    parts.push(brief);
  }
  if (digest.content) {
    parts.push(`## Preferred Digest (Tier ${digest.tier ?? config.context.digest_tier})\n${digest.content}`);
  }
  const text = parts.join('\n\n');

  return {
    text,
    tokenEstimate: estimateTokens(text),
    brief,
  };
}

/**
 * Build per-prompt context using semantic search on spores.
 *
 * Semantic search via the daemon's in-process vector store is deferred to
 * Phase 2. For now, returns empty context. The hook (`user-prompt-submit`)
 * routes through the daemon API at `/context/prompt`, which will implement
 * vector search when ready.
 */
export async function buildPromptContext(
  _prompt: string,
  _config: MycoConfig,
): Promise<InjectedContext> {
  return emptyContext();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyContext(): InjectedContext {
  return {
    text: '',
    tokenEstimate: 0,
    brief: '',
  };
}
