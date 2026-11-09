import type { RelationalStore } from '../../core/adapters.js';
import { READ_ORIGINS } from '../../read/extraction-origins.js';
import { notTombstonedSql } from '../session-read-model.js';
import { SESSION_OWNER } from '../document-tables.js';
import { read, readSet } from '../index.js';

/** Where a prompt sits in a session's live document: the whole identity a read binds before it opens that document's pages. */
interface PromptLocator {
  projectId: string;
  sessionId: string;
  generation: number;
  documentRevision: number | null;
  /** The prompt's turn; null for a prompt no turn holds. */
  turn: string | null;
  /** The owner whose pages hold its record. */
  owner: string;
  /** The page of that owner, null when not yet recorded, -1 when no page holds it. */
  page: number | null;
  promptId: string;
}

const locator = read<[project: string, session: string, prompt: string], { generation: number; document_revision: number | null; turn: string | null; page: number | null }>({
  name: 'documentLocator.prompt', sql: `
  SELECT d.generation,d.publication_input_revision AS document_revision,p.turn_key AS turn,p.page
  FROM session_documents d CROSS JOIN session_prompts p
    ON p.project_id=d.project_id AND p.session_id=d.session_id AND p.generation=d.generation AND p.prompt_id=?3
  WHERE d.project_id=?1 AND d.session_id=?2 AND d.state='live'` });

/** The prompt's locator in the session's live document, or null when that document holds no such prompt. */
export async function promptLocator(db: RelationalStore, projectId: string, sessionId: string, promptId: string): Promise<PromptLocator | null> {
  const [rows] = await readSet(db, locator.bind(projectId, sessionId, promptId));
  const row = rows[0];
  return row === undefined ? null : { projectId, sessionId, generation: row.generation, documentRevision: row.document_revision,
    turn: row.turn, owner: row.turn ?? SESSION_OWNER, page: row.page, promptId };
}

const extractionSource = read<[project: string, prompt: string, origins: string], { sessionId: string; referenced: number }>({
  name: 'documentLocator.extractionSource', sql: `
  SELECT p.session_id AS sessionId,EXISTS(SELECT 1 FROM event_refs r WHERE r.project_id=p.project_id AND r.record_id=p.prompt_id AND r.session_id=p.session_id AND r.kind='prompt') AS referenced
  FROM session_prompts p
  JOIN session_documents d ON d.project_id=p.project_id AND d.session_id=p.session_id AND d.generation=p.generation AND d.state='live'
  JOIN sessions s ON s.project_id=p.project_id AND s.session_id=p.session_id
  WHERE p.project_id=?1 AND p.prompt_id=?2 AND p.origin IN (SELECT value FROM json_each(?3)) AND ${notTombstonedSql('s')}
  LIMIT 3` });

/** The captured session a prompt belongs to, within its Project: the one live document holding it, or the one a member event names; null when neither settles it. */
export async function extractionSourceSession(db: RelationalStore, projectId: string, promptId: string): Promise<string | null> {
  const [rows] = await readSet(db, extractionSource.bind(projectId, promptId, JSON.stringify(READ_ORIGINS)));
  if (rows.length === 1) return rows[0]!.sessionId;
  const referenced = rows.filter(row => row.referenced === 1);
  return referenced.length === 1 ? referenced[0]!.sessionId : null;
}
