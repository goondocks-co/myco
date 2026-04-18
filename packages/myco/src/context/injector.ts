import type { MycoConfig } from '@myco/config/schema.js';
import { estimateTokens, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { getCortexInstructions } from '@myco/db/queries/cortex-instructions.js';
import { shouldInjectCortex } from './cortex-brief.js';
import { shouldInjectSessionStartDigest } from './session-start-digest.js';
import { composeSessionStartContext } from './session-start-context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InjectionContext {
  branch?: string;
}

interface InjectedContext {
  text: string;
  tokenEstimate: number;
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
  const { parts } = composeSessionStartContext(config, brief);
  const text = parts.map((p) => p.text).join('\n\n');

  return {
    text,
    tokenEstimate: estimateTokens(text),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyContext(): InjectedContext {
  return {
    text: '',
    tokenEstimate: 0,
  };
}
