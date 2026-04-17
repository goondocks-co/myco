import type { MycoConfig } from '@myco/config/schema.js';
import { estimateTokens, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { getCortexInstructions } from '@myco/db/queries/cortex-instructions.js';
import { shouldInjectOperatingBrief } from './operating-brief.js';

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
  if (!shouldInjectOperatingBrief(config.context, 'session_start')) {
    return emptyContext();
  }

  const brief = getCortexInstructions(DEFAULT_AGENT_ID)?.content ?? '';

  return {
    text: brief,
    tokenEstimate: estimateTokens(brief),
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
