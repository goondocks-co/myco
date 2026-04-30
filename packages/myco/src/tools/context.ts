/**
 * myco_context — retrieve synthesized project context from digest extracts.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default tier when none is requested. */
const DEFAULT_CONTEXT_TIER = 5000;

/** Message returned when no digest extracts are available yet. */
const NO_DIGEST_MESSAGE = 'Digest context is not yet available. The first digest cycle has not completed.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContextInput {
  tier?: number;
}

export interface ContextResult {
  content: string;
  tier: number;
  fallback: boolean;
  generated_at?: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoContext(
  input: ContextInput,
  client: DaemonClient,
): Promise<ContextResult> {
  const requestedTier = input.tier ?? DEFAULT_CONTEXT_TIER;

  const result = await client.get('/api/digest');
  if (!result.ok || !result.data?.tiers) {
    return {
      content: NO_DIGEST_MESSAGE,
      tier: requestedTier,
      fallback: false,
    };
  }

  const tiers = result.data.tiers as Array<{ tier: number; content: string; generated_at: number }>;

  // Try exact tier first
  const exact = tiers.find((t) => t.tier === requestedTier);
  if (exact) {
    return {
      content: exact.content,
      tier: exact.tier,
      fallback: false,
      generated_at: exact.generated_at,
    };
  }

  // Fall back to nearest available tier
  if (tiers.length > 0) {
    const sorted = [...tiers].sort(
      (a, b) => Math.abs(a.tier - requestedTier) - Math.abs(b.tier - requestedTier),
    );
    const nearest = sorted[0];
    return {
      content: nearest.content,
      tier: nearest.tier,
      fallback: true,
      generated_at: nearest.generated_at,
    };
  }

  return {
    content: NO_DIGEST_MESSAGE,
    tier: requestedTier,
    fallback: false,
  };
}
