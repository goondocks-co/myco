import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, readSet, write } from '../index.js';

/** Rows of each source-activity repair stream read by one wake. */
export const LEARNING_SOURCE_REPAIR_PAGE = 100;

const streams = (['turn_cards', 'learning_sessions'] as const).map(table => {
  const name = table === 'turn_cards' ? 'Cards' : 'Sessions';
  const index = table === 'turn_cards' ? 'idx_turn_cards_source_missing' : 'idx_learning_source_missing';
  const source = `(SELECT d.last_record_at FROM session_documents d WHERE d.project_id=${table}.project_id AND d.session_id=${table}.session_id)`;
  return {
    cursor: table === 'turn_cards' ? 'learning_card_source_after' : 'learning_session_source_after',
    page: read<[cursor: string, limit: number], { id: number }>({ name: `learningRepair.page${name}`, sql: `SELECT rowid AS id FROM ${table} INDEXED BY ${index}
      WHERE source_activity_at IS NULL AND rowid>COALESCE((SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key=?1),0) ORDER BY rowid LIMIT ?2` }),
    apply: write<[ids: string], { rowid: number }>({ name: `learningRepair.apply${name}`, sql: `UPDATE ${table} SET source_activity_at=${source}
      WHERE rowid IN (SELECT value FROM json_each(?1)) AND source_activity_at IS NULL AND ${source} IS NOT NULL RETURNING rowid` }),
    save: write<[cursor: string, value: string]>({ name: `learningRepair.save${name}`, sql: 'INSERT OR REPLACE INTO schema_meta(key,value) VALUES(?1,?2)' }),
    clear: write<[cursor: string]>({ name: `learningRepair.clear${name}`, sql: 'DELETE FROM schema_meta WHERE key=?1' }),
  };
});

/** Repairs source stamps in bounded pages; rows awaiting source publication retain their place on the next traversal. */
export async function repairLearningSources(db: RelationalStore): Promise<{ changed: number; more: boolean }> {
  let changed = 0, more = false;
  for (const stream of streams) {
    const [rows] = await readSet(db, stream.page.bind(stream.cursor, LEARNING_SOURCE_REPAIR_PAGE));
    if (rows.length === 0) { await commit(db, stream.clear.bind(stream.cursor)); continue; }
    const full = rows.length === LEARNING_SOURCE_REPAIR_PAGE;
    const [applied] = await commit(db, stream.apply.bind(JSON.stringify(rows.map(row => row.id))),
      stream.save.bind(stream.cursor, String(full ? rows.at(-1)!.id : 0)));
    changed += applied.results.length;
    more ||= full && applied.results.length > 0;
  }
  return { changed, more };
}
