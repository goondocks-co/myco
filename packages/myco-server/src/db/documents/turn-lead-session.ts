import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { liveGenerationSql } from './live-generation.js';
import { openingTurnSql } from './turn-origin.js';

const session = read<[project: string, session: string], { agent: string | null; launched: number; opening_turn: string | null }>({ name: 'turnLead.session', sql:
  `SELECT s.agent,s.launch_parent_session_id IS NOT NULL AS launched,
      (SELECT o.prompt_id ${openingTurnSql('o', '?1', '?2', liveGenerationSql('?1', '?2'))}) AS opening_turn
    FROM sessions s WHERE s.project_id=?1 AND s.session_id=?2` });

/** What every turn lead of a session reads once: its agent, whether captured launch lineage names a launcher, and its opening turn. */
export async function turnLeadSession(db: RelationalStore, project: string, sessionId: string) {
  const [[row]] = await readSet(db, session.bind(project, sessionId));
  return { agent: row?.agent ?? null, launched: Number(row?.launched ?? 0) === 1, openingTurn: row?.opening_turn ?? null };
}
