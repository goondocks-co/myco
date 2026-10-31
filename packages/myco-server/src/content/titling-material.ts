/**
 * Titling material, read from a session's live document by the admitted titling run alone. The catalog chooses the
 * session's user turns; each is read from its first page: its prompt and the start of the prompt's first reply.
 */
import type { ContentStore } from '../core/adapters.js';
import { MATERIAL_EXCERPT_CHARS, MAX_MATERIAL_CHARS, MAX_MATERIAL_PROMPTS } from '../constants.js';
import type { TitlingMode } from '../core/titling-params.js';
import { listCatalogTurns } from '../read/document-catalog.js';
import { SessionDocument } from './session-pages.js';

export interface MaterialLine { prompt: string; response: string | null }
interface MaterialRow extends MaterialLine { promptId: string }

const lineCost = (row: MaterialLine): number => row.prompt.length + (row.response?.length ?? 0);

/** The rows that fit a character budget, taken in the given order and answered in that order. */
function fit<T extends MaterialLine>(rows: readonly T[], budget: number): { rows: T[]; used: number } {
  const kept: T[] = [];
  let used = 0;
  for (const row of rows) {
    const cost = lineCost(row);
    if (used + cost > budget) break;
    used += cost;
    kept.push(row);
  }
  return { rows: kept, used };
}

/** The session's user turns in the given order, at most `limit`, each with its prompt and first reply cut to the excerpt. */
async function materialRows(env: ContentStore, doc: SessionDocument, sessionId: string, limit: number, order: 'ASC' | 'DESC'): Promise<MaterialRow[]> {
  const turns = await listCatalogTurns(env.db, { projectId: doc.projectId }, sessionId, { origins: ['user'], limit, order });
  const rows: MaterialRow[] = [];
  for (const turn of turns.rows) {
    const { pages } = await doc.ownerPages(turn.promptId, 0, 1);
    const records = pages.flatMap((page) => page.records);
    const prompt = records.find((record) => record.k === 'prompt' && record.id === turn.promptId);
    const text = prompt === undefined ? null : await doc.body(prompt, 'text');
    if (text === null || text === '') continue;
    const reply = records.find((record) => record.k === 'reply' && record.prompt_id === turn.promptId);
    const replyText = reply === undefined ? null : await doc.body(reply, 'text');
    rows.push({ promptId: turn.promptId, prompt: text.slice(0, MATERIAL_EXCERPT_CHARS), response: replyText === null ? null : replyText.slice(0, MATERIAL_EXCERPT_CHARS) });
  }
  return rows;
}

/**
 * The session's user prompts, each with the start of its first reply, inside the character budget. At a session's end:
 * the earliest prompts. On an owner's ask or a refresh: the earliest and the latest halves, each fitted to its own half
 * of the budget, the tail from the latest prompt backwards, so what survives is the arc's end and never its middle.
 */
export async function documentTitlingMaterial(env: ContentStore, projectId: string, sessionId: string, mode: TitlingMode = 'claim'): Promise<MaterialLine[]> {
  const doc = await SessionDocument.open(env, projectId, sessionId);
  if (doc === null) return [];
  const toLine = (row: MaterialRow): MaterialLine => ({ prompt: row.prompt, response: row.response });
  if (mode === 'claim') return fit(await materialRows(env, doc, sessionId, MAX_MATERIAL_PROMPTS, 'ASC'), MAX_MATERIAL_CHARS).rows.map(toLine);
  const halfPrompts = Math.ceil(MAX_MATERIAL_PROMPTS / 2);
  const headRows = await materialRows(env, doc, sessionId, halfPrompts, 'ASC');
  const seen = new Set(headRows.map((row) => row.promptId));
  const tailRows = (await materialRows(env, doc, sessionId, MAX_MATERIAL_PROMPTS - halfPrompts, 'DESC')).filter((row) => !seen.has(row.promptId));
  const tail = fit(tailRows, Math.ceil(MAX_MATERIAL_CHARS / 2));
  const head = fit(headRows, MAX_MATERIAL_CHARS - tail.used);
  return [...head.rows, ...tail.rows.reverse()].map(toLine);
}
