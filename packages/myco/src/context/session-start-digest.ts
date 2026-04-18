import type { MycoConfig } from '@myco/config/schema.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import { getDigestExtract } from '@myco/db/queries/digest-extracts.js';

const DIGEST_FALLBACK_TIER = 1500;

export interface SessionStartDigestPayload {
  content: string;
  tier: number | null;
}

export function shouldInjectSessionStartDigest(config: MycoConfig['context']): boolean {
  return config.session_start_digest_enabled === true;
}

export function getSessionStartDigestPayload(config: MycoConfig['context']): SessionStartDigestPayload {
  const extract =
    getDigestExtract(DEFAULT_AGENT_ID, config.digest_tier) ??
    getDigestExtract(DEFAULT_AGENT_ID, DIGEST_FALLBACK_TIER);

  return {
    content: extract?.content ?? '',
    tier: extract?.tier ?? null,
  };
}
