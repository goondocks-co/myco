import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, rows, write } from '../index.js';
import { TELEMETRY_CLOCK_TOLERANCE_MS, TELEMETRY_TRACE_PAGE } from '../../core/telemetry-policy.js';

const affected = `SELECT w.trace_id,w.key_id FROM telemetry_dependency_ids w WHERE w.session_id=?2
 UNION SELECT w.trace_id,w.key_id FROM sessions s JOIN project_remotes p ON p.project_id=s.project_id
 JOIN telemetry_dependency_windows w ON w.remote=p.remote AND w.ref=s.branch
 WHERE s.project_id=?1 AND s.session_id=?2 AND (s.started_at BETWEEN w.start_ms-${TELEMETRY_CLOCK_TOLERANCE_MS} AND w.start_ms+${TELEMETRY_CLOCK_TOLERANCE_MS}
 OR EXISTS(SELECT 1 FROM session_prompts prompt JOIN session_documents doc ON doc.project_id=prompt.project_id AND doc.session_id=prompt.session_id AND doc.generation=prompt.generation AND doc.state='live'
 WHERE prompt.project_id=s.project_id AND prompt.session_id=s.session_id AND prompt.turn_key=prompt.prompt_id
 AND prompt.created_at BETWEEN w.start_ms-${TELEMETRY_CLOCK_TOLERANCE_MS} AND w.start_ms+${TELEMETRY_CLOCK_TOLERANCE_MS}))`;
interface Change {
  project_id: string;
  session_id: string;
  revision: number;
  cursor_trace: string;
  cursor_key: string;
}
const next = read<[], Change>({
  name: 'telemetryChanges.next',
  sql: 'SELECT * FROM telemetry_session_changes LIMIT 1',
});
const page = read<
  [project: string, session: string, trace: string, key: string, limit: number],
  { trace_id: string; key_id: string }
>({
  name: 'telemetryChanges.page',
  sql: `SELECT * FROM (${affected}) WHERE (trace_id,key_id)>(?3,?4) ORDER BY trace_id,key_id LIMIT ?5`,
});
const mark = write<[pairs: string]>({
  name: 'telemetryChanges.mark',
  sql: `UPDATE telemetry_trace_keys SET next_check=0,revision=revision+1
 WHERE (trace_id,key_id) IN (SELECT json_extract(value,'$.trace_id'),json_extract(value,'$.key_id') FROM json_each(?1))`,
});
const advance = write<[project: string, session: string, revision: number, trace: string, key: string]>({
  name: 'telemetryChanges.advance',
  sql: 'UPDATE telemetry_session_changes SET cursor_trace=?4,cursor_key=?5 WHERE project_id=?1 AND session_id=?2 AND revision=?3',
});
const end = write<[project: string, session: string, revision: number]>({
  name: 'telemetryChanges.end',
  sql: 'DELETE FROM telemetry_session_changes WHERE project_id=?1 AND session_id=?2 AND revision=?3',
});
export async function notifyTelemetrySessions(db: RelationalStore): Promise<void> {
  const change = (await rows(db, next.bind()))[0];
  if (change === undefined) return;
  const found = await rows(
    db,
    page.bind(change.project_id, change.session_id, change.cursor_trace, change.cursor_key, TELEMETRY_TRACE_PAGE),
  );
  const last = found.at(-1);
  await commit(
    db,
    mark.bind(JSON.stringify(found)),
    ...(last === undefined
      ? [end.bind(change.project_id, change.session_id, change.revision)]
      : [advance.bind(change.project_id, change.session_id, change.revision, last.trace_id, last.key_id)]),
  );
}
export const telemetrySessionChangesDue = async (db: RelationalStore): Promise<boolean> =>
  (await rows(db, next.bind())).length > 0;
