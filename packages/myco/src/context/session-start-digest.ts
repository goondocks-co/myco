import type { MycoConfig } from '@myco/config/schema.js';
import { DEFAULT_AGENT_ID, DIGEST_FALLBACK_TIER } from '@myco/constants.js';
import { getDigestExtract } from '@myco/db/queries/digest-extracts.js';

export interface SessionStartDigestPayload {
  content: string;
  tier: number | null;
}

export function shouldInjectSessionStartDigest(digest: MycoConfig['cortex']['digest']): boolean {
  return digest.inject_on_session_start === true;
}

export function getSessionStartDigestPayload(
  digest: MycoConfig['cortex']['digest'],
  projectId: string | null = null,
): SessionStartDigestPayload {
  const extract =
    getDigestExtract(DEFAULT_AGENT_ID, digest.tier, projectId) ??
    getDigestExtract(DEFAULT_AGENT_ID, DIGEST_FALLBACK_TIER, projectId);

  return {
    content: extract?.content ?? '',
    tier: extract?.tier ?? null,
  };
}
