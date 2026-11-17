import { occurredAt } from '../session-dates.js';

/** Explicit observation dates govern curated notes; legacy consolidations retain their original date interpretation. */
export const sporeLearnedAtSql = (spore: string, session: string): string => `COALESCE(${spore}.observed_at,MIN(
  COALESCE(${occurredAt(`${session}.`)},${spore}.created_at),
  COALESCE((SELECT MIN(COALESCE(${occurredAt('origin_session.')},origin.created_at))
    FROM resolution_events learned JOIN spores origin ON origin.project_id=learned.project_id AND origin.id=learned.spore_id
    LEFT JOIN sessions origin_session ON origin_session.project_id=origin.project_id AND origin_session.session_id=origin.session_id
    WHERE learned.project_id=${spore}.project_id AND learned.new_spore_id=${spore}.id AND learned.action='consolidate'),${spore}.created_at)))`;
