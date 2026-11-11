import { write, type Bound } from '../index.js';

/** What one document commit adds to the session's catalog row: counter deltas, the turn fields it settles, and its chunk numbering. */
export interface CatalogDelta {
  prompts: number; userPrompts: number; replies: number; toolCalls: number; failedTools: number; plans: number; mycoCalls: number;
  firstPrompt: string | null; openTurn: string | null; lastRecordAt: number | null; nextChunk: number; now: number;
  /** The first page chunk this commit rewrote, or null: a summary catch-up past it starts over from there. */
  rewrittenBefore: number | null;
}

type Delta = [project: string, session: string, prompts: number, userPrompts: number, replies: number, toolCalls: number, failedTools: number,
  plans: number, mycoCalls: number, firstPrompt: string | null, openTurn: string | null, lastRecordAt: number | null, nextChunk: number, now: number,
  rewrittenBefore: number | null];

const RESTART = `(?15 IS NOT NULL AND rollup_after IS NOT NULL AND (rollup_after>=?15
      OR ((rollup_page>0 OR rollup_record>0) AND ?15=(SELECT c.chunk_no FROM session_chunks c
        WHERE c.project_id=session_documents.project_id AND c.session_id=session_documents.session_id AND c.generation=session_documents.generation
          AND c.kind='page' AND c.chunk_no>session_documents.rollup_after ORDER BY c.chunk_no LIMIT 1))))`;
const SET = `prompts=prompts+?3,user_prompts=user_prompts+?4,replies=replies+?5,tool_calls=tool_calls+?6,failed_tools=failed_tools+?7,plans=plans+?8,myco_calls=myco_calls+?9,
        rollup_after=CASE WHEN ${RESTART} THEN -1 ELSE rollup_after END,
        rollup_page=CASE WHEN ${RESTART} THEN 0 ELSE rollup_page END,rollup_record=CASE WHEN ${RESTART} THEN 0 ELSE rollup_record END,
        rollup_epoch=rollup_epoch+CASE WHEN ${RESTART} THEN 1 ELSE 0 END,
        paths_build=CASE WHEN ${RESTART} THEN NULL ELSE paths_build END,myco_build=CASE WHEN ${RESTART} THEN 0 ELSE myco_build END,
        first_prompt=?10,open_turn_key=?11,last_record_at=MAX(COALESCE(last_record_at,0),COALESCE(?12,0)),next_chunk=?13,updated_at=?14`;

const published = write<Delta>({ name: 'documents.catalogAfterPublication', sql:
  `UPDATE session_documents SET ${SET} WHERE project_id=?1 AND session_id=?2` });
const restored = write<[...Delta, generation: number, build: string | null]>({ name: 'documents.catalogAfterRestore', sql:
  `UPDATE session_documents SET state='live',generation=?16,restore_hold=NULL,due_at=0,build=?17,${SET} WHERE project_id=?1 AND session_id=?2` });

const delta = (project: string, session: string, d: CatalogDelta): Delta => [project, session, d.prompts, d.userPrompts, d.replies, d.toolCalls,
  d.failedTools, d.plans, d.mycoCalls, d.firstPrompt, d.openTurn, d.lastRecordAt, d.nextChunk, d.now, d.rewrittenBefore];

/** The session's catalog row after a publication commit. */
export const catalogAfterPublication = (project: string, session: string, d: CatalogDelta): Bound => published.bind(...delta(project, session, d));

/** The session's catalog row after a restore commit: live at the restored generation, with its build marker. */
export const catalogAfterRestore = (project: string, session: string, d: CatalogDelta, restore: { generation: number; build: string | null }): Bound =>
  restored.bind(...delta(project, session, d), restore.generation, restore.build);
