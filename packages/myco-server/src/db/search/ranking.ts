import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { changed } from '../ddl.js';

/**
 * Each search dependency's revision. A kind's revision moves whenever a row changes, or a row is written or removed,
 * that a ranked page's membership or order reads: the records' instants, keys, Project, session, status and type; the
 * joined session's end, agent and branch, and its tombstone; a spilled plan's processed proof and indexed chunks; a
 * record's release classification; a Project's visibility. Writing or removing a row an FTS index mirrors also changes
 * that index. `search-revision-coverage` derives what the ranked statements read and holds every piece of it here.
 *
 * A session moves its revision only when a ranked page can see the change: while it has a title or a summary a text
 * match can list it, and while a spore, plan or turn card names it a joined agent or branch filter can. Capturing a
 * session nothing yet matches or names writes no revision.
 */
interface Watched {
  table: string; columns: readonly string[]; rows?: boolean; when?: (row: 'NEW' | 'OLD') => string;
  /** Those of `columns` that move a ranked page only for a row meeting this narrower test; the others use `when`. */
  narrow?: { columns: readonly string[]; when: (row: 'NEW' | 'OLD') => string };
}
/** Whether a text match can list this session. */
const sessionMatches = (row: 'NEW' | 'OLD') => `${row}.title IS NOT NULL OR ${row}.summary IS NOT NULL`;
/** Whether a spore, plan or turn card names this session, which a joined agent or branch filter reads. */
const sessionNamed = (row: 'NEW' | 'OLD') => ['spores', 'plans', 'turn_cards']
  .map(table => `EXISTS (SELECT 1 FROM ${table} c WHERE c.project_id = ${row}.project_id AND c.session_id = ${row}.session_id)`).join(' OR ');
export const REVISION_KINDS: Readonly<Record<string, readonly Watched[]>> = {
  spore: [{ table: 'spores', columns: ['id', 'created_at', 'status', 'observation_type', 'project_id', 'session_id'] }],
  plan: [
    { table: 'plans', columns: ['plan_key', 'created_at', 'status', 'project_id', 'session_id', 'blob_key'] },
    { table: 'processed_resources', columns: ['project_id', 'kind', 'resource_id', 'blob_key', 'classification'], rows: true, when: (row) => `${row}.kind = 'plan'` },
    { table: 'search_blob_chunks', columns: ['project_id', 'blob_key'] },
  ],
  session: [
    { table: 'sessions', columns: ['session_id', 'occurred_started_at', 'started_at', 'first_received_at', 'occurred_ended_at', 'ended_at', 'agent', 'branch', 'project_id'], rows: true,
      when: (row) => `${sessionMatches(row)} OR ${sessionNamed(row)}`,
      narrow: { columns: ['occurred_started_at', 'started_at', 'first_received_at', 'occurred_ended_at', 'ended_at'], when: sessionMatches } },
    { table: 'session_tombstones', columns: ['project_id', 'session_id'], rows: true },
  ],
  turn: [{ table: 'turn_cards', columns: ['turn_key', 'created_at', 'project_id', 'session_id'] }],
  release: [{ table: 'knowledge_release_state', columns: ['id', 'project_id', 'namespace', 'record_id', 'state', 'confidence', 'checked_at'], rows: true }],
  projects: [{ table: 'projects', columns: ['project_id', 'archived_at'], rows: true }],
};
export type RevisionKind = 'spore' | 'plan' | 'session' | 'turn' | 'release' | 'projects';

/** The revision table, its seed and the triggers that move it, as one schema step freezes them. */
export function searchRevisionStatements(): string[] {
  const bump = (kind: string) => `UPDATE search_revisions SET revision = revision + 1 WHERE kind = '${kind}'`;
  return [
    'CREATE TABLE IF NOT EXISTS search_revisions(kind TEXT PRIMARY KEY, revision INTEGER NOT NULL) WITHOUT ROWID',
    `INSERT OR IGNORE INTO search_revisions(kind, revision) VALUES ${Object.keys(REVISION_KINDS).map(kind => `('${kind}', 0)`).join(', ')}`,
    ...Object.entries(REVISION_KINDS).flatMap(([kind, watched]) => watched.flatMap(({ table, columns, rows, when, narrow }) => {
      const scoped = (watching: readonly string[], test: Watched['when']) => {
        const changedRow = `(${changed(watching)})`;
        return test === undefined ? changedRow : `(${changedRow} AND (${test('OLD')} OR ${test('NEW')}))`;
      };
      const moved = narrow === undefined ? scoped(columns, when)
        : `${scoped(columns.filter(c => !narrow.columns.includes(c)), when)} OR ${scoped(narrow.columns, narrow.when)}`;
      return [
        `CREATE TRIGGER IF NOT EXISTS search_revision_${kind}_${table}_update AFTER UPDATE OF ${columns.join(', ')} ON ${table}
      WHEN ${moved} BEGIN ${bump(kind)}; END`,
        ...(rows ? (['INSERT', 'DELETE'] as const).map(event => `CREATE TRIGGER IF NOT EXISTS search_revision_${kind}_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
      ${when === undefined ? '' : `WHEN ${when(event === 'INSERT' ? 'NEW' : 'OLD')} `}BEGIN ${bump(kind)}; END`) : []),
      ];
    })),
  ];
}

/**
 * What a full-text index ranks its matches by, as one opaque mark per index: FTS5's `averages` record (row 1 of its
 * `_data` table) holds the row count and token totals, and its structure record (row 10) every segment and a counter
 * every write moves, so any row indexed, removed or reindexed, even with the same token count, changes the mark. Two
 * reads with the same mark rank every match the same way.
 */
const INDEXES = ['spores_fts', 'plans_fts', 'sessions_fts', 'turn_cards_fts', 'search_blob_chunks_fts'] as const;
export type RankedIndex = (typeof INDEXES)[number];

const MARKS = Object.fromEntries(INDEXES.map(index => [index, read<[], { mark: string | null }>({
  name: `searchRanking.${index.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`,
  sql: `SELECT COALESCE((SELECT hex(block) FROM ${index}_data WHERE id = 1), '') || ':' || COALESCE((SELECT hex(block) FROM ${index}_data WHERE id = 10), '') AS mark`,
})])) as Record<RankedIndex, ReturnType<typeof read<[], { mark: string | null }>>>;

const REVISION = read<[string], { mark: string | null }>({ name: 'searchRanking.revision', sql: 'SELECT CAST(revision AS TEXT) AS mark FROM search_revisions WHERE kind = ?1' });

/** Each named index's mark and each named kind's revision, in one read set; an absent one reads as an empty mark. */
export async function rankingMarks(db: RelationalStore, indexes: readonly RankedIndex[], kinds: readonly RevisionKind[] = []): Promise<string[]> {
  if (indexes.length + kinds.length === 0) return [];
  const rows = await readSet(db, ...indexes.map(index => MARKS[index].bind()), ...kinds.map(kind => REVISION.bind(kind)));
  return rows.map(found => {
    const text = found[0]?.mark ?? '';
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return `${text.length.toString(36)}.${hash.toString(36)}`;
  });
}

/**
 * The groups of a ranked read that follow a match's place in the ranking: rank ascending, then the newest, then the id
 * and the Project ascending. Binds the place's rank twice, its instant twice, its id twice and its Project once.
 */
export function rankedAfterSql(rank: string, created: string, id: string, project: string): string {
  return `HAVING (${rank} > ? OR (${rank} = ? AND (${created} < ? OR (${created} = ? AND (${id} > ? OR (${id} = ? AND ${project} > ?))))))`;
}

/** A match whose session, named by `session` beside the match's own `d.project_id`, records this agent or branch; binds the value once. */
export function sessionFieldSql(session: string, column: 'agent' | 'branch'): string {
  return `EXISTS (SELECT 1 FROM sessions sa WHERE sa.project_id = d.project_id AND sa.session_id = ${session} AND sa.${column} = ?)`;
}
