import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { liveGenerationSql } from './live-generation.js';

export interface PromptCatalogRow {
  tools: number; failed_tools: number; files_named: number; tool_rollup: string | null; tool_state: string | null; agent: string | null; card: string | null; fields: string | null;
}

const agent = read<[project: string, session: string], { agent: string | null }>({ name: 'turnCatalog.sessionAgent', sql:
  'SELECT agent FROM sessions WHERE project_id = ?1 AND session_id = ?2' });
const prompt = read<[project: string, session: string, prompt: string], PromptCatalogRow>({ name: 'turnCatalog.prompt', sql:
  `SELECT p.tools,p.failed_tools,p.files_named,p.tool_rollup,p.tool_state,s.agent,c.card,c.fields FROM session_prompts p
      JOIN sessions s ON s.project_id=p.project_id AND s.session_id=p.session_id
      LEFT JOIN turn_cards c ON c.project_id=p.project_id AND c.session_id=p.session_id AND c.turn_key=p.prompt_id
      WHERE p.project_id=?1 AND p.session_id=?2 AND p.generation=${liveGenerationSql('?1', '?2')} AND p.prompt_id=?3` });

/** The agent a session records, or null when it records none or the session is unknown. */
export async function sessionAgent(db: RelationalStore, project: string, session: string): Promise<{ agent: string | null } | null> {
  const [[row]] = await readSet(db, agent.bind(project, session));
  return row ?? null;
}

/** A prompt's catalog counters and rollup in the live document, with its card, or null. */
export async function promptCatalogRow(db: RelationalStore, project: string, session: string, promptId: string): Promise<PromptCatalogRow | null> {
  const [[row]] = await readSet(db, prompt.bind(project, session, promptId));
  return row ?? null;
}
