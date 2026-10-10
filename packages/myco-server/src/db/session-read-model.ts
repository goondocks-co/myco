/** The ordered extraction candidates, including every material and visibility guard. */
export const EXTRACTION_CANDIDATE_SQL = 'has_session = 1 AND tombstoned = 0 AND ended_at IS NOT NULL AND eligible_prompts > 0 AND pending_transcripts = 0';

/** A transcript whose declared bytes are unread or whose parser recorded a failure. */
export const transcriptPendingSql = (alias: string): string => `(${alias}.parsed_offset < ${alias}.size OR ${alias}.parse_error IS NOT NULL)`;
