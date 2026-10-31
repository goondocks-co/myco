/** A document `d` conversion still owes: waiting, with its session header held and no tombstone. */
export const CONVERTIBLE_SQL = `d.state='convert' AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id=d.project_id AND s.session_id=d.session_id)
  AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=d.project_id AND t.session_id=d.session_id)`;
