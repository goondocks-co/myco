import { write, type BindValue, type Bound } from './kernel/statement.js';

export const EVENT_REFERENCE_COLUMNS = 'project_id,event_id,session_id,kind,record_id,blob,output_blob';
export const eventReferenceUpdates = (preferExisting: boolean): string => ['record_id','blob','output_blob'].map(field=>
  `${field}=COALESCE(${preferExisting?`event_refs.${field},excluded.${field}`:`excluded.${field},event_refs.${field}`})`).join(',');

type ReferenceParams = [record: BindValue, blob: BindValue, output: BindValue, project: BindValue, event: BindValue, session: BindValue];
const restoreReference = (name: string, preferExisting: boolean) => write<ReferenceParams, { event_id: string }>({ name, sql:
  `INSERT INTO event_refs(${EVENT_REFERENCE_COLUMNS})
    SELECT project_id,event_id,session_id,kind,?,?,? FROM events WHERE project_id=? AND event_id=? AND session_id=?
    ON CONFLICT(project_id,event_id) DO UPDATE SET ${eventReferenceUpdates(preferExisting)}
    RETURNING event_id` });
const restoreKeepingHeld = restoreReference('eventRefs.restoreKeepingHeld', true);
const restoreTakingIncoming = restoreReference('eventRefs.restoreTakingIncoming', false);

/** A restored event's references use its persisted Project, session and kind. */
export function eventReferenceStatement(row: Readonly<Record<string,unknown>>, preferExisting: boolean): Bound<{ event_id: string }, 'write'> {
  const value = (field: string) => (row[field] ?? null) as BindValue;
  return (preferExisting ? restoreKeepingHeld : restoreTakingIncoming).bind(
    value('record_id'), value('blob'), value('output_blob'), value('project_id'), value('event_id'), value('session_id'));
}
