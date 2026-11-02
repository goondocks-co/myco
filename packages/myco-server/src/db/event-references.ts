import type { RelationalStore } from '../core/adapters.js';

export const EVENT_REFERENCE_COLUMNS = 'project_id,event_id,session_id,kind,record_id,blob,output_blob';
export const eventReferenceUpdates = (preferExisting: boolean): string => ['record_id','blob','output_blob'].map(field=>
  `${field}=COALESCE(${preferExisting?`event_refs.${field},excluded.${field}`:`excluded.${field},event_refs.${field}`})`).join(',');

/** A restored event's references use its persisted Project, session and kind. */
export function eventReferenceStatement(db: RelationalStore, row: Readonly<Record<string,unknown>>, preferExisting: boolean) {
  return db.prepare(`INSERT INTO event_refs(${EVENT_REFERENCE_COLUMNS})
    SELECT project_id,event_id,session_id,kind,?,?,? FROM events WHERE project_id=? AND event_id=? AND session_id=?
    ON CONFLICT(project_id,event_id) DO UPDATE SET ${eventReferenceUpdates(preferExisting)}
    RETURNING event_id`).bind(row.record_id??null,row.blob??null,row.output_blob??null,row.project_id,row.event_id,row.session_id);
}
