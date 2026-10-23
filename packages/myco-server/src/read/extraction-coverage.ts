import { READ_ORIGINS } from './extraction-origins.js';
import type { RelationalStore } from '../core/adapters.js';
import type { ReadScope } from './scope.js';

/** Historical flags and durable record acknowledgements each have an indexed existence probe. */
export const ACKNOWLEDGED_PROMPTS_SQL = `SELECT 1 AS found WHERE EXISTS (
    SELECT 1 FROM prompt_batches p WHERE p.project_id = ? AND p.processed = 1
      AND p.origin IN (${READ_ORIGINS.map(origin => `'${origin}'`).join(',')}) LIMIT 1)
    OR EXISTS (SELECT 1 FROM extraction_acks a JOIN prompt_batches p
      ON p.project_id = a.project_id AND p.prompt_id = a.record_id
      WHERE a.project_id = ? AND a.kind = 'record'
        AND p.origin IN (${READ_ORIGINS.map(origin => `'${origin}'`).join(',')}) LIMIT 1)`;

export async function hasAcknowledgedPrompts(db: RelationalStore, scope: ReadScope): Promise<boolean> {
  return await db.prepare(ACKNOWLEDGED_PROMPTS_SQL)
    .bind(scope.projectId, scope.projectId).first() !== null;
}

/** The fact/legacy unread predicate, including the historical acknowledgement flag. */
export function unreadPromptSql(row: string, options: { beforeLedger?: boolean; exceptAck?: string } = {}): string {
  const historical = `${row}.processed = 0 AND ${row}.origin IN (${READ_ORIGINS.map(origin => `'${origin}'`).join(',')})`;
  if (options.beforeLedger === true) return `(${historical})`;
  return `(${historical} AND NOT EXISTS (SELECT 1 FROM extraction_acks a
    WHERE a.project_id = ${row}.project_id AND a.record_id = ${row}.prompt_id AND a.kind = 'record'${options.exceptAck === undefined ? '' : ` AND a.ack_id <> ${options.exceptAck}`}))`;
}
