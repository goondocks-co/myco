import { SEARCH_RELEVANCE_WEIGHTS } from '@goondocks/myco-shared/search-types';
import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';

/** FTS5 ranks all matching postings before returning a bounded set; facets carry no relevance weight. */
const ranked = read<[match: string, low: number, high: number, limit: number], { doc_id: number; relevance: number }>({
  name: 'searchDocuments.relevance',
  sql: `SELECT rowid AS doc_id, rank AS relevance FROM search_documents_fts
    WHERE search_documents_fts MATCH ?1 AND rowid >= ?2 AND rowid <= ?3
      AND rank MATCH 'bm25(${SEARCH_RELEVANCE_WEIGHTS.facets}, ${SEARCH_RELEVANCE_WEIGHTS.headline}, ${SEARCH_RELEVANCE_WEIGHTS.body})' ORDER BY rank LIMIT ?4`,
});

/** Global relevance candidates for each expression, without reading source records or events. */
export async function relevanceWindows(db: RelationalStore, windows: readonly { match: string; low: number; high: number; limit: number }[]) {
  if (windows.length === 0) return [];
  return readSet(db, ...windows.map((w) => ranked.bind(w.match, w.low, w.high, w.limit)));
}

const frequencies = read<[matches: string, low: number, high: number, limit: number], { frequency: number }>({
  name: 'searchDocuments.wordFrequencies',
  sql: `SELECT (SELECT COUNT(*) FROM (SELECT rowid FROM search_documents_fts
      WHERE search_documents_fts MATCH j.value AND rowid >= ?2 AND rowid <= ?3 LIMIT ?4)) AS frequency
    FROM json_each(?1) j ORDER BY j.key`,
});

/** Capped frequencies in input order, in one statement even for the longest admitted question. */
export async function wordFrequencies(db: RelationalStore, options: { matches: readonly string[]; low: number; high: number; limit: number }): Promise<number[]> {
  if (options.matches.length === 0) return [];
  const [rows] = await readSet(db, frequencies.bind(JSON.stringify(options.matches), options.low, options.high, options.limit));
  return rows.map((row) => Number(row.frequency));
}
