/** Counts beyond this bound are reported as at least 1000 pending turns. */
export const PENDING_CARDS_LIMIT = 1001;

/** The pending range of one session, capped before counting. */
export const pendingCardsSql = (project: string, session: string): string => `(SELECT COUNT(*) FROM (
  SELECT 1 FROM turn_cards c INDEXED BY idx_turn_cards_session_pending WHERE c.project_id = ${project}
    AND c.session_id = ${session} AND c.state = 'pending' LIMIT ${PENDING_CARDS_LIMIT}))`;
