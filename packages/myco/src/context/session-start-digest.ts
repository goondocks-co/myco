import type { MycoConfig } from '@myco/config/schema.js';
import { DEFAULT_AGENT_ID, DIGEST_FALLBACK_TIER } from '@myco/constants.js';
import { getDigestExtract } from '@myco/db/queries/digest-extracts.js';
import { GLOBAL_SCOPE, type ProjectScope } from '@myco/grove/ids.js';

export interface SessionStartDigestPayload {
  content: string;
  tier: number | null;
}

export function shouldInjectSessionStartDigest(digest: MycoConfig['cortex']['digest']): boolean {
  return digest.inject_on_session_start === true;
}

export function getSessionStartDigestPayload(
  digest: MycoConfig['cortex']['digest'],
  scope: ProjectScope = GLOBAL_SCOPE,
): SessionStartDigestPayload {
  const extract =
    getDigestExtract(DEFAULT_AGENT_ID, digest.tier, scope) ??
    getDigestExtract(DEFAULT_AGENT_ID, DIGEST_FALLBACK_TIER, scope);

  return {
    content: extract?.content ?? '',
    tier: extract?.tier ?? null,
  };
}
