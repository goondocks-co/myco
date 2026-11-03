import { PROMPT_ID_SCHEMES } from '@goondocks/myco-shared/prompt-identity';

/** The record identity scheme a newly published transcript is minted under. */
export const PUBLISHED_RECORD_SCHEME = 'source-record-v1';

/** Immutable policy expressions for a transcript's first publication frontier. */
export function publicationPolicy(promptPin: string): { prompt: string; record: string } {
  const mapped = `CASE ${promptPin} WHEN 'offset-v1' THEN 'offset-v2' WHEN 'stamp-or-offset-v1' THEN 'stamp-or-offset-v2' ELSE ${promptPin} END`;
  const schemes = Object.keys(PROMPT_ID_SCHEMES).map(scheme => `'${scheme}'`).join(',');
  return { prompt: `CASE WHEN (${mapped}) IN (${schemes}) THEN (${mapped}) END`, record: `'${PUBLISHED_RECORD_SCHEME}'` };
}
