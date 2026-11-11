/** The conditions a derived content transition holds in its batch: the source is still live, and its bytes are proved. */
import type { DerivedContentSource, VerifiedContent } from '../../core/registered-content.js';
import { TRANSCRIPT_PARSE_ADAPTER } from '../../constants.js';
import { credentialLive } from '../identity/capture-credential.js';

/** An internal source still belongs to the live Project and untombstoned session. */
export const sourceLiveGuard = (source: DerivedContentSource) => {
  const credential = source.memberTokenId === undefined ? { sql: '1', params: [] } : credentialLive(source.memberTokenId);
  // A server source may re-derive the transcript parser's own earlier event for its session; the replay gate decides whether it lands.
  const rederived = source.memberTokenId === undefined ? ` AND NOT (producer_adapter='${TRANSCRIPT_PARSE_ADAPTER}' AND session_id=?)` : '';
  return {
    sql: `(${credential.sql}) AND EXISTS (SELECT 1 FROM projects WHERE project_id=?)
    AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)
    AND NOT EXISTS (SELECT 1 FROM events WHERE project_id=? AND event_id=? AND envelope_hash<>?${rederived})`,
    params: [...credential.params, source.projectId, source.projectId, source.sessionId, source.projectId, source.eventId, source.envelopeHash,
      ...(source.memberTokenId === undefined ? [source.sessionId] : [])],
  };
};

/** Exact immutable generation and durable read-back evidence required by a content transition. */
export function verifiedContentSql(source: DerivedContentSource, content: VerifiedContent): { sql: string; params: unknown[] } {
  return {
    sql: `EXISTS (SELECT 1 FROM registered_content_proofs p JOIN blobs b
      ON b.project_id=p.project_id AND b.key=p.key AND b.generation IS p.generation AND b.size=p.size
      WHERE p.project_id=? AND p.source_kind=? AND p.source_id=? AND p.event_id=? AND p.envelope_hash=?
        AND p.key=? AND p.generation IS ? AND p.digest=p.key AND p.size=? AND p.durable=1)`,
    params: [source.projectId, source.sourceKind, source.resourceId ?? source.eventId, source.eventId, source.envelopeHash,
      content.key, content.generation, content.size],
  };
}
