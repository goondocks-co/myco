import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { liveGenerationSql } from './live-generation.js';

export interface DocumentCountersRow {
  turns: number; user_turns: number; person_entries: number; nested_tools: number; reported_errors: number;
  prompts: number; instruction_prompts: number; replies: number; tool_calls: number; failed_tools: number; files_edited: number; myco_calls: number; plans: number;
  last_record_at: number | null; first_prompt: string | null; attachments: number;
}

const counters = read<[project: string, session: string], DocumentCountersRow>({ name: 'documentCatalog.counters', sql:
  `WITH totals AS (SELECT COUNT(*) AS turns,COALESCE(SUM(origin='user'),0) AS user_turns,
      COALESCE(SUM(json_extract(tool_state,'$.nested')),0) AS nested_tools,COALESCE(SUM(json_extract(tool_state,'$.reportedErrors')),0) AS reported_errors FROM session_prompts
      WHERE project_id=?1 AND session_id=?2 AND generation=${liveGenerationSql('?1', '?2')} AND turn_key=prompt_id)
    SELECT prompts, user_prompts AS instruction_prompts, replies, tool_calls, failed_tools, files_edited, myco_calls, plans, last_record_at, first_prompt,totals.turns,totals.user_turns,totals.nested_tools,totals.reported_errors,
      (SELECT COUNT(*) FROM session_prompts p WHERE p.project_id=d.project_id AND p.session_id=d.session_id AND p.generation=d.generation AND p.origin='user') AS person_entries,
      (SELECT COUNT(*) FROM attachments a WHERE a.project_id = d.project_id AND a.session_id = d.session_id) AS attachments
    FROM session_documents d CROSS JOIN totals WHERE project_id = ?1 AND session_id = ?2 AND state = 'live'` });
const instruction = read<[project: string, session: string], { held: number }>({ name: 'documentCatalog.hasInstruction', sql:
  `SELECT 1 AS held FROM session_documents WHERE project_id = ?1 AND session_id = ?2 AND state = 'live' AND user_prompts > 0` });
const anchor = read<[project: string, session: string, prompt: string], { ord: number; created_at: number | null; prompt_id: string }>({ name: 'documentCatalog.turnAnchor', sql:
  `SELECT p.ord,c.created_at,p.prompt_id FROM session_prompts p
      LEFT JOIN turn_cards c ON c.project_id=p.project_id AND c.session_id=p.session_id AND c.turn_key=p.turn_key
      WHERE p.project_id=?1 AND p.session_id=?2 AND p.generation=${liveGenerationSql('?1', '?2')}
        AND p.prompt_id=?3` });

/** A session's live document counters and its attachment count, or null while it has no live document. */
export async function documentCountersRow(db: RelationalStore, project: string, session: string): Promise<DocumentCountersRow | null> {
  const [[row]] = await readSet(db, counters.bind(project, session));
  return row ?? null;
}

/** True when the session's live document holds an instruction. */
export async function liveDocumentHasInstruction(db: RelationalStore, project: string, session: string): Promise<boolean> {
  const [rows] = await readSet(db, instruction.bind(project, session));
  return rows.length > 0;
}

/** Where a prompt of the live document sits in order and in card time, or null when the document holds no such prompt. */
export async function turnAnchor(db: RelationalStore, project: string, session: string, prompt: string): Promise<{ ord: number; created_at: number | null; prompt_id: string } | null> {
  const [[row]] = await readSet(db, anchor.bind(project, session, prompt));
  return row ?? null;
}
