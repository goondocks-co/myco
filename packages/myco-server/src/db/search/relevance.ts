import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';

const frequencies = read<[scope: string, prefixes: string, terms: string, low: number, high: number, limit: number], { kind: number; term: number; frequency: number }>({
  name: 'searchDocuments.wordFrequencies',
  sql: `SELECT p.key AS kind, t.key AS term, (SELECT COUNT(*) FROM (SELECT rowid FROM search_documents_fts
      WHERE search_documents_fts MATCH ?1 || ' AND ' || p.value || ' AND {headline body}:(' || t.value || ')'
      AND rowid >= ?4 AND rowid <= ?5 LIMIT ?6)) AS frequency
    FROM json_each(?2) p CROSS JOIN json_each(?3) t ORDER BY p.key, t.key`,
});

/** Capped frequencies without repeating the Project reach for each word. */
export async function wordFrequencies(db: RelationalStore, options: { scope: string; prefixes: readonly string[]; terms: readonly string[]; low: number; high: number; limit: number }): Promise<number[][]> {
  if (options.prefixes.length === 0 || options.terms.length === 0) return [];
  const [rows] = await readSet(db, frequencies.bind(options.scope, JSON.stringify(options.prefixes), JSON.stringify(options.terms), options.low, options.high, options.limit));
  const counts = options.prefixes.map(() => options.terms.map(() => 0));
  for (const row of rows) counts[Number(row.kind)]![Number(row.term)] = Number(row.frequency);
  return counts;
}

const postings = read<[scope: string, prefixes: string, terms: string, low: number, high: number, limit: number], { kind: number; term: number; hits: string }>({
  name: 'searchDocuments.wordPostings',
  sql: `SELECT p.key AS kind, t.key AS term, (WITH hits AS MATERIALIZED (
    SELECT rowid AS doc_id, length(highlight(search_documents_fts, 1, '', 'x')) > length(COALESCE(headline, '')) AS in_headline
    FROM search_documents_fts WHERE search_documents_fts MATCH ?1 || ' AND ' || json_extract(p.value, '$.expression') || ' AND {headline body}:(' || t.value || ')'
      AND rowid >= ?4 AND rowid <= MIN(?5, json_extract(p.value, '$.high')) ORDER BY rowid DESC LIMIT ?6)
    SELECT json_group_array(json_array(doc_id, in_headline)) FROM hits) AS hits
    FROM json_each(?2) p CROSS JOIN json_each(?3) t`,
});

/** A capped newest prefix carries exact membership and headline presence as well as frequency. */
export async function wordPostings(db: RelationalStore, options: { scope: string; prefixes: readonly { expression: string; high: number }[]; terms: readonly string[]; low: number; high: number; limit: number }) {
  const found = options.prefixes.map(() => options.terms.map(() => ({ ids: new Set<number>(), headline: new Set<number>() })));
  if (options.prefixes.length === 0 || options.terms.length === 0) return found;
  const [rows] = await readSet(db, postings.bind(options.scope, JSON.stringify(options.prefixes), JSON.stringify(options.terms), options.low, options.high, options.limit));
  for (const row of rows) for (const [id, headline] of JSON.parse(row.hits) as [number, number][]) {
    const match = found[Number(row.kind)]![Number(row.term)]!;
    match.ids.add(Number(id));
    if (headline) match.headline.add(Number(id));
  }
  return found;
}

const presence = read<[scope: string, expression: string, prefix: string, chosen: string, low: number, high: number, ids: string, terms: string], { term: number; column: number; hits: string }>({
  name: 'searchDocuments.windowPresence',
  sql: `SELECT t.key AS term, c.value AS column, (WITH hits AS MATERIALIZED (
    SELECT f.rowid AS doc_id, c.value = 1 OR (EXISTS (SELECT 1 FROM json_each(?4) WHERE value = t.value)
        AND length(highlight(search_documents_fts, 1, '', 'x')) > length(COALESCE(f.headline, ''))) AS in_headline
    FROM search_documents_fts f
    WHERE search_documents_fts MATCH ?1 || ' AND ' || CASE WHEN EXISTS (SELECT 1 FROM json_each(?4) WHERE value = t.value)
        THEN ?3 ELSE ?2 END || ' AND ' || CASE c.value WHEN 1 THEN 'headline:(' ELSE '{headline body}:(' END || t.value || ')'
      AND f.rowid >= ?5 AND f.rowid <= ?6 AND +f.rowid IN (SELECT value FROM json_each(?7)) ORDER BY f.rowid DESC) SELECT json_group_array(json_array(doc_id, in_headline)) FROM hits) AS hits
    FROM json_each(?8) t CROSS JOIN json_each('[0,1]') c
    WHERE c.value = 0 OR NOT EXISTS (SELECT 1 FROM json_each(?4) WHERE value = t.value)`,
});

interface PresenceWindow { expression: string; prefix: string; terms: readonly string[]; targets?: readonly string[]; ids: readonly number[] }

/** Exact word presence inside each admitted ID range, with one cursor per word rather than per document. */
export async function windowPresence(db: RelationalStore, options: { scope: string; windows: readonly PresenceWindow[]; terms: readonly string[] }): Promise<{ headline: Set<number>; text: Set<number> }[]> {
  const windows = options.windows.filter((window) => window.ids.length > 0);
  const found = options.terms.map(() => ({ headline: new Set<number>(), text: new Set<number>() }));
  if (windows.length === 0) return found;
  const rows = await readSet(db, ...windows.map((window) => presence.bind(options.scope, window.expression, window.prefix,
    JSON.stringify(window.terms), Math.min(...window.ids), Math.max(...window.ids), JSON.stringify(window.ids), JSON.stringify(window.targets ?? options.terms))));
  rows.forEach((result, i) => {
    const targets = windows[i]!.targets ?? options.terms;
    for (const row of result) for (const [id, headline] of JSON.parse(row.hits) as [number, number][]) {
      const term = options.terms.indexOf(targets[Number(row.term)]!);
      if (headline) found[term]!.headline.add(Number(id));
      if (Number(row.column) === 0) found[term]!.text.add(Number(id));
    }
  });
  return found;
}

const matching = read<[scope: string, expression: string, low: number, high: number, ids: string], { doc_id: number }>({
  name: 'searchDocuments.windowMatches',
  sql: `SELECT rowid AS doc_id FROM search_documents_fts WHERE search_documents_fts MATCH ?1 || ' AND ' || ?2
    AND rowid >= ?3 AND rowid <= ?4 AND +rowid IN (SELECT value FROM json_each(?5)) ORDER BY rowid DESC`,
});

/** Every word must hold in a main candidate document; plan companions are combined by their owner. */
export async function windowMatches(db: RelationalStore, options: { scope: string; windows: readonly { expression: string; ids: readonly number[] }[] }): Promise<Set<number>[]> {
  if (options.windows.length === 0) return [];
  const nonempty = options.windows.map((window, i) => ({ window, i })).filter(({ window }) => window.ids.length > 0);
  const result = options.windows.map(() => new Set<number>());
  if (nonempty.length === 0) return result;
  const rows = await readSet(db, ...nonempty.map(({ window }) => matching.bind(options.scope, window.expression, Math.min(...window.ids), Math.max(...window.ids), JSON.stringify(window.ids))));
  rows.forEach((found, i) => { result[nonempty[i]!.i] = new Set(found.map((row) => Number(row.doc_id))); });
  return result;
}
