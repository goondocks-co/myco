import { instructionOriginSql } from '../document-tables.js';
import type { RelationalStore } from '../../core/adapters.js';
import { first, read, rows } from '../index.js';
import { titleTurnRevisionSql } from '../sessions/title-coverage.js';
import { turnOriginSql } from './turn-origin.js';

import { TITLE_HEAD_TURNS, TITLE_TAIL_TURNS, TITLE_TAIL_ANY_TURNS, TITLE_MIDDLE_TURNS } from '../../core/titling-params.js';

export interface TitleSnapshot { generation: number; instructionPrompts: number; materialAt: number; throughTurnKey: string; throughTurnRevision: number; turnCount: number; agent: string | null; personTurns: number; first: number; last: number }
const snapshot = read<[project: string, session: string], TitleSnapshot>({ name: 'titleMaterial.snapshot', sql: `
  SELECT d.generation,d.user_prompts AS instructionPrompts,s.last_received_at AS materialAt,d.open_turn_key AS throughTurnKey,${titleTurnRevisionSql('d')} AS throughTurnRevision,s.agent,
    (SELECT COUNT(*) FROM session_prompts p WHERE p.project_id=d.project_id AND p.session_id=d.session_id AND p.generation=d.generation AND p.turn_key=p.prompt_id) AS turnCount,
    (SELECT COUNT(*) FROM session_prompts p WHERE p.project_id=d.project_id AND p.session_id=d.session_id AND p.generation=d.generation AND p.turn_key=p.prompt_id AND ${turnOriginSql('p')}='user') AS personTurns,
    (SELECT MIN(ord) FROM session_prompts p WHERE p.project_id=d.project_id AND p.session_id=d.session_id AND p.generation=d.generation AND p.turn_key=p.prompt_id) AS first,
    (SELECT MAX(ord) FROM session_prompts p WHERE p.project_id=d.project_id AND p.session_id=d.session_id AND p.generation=d.generation AND p.turn_key=p.prompt_id) AS last
  FROM session_documents d JOIN sessions s ON s.project_id=d.project_id AND s.session_id=d.session_id
  WHERE d.project_id=?1 AND d.session_id=?2 AND d.state='live'` });
const selection = (direction: 'ASC' | 'DESC', origins: 'instruction' | 'all') => read<[project: string, session: string, generation: number, from: number, to: number, limit: number], { promptId: string; ord: number; preview: string; origin: string }>({
  name: `titleMaterial.${direction}.${origins}`, sql: `SELECT prompt_id AS promptId,ord,preview,${turnOriginSql('session_prompts')} AS origin FROM session_prompts INDEXED BY idx_session_prompts_turns
    WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND turn_key=prompt_id AND ord>=?4 AND ord<=?5 ${origins === 'instruction' ? `AND ${instructionOriginSql('session_prompts.origin')}` : ''}
    ORDER BY ord ${direction},prompt_id ${direction} LIMIT ?6`,
});
const ascending = selection('ASC', 'instruction'), descending = selection('DESC', 'instruction'), latest = selection('DESC', 'all'), middle = selection('ASC', 'all');
export const titleMaterialSnapshot = (db: RelationalStore, project: string, session: string) => first(db, snapshot.bind(project, session));

/** Head, tail and evenly spaced middle seeks are bounded independently of session length. The tail holds the session's last turns whoever opened them, then its last instruction turns. */
export async function titleMaterialTurns(db: RelationalStore, project: string, session: string, held: TitleSnapshot) {
  const head = await rows(db, ascending.bind(project, session, held.generation, held.first, held.last, TITLE_HEAD_TURNS));
  const closing = [...await rows(db, latest.bind(project, session, held.generation, held.first, held.last, TITLE_TAIL_ANY_TURNS)), ...await rows(db, descending.bind(project, session, held.generation, held.first, held.last, TITLE_TAIL_TURNS))];
  const tail = [...new Map(closing.map(r => [r.promptId, r])).values()].slice(0, TITLE_TAIL_TURNS).sort((a, b) => b.ord - a.ord);
  const full = new Set([...head, ...tail].map(r => r.promptId));
  const selected = new Map([...head, ...tail].map(r => [r.promptId, r]));
  const from = head.at(-1)?.ord, to = tail.at(-1)?.ord;
  if (from !== undefined && to !== undefined && to > from) {
    for (let i = 1; i <= TITLE_MIDDLE_TURNS; i++) {
      const row = (await rows(db, middle.bind(project, session, held.generation, from + (to - from) * i / (TITLE_MIDDLE_TURNS + 1), to - 1, 1)))[0];
      if (row !== undefined) selected.set(row.promptId, row);
    }
  }
  return [...selected.values()].sort((a, b) => a.ord - b.ord).map(r => ({ ...r, full: full.has(r.promptId) }));
}
