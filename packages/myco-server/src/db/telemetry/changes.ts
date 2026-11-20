import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, rows, write } from '../index.js';
import { TELEMETRY_TRACE_PAGE } from '../../core/telemetry-policy.js';

const affected = `SELECT trace_id,key_id FROM telemetry_dependency_ids WHERE session_id=?1`;
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
  [session: string, trace: string, key: string, limit: number],
  { trace_id: string; key_id: string }
>({
  name: 'telemetryChanges.page',
  sql: `SELECT * FROM (${affected}) WHERE (trace_id,key_id)>(?2,?3) ORDER BY trace_id,key_id LIMIT ?4`,
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
    page.bind(
      change.session_id,
      change.cursor_trace,
      change.cursor_key,
      TELEMETRY_TRACE_PAGE,
    ),
  );
  const last = found.at(-1);
  await commit(
    db,
    mark.bind(JSON.stringify(found)),
    ...(found.length < TELEMETRY_TRACE_PAGE
      ? [end.bind(change.project_id, change.session_id, change.revision)]
      : [advance.bind(change.project_id, change.session_id, change.revision, last!.trace_id, last!.key_id)]),
  );
}
export const telemetrySessionChangesDue = async (db: RelationalStore): Promise<boolean> =>
  (await rows(db, next.bind())).length > 0;
