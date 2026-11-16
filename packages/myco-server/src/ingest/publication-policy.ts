import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { PROMPT_ID_SCHEMES } from '@goondocks/myco-shared/prompt-identity';

/** The record identity scheme a newly published transcript is minted under. */
const PUBLISHED_RECORD_SCHEME = 'source-record-v1';

/** Immutable policy expressions for a transcript's first publication frontier. */
export function publicationPolicy(promptPin: string, agent: string): { prompt: string; record: string } {
  // A hook-minted pin names no transcript prompt; the first read admits the declared native derivation.
  const native = `CASE ${agent} ${CAPTURE_RULE_BUNDLES.filter(bundle => bundle.promptIdentity.kind === 'transcript-only')
    .map(bundle => `WHEN '${bundle.name.replaceAll("'", "''")}' THEN '${bundle.promptIdentity.scheme}'`).join(' ')} END`;
  const source = `CASE ${promptPin} WHEN 'hook-mint-v1' THEN COALESCE(${native},${promptPin}) ELSE ${promptPin} END`;
  const mapped = `CASE (${source}) WHEN 'offset-v1' THEN 'offset-v2' WHEN 'stamp-or-offset-v1' THEN 'stamp-or-offset-v2' ELSE (${source}) END`;
  const schemes = Object.keys(PROMPT_ID_SCHEMES).map(scheme => `'${scheme}'`).join(',');
  return { prompt: `CASE WHEN (${mapped}) IN (${schemes}) THEN (${mapped}) END`, record: `'${PUBLISHED_RECORD_SCHEME}'` };
}
