import { PARSERS } from '../../ingest/parsers/registry.js';

const PARSED_AGENTS = Object.keys(PARSERS).map(agent => `'${agent.replaceAll("'", "''")}'`).join(',');

/** Publication frontiers of the session's live document, including transcripts with no frontier yet. */
const frontiers = (alias: string): string => `FROM transcripts t
  LEFT JOIN session_documents d ON d.project_id=t.project_id AND d.session_id=t.session_id AND d.state='live'
  LEFT JOIN transcript_publication p ON p.project_id=t.project_id AND p.transcript_id=t.transcript_id AND p.generation=d.generation
  WHERE t.project_id=${alias}.project_id AND t.session_id=${alias}.session_id`;

/** An agent whose transcript has no registered reader. */
export const captureUnsupportedSql = (alias: string): string => `EXISTS (SELECT 1 ${frontiers(alias)}
  AND (t.agent IS NULL OR t.agent NOT IN (${PARSED_AGENTS})))`;

/** A supported transcript whose reading stopped on a failure. */
export const captureStoppedSql = (alias: string): string => `EXISTS (SELECT 1 ${frontiers(alias)}
  AND t.agent IN (${PARSED_AGENTS}) AND p.state='failed')`;

/** Bytes a supported parser still has to publish, or member events still waiting for publication. */
export const capturePendingSql = (alias: string): string => `(EXISTS (SELECT 1 ${frontiers(alias)}
  AND t.agent IN (${PARSED_AGENTS}) AND COALESCE(p.state,'active')<>'failed' AND COALESCE(p.published_offset,0)<t.size)
  OR EXISTS (SELECT 1 FROM publish_queue q WHERE q.project_id=${alias}.project_id AND q.session_id=${alias}.session_id AND q.failure IS NULL))`;
