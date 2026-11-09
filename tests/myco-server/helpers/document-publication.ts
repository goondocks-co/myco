import type { RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import type { DocRecord } from '@myco-server-worker/content/document.js';
import { DocumentBatch } from '@myco-server-worker/ingest/document-batch.js';
import { catchUpPhase } from '@myco-server-worker/db/projections/catchup.js';
import { LOCATOR_PHASE } from '@myco-server-worker/db/documents/locators.js';

export const MIN = 60_000;
export const tx = 'tx_0123456789abcdef0123456789abcdef';
export const item = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload }) + '\n';
export const user = (turn: string, text: string) =>
  item('turn_context', { turn_id: turn }) + item('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
export const reply = (text: string) => item('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
export const call = item('response_item', { type: 'function_call', call_id: 'c1', name: 'shell', arguments: JSON.stringify({ command: 'npm test', env: 'x'.repeat(300_000) }) });
export const output = item('response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' });
export const limits = () => ({ calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
export const one = async (db: RelationalStore, sql: string, ...params: unknown[]) => db.prepare(sql).bind(...params).first<Record<string, unknown>>();
/** Queues a locator repair for every live document with a prompt whose page is unknown or held by none, as the catch-up does. */
export async function queueLocatorRepair(db: RelationalStore) {
  await db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='document_locators'").run();
  while (await catchUpPhase(db, LOCATOR_PHASE as never) > 0);
}

export const counters = (db: RelationalStore, session: string) =>
  one(db, `SELECT prompts,user_prompts,replies,tool_calls,failed_tools,plans,open_turn_key,due_at FROM session_documents WHERE session_id=?`, session);

/** A shell call and its result, which the parser publishes whole. */
export const ran = (id: string) => item('response_item', { type: 'function_call', call_id: id, name: 'shell', arguments: JSON.stringify({ command: `step ${id}` }) })
  + item('response_item', { type: 'function_call_output', call_id: id, output: 'ok' });

/** Places records on a live document without a wake budget. */
export async function seedRecords(env: Pick<ServerEnv, 'db' | 'blobs'>, session: string, records: readonly DocRecord[], at: number) {
  const db = env.db;
  const doc = await one(db, `SELECT d.*,s.created_by_token_id token_id FROM session_documents d JOIN sessions s USING(project_id,session_id) WHERE d.session_id=?`, session);
  const seed = new DocumentBatch(env, 'project', session, doc as never);
  await seed.open();
  await seed.place(records, null);
  await seed.commit(true, 'live', at, () => ({ sql: '1', params: [] }), () => {
    const set = seed.documentSet(at);
    return { before: [], after: [db.prepare(`UPDATE session_documents SET ${set.sql} WHERE project_id='project' AND session_id=?`).bind(...set.params, session)] };
  });
}
