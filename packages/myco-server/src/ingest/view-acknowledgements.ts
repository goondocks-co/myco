import type { RelationalStore, PreparedStatement } from '../core/adapters.js';
import type { ReadScope } from '../read/scope.js';
import { acknowledgePrompt } from '../core/extraction-acks.js';
import { legacyAckFeedStatement } from './view-lifecycle.js';
import { carriesCoverageSql } from '../core/coverage-carry.js';
import { viewAcknowledgementBalanceStatements } from './view-projections.js';

/** A late legacy acknowledgement resolves only effective live or parent counterparts in its transaction. */
export function lateLegacyCoverageStatement(
  db: RelationalStore,
  project: string,
  session: string,
  ack: string,
  now: number,
): PreparedStatement {
  const legacy = {
    id: 'l.prompt_id',
    claim: 'l.claim',
    key: 'l.source_key',
    thread: 'l.source_thread',
    record: 'l.source_record',
    scheme: 'pins.scheme',
    shape: `CASE WHEN l.prompt_kind='queued_command' THEN 'queued' WHEN pins.scheme IN ('stamp-or-offset-v1','stamp-or-offset-v2') THEN 'stamped' END`,
  };
  const current = {
    id: 'p.prompt_id',
    claim: 'p.claim',
    key: 'p.source_key',
    thread: 'p.source_thread',
    record: 'p.source_record',
    scheme: 'pins.scheme',
    shape: `CASE WHEN p.prompt_kind='queued_command' THEN 'queued' WHEN json_extract(p.canonical_identity,'$[2]')='stamp' THEN 'stamped' END`,
  };
  return db
    .prepare(
      `WITH pins AS(SELECT CASE WHEN COUNT(DISTINCT prompt_identity_scheme)=1 THEN MIN(prompt_identity_scheme) ELSE 'mixed' END scheme
    FROM transcripts WHERE project_id=? AND session_id=?)
   INSERT OR IGNORE INTO extraction_acks(project_id,ack_id,session_id,kind,source_transcript_id,source_offset,source_end,run_id,acknowledged_at)
   SELECT a.project_id,'view:'||a.ack_id||':'||p.instance_id,a.session_id,'source',p.source_transcript_id,p.source_offset,p.source_end,a.run_id,?
   FROM extraction_acks a JOIN prompt_batches l ON l.project_id=a.project_id AND l.prompt_id=a.record_id
   JOIN fact_classes f ON f.project_id=l.project_id AND f.table_name='prompt_batches' AND f.record_id=l.prompt_id AND f.class='legacy'
   JOIN session_views s ON s.project_id=a.project_id AND s.session_id=a.session_id AND s.legacy='published'
   CROSS JOIN view_visible v ON v.project_id=s.project_id AND v.session_id=s.session_id
   CROSS JOIN view_prompts p ON p.project_id=v.project_id AND p.instance_id=v.instance_id AND p.prompt_id IN(
     SELECT prompt_id FROM view_prompts INDEXED BY idx_view_prompt_source WHERE project_id=v.project_id AND instance_id=v.instance_id
       AND claim=l.claim AND source_key=l.source_key AND source_thread=l.source_thread AND source_record=l.source_record
     UNION ALL SELECT l.prompt_id) CROSS JOIN pins
   WHERE a.project_id=? AND a.session_id=? AND a.ack_id=? AND a.kind='record' AND (${carriesCoverageSql(legacy, current)})
     AND NOT EXISTS(SELECT 1 FROM prompt_batches fact WHERE fact.project_id=p.project_id AND fact.prompt_id=p.prompt_id AND fact.session_id=p.session_id
       AND NOT EXISTS(SELECT 1 FROM fact_classes fc WHERE fc.project_id=fact.project_id AND fc.table_name='prompt_batches' AND fc.record_id=fact.prompt_id AND fc.class='legacy'))
     AND NOT EXISTS(SELECT 1 FROM view_visible higher JOIN view_prompts shadow ON shadow.project_id=higher.project_id AND shadow.instance_id=higher.instance_id AND shadow.prompt_id=p.prompt_id
       WHERE higher.project_id=v.project_id AND higher.session_id=v.session_id AND higher.precedence<v.precedence)`,
    )
    .bind(project, session, now, project, session, ack);
}

/** Dormant acknowledgement composition keeps coverage and the conversion feed in one transaction. */
export function acknowledgeViewPrompt(
  db: RelationalStore,
  scope: ReadScope,
  runId: string,
  target: Parameters<typeof acknowledgePrompt>[3],
  now: number,
) {
  return acknowledgePrompt(db, scope, runId, target, now, ({ db, projectId, sessionId, recordId, ackId }) => {
    const balance = viewAcknowledgementBalanceStatements(db, projectId, sessionId, recordId);
    return {
      before: balance.before,
      after: [
        legacyAckFeedStatement(db, projectId, sessionId, ackId),
        lateLegacyCoverageStatement(db, projectId, sessionId, ackId, now),
        ...balance.after,
      ],
    };
  });
}
