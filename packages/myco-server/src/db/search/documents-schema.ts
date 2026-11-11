import { changed, jsonKeys, trigger } from '../ddl.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { write } from '../index.js';
import { PAST_PLAN_STATUSES } from '../plans/resolution.js';
import type { CatchupFamily } from '../projections/family.js';

/**
 * The search projection: one `search_documents` row per searchable record, holding the words it is found by, and one
 * full-text index over those rows, which a recovery can rebuild from them. Each record's row and words are re-derived from the record whenever a trigger or a catch-up page names its key,
 * by the same statements, so a page and a live write agree and a page cannot write a stale row.
 *
 * A document's `doc_id` is its full-text rowid and orders it by the record's own instant: the record's second times
 * 2^20, plus the next free number in that second. That stays below 2^53, the largest integer a reader holds exactly,
 * until the year 2242. Within one second the numbers follow the order documents were indexed in, so a ranking breaks
 * ties by the record's own instant and identity, not by `doc_id`. A search reads its newest matches by walking rowids
 * downward, so the newest records are found first whatever order they were indexed in.
 */
export const SEARCH_DOCUMENTS_PROJECTION = 'search_documents';

/** The numbers one second of `doc_id` holds. */
export const DOC_IDS_PER_SECOND = 1_048_576;

/** A full-text token naming one value of a filter: the prefix, then the value's UTF-8 bytes in lowercase hex. */
const facet = (prefix: string, value: string) => `'${prefix}' || lower(hex(${value}))`;

interface SourceKind {
  kind: 'session' | 'plan' | 'spore' | 'card';
  table: string;
  /** The source's key columns, in the order a key page carries them. */
  keys: readonly string[];
  /** The document's `source_key`, from the source row aliased `s`. */
  sourceKey: string;
  /** Which rows are searchable. */
  where: string;
  /** The record's ordering instant. */
  recordAt: string;
  facets: string;
  headline: string;
  body: string;
  /** The columns whose change re-derives the document. */
  watched: readonly string[];
}

const SESSION_AT = 'COALESCE(s.occurred_started_at, s.started_at, s.first_received_at)';
const sessionFacet = `CASE WHEN s.session_id IS NULL THEN '' ELSE ' ' || ${facet('s', 's.session_id')} END`;

const SOURCE_KINDS: Readonly<Record<SourceKind['kind'], SourceKind>> = {
  session: {
    kind: 'session', table: 'sessions', keys: ['project_id', 'session_id'], sourceKey: 's.session_id',
    where: '(s.title IS NOT NULL OR s.summary IS NOT NULL)', recordAt: SESSION_AT,
    facets: `${facet('p', 's.project_id')} || ' ksession ' || ${facet('s', 's.session_id')}`,
    headline: 's.title', body: 's.summary',
    watched: ['project_id', 'session_id', 'title', 'summary', 'occurred_started_at', 'started_at', 'first_received_at'],
  },
  plan: {
    kind: 'plan', table: 'plans', keys: ['project_id', 'plan_key'], sourceKey: 's.plan_key', where: '1', recordAt: 's.created_at',
    facets: `${facet('p', 's.project_id')} || ' kplan ' || ${facet('st', 's.status')} || ${sessionFacet}`,
    headline: 's.title', body: 's.content',
    watched: ['project_id', 'plan_key', 'title', 'content', 'status', 'created_at', 'session_id'],
  },
  spore: {
    kind: 'spore', table: 'spores', keys: ['project_id', 'id'], sourceKey: 's.id', where: '1', recordAt: 's.created_at',
    facets: `${facet('p', 's.project_id')} || ' kspore ' || ${facet('st', 's.status')} || ' ' || ${facet('ty', 's.observation_type')} || ${sessionFacet}`,
    headline: `COALESCE(s.agent_line, '') || ' ' || s.observation_type`, body: `s.content || ' ' || COALESCE(s.tags, '')`,
    watched: ['project_id', 'id', 'content', 'tags', 'agent_line', 'observation_type', 'status', 'created_at', 'session_id'],
  },
  card: {
    kind: 'card', table: 'turn_cards', keys: ['project_id', 'session_id', 'turn_key'], sourceKey: 'json_array(s.session_id, s.turn_key)',
    where: 's.card IS NOT NULL', recordAt: 's.created_at',
    facets: `${facet('p', 's.project_id')} || ' kcard ' || ${facet('s', 's.session_id')}`,
    headline: 's.headline', body: 's.card',
    watched: ['project_id', 'session_id', 'turn_key', 'card', 'headline', 'created_at'],
  },
};

/** A past plan's resolution note is part of the words it is found by. */
const PAST = PAST_PLAN_STATUSES.map((status) => `'${status}'`).join(',');

/**
 * A plan's document as plan curation keeps it: a past plan is also found by its resolution note, so a search for what was
 * decided reaches the closed plan that records it. A plan with no note, or one that is live again, has the words the
 * first plan kind gave it, so introducing this kind changes no existing document.
 */
const RESOLVED_PLAN_KIND: SourceKind = {
  ...SOURCE_KINDS.plan,
  body: `CASE WHEN s.resolution_note IS NULL OR s.status NOT IN (${PAST}) THEN s.content ELSE COALESCE(s.content, '') || ' ' || s.resolution_note END`,
  watched: [...SOURCE_KINDS.plan.watched, 'resolution_note'],
};

/**
 * The next free `doc_id` in the second of the record instant `ms`, plus `offset` for the rows one statement allocates
 * together. The instant is cast first: a bound number can arrive as a real, and a real's division would not land on a
 * whole second.
 */
export const allocateDocId = (ms: string, offset: string): string => {
  const second = `(CAST(${ms} AS INTEGER) / 1000)`;
  return `COALESCE((SELECT MAX(x.doc_id) + 1 FROM search_documents x WHERE x.doc_id >= ${second} * ${DOC_IDS_PER_SECOND} AND x.doc_id < (${second} + 1) * ${DOC_IDS_PER_SECOND}), ${second} * ${DOC_IDS_PER_SECOND}) + ${offset}`;
};

/**
 * Re-derive the documents of the source keys `keys` (a row source with the kind's key columns): a document whose record
 * is gone, no longer searchable, or moved in time or session leaves; a remaining document takes the record's current
 * words when they differ; a searchable record without a document gets one. The full-text index follows the documents
 * through their own triggers.
 */
function reconcileDocuments(kind: SourceKind, keys: string): string[] {
  const k = `(${keys}) k`;
  const sourceOn = kind.keys.map((column) => `s.${column} = k.${column}`).join(' AND ');
  const keyed = kind.kind === 'card' ? 'json_array(k.session_id, k.turn_key)' : `k.${kind.keys[1]}`;
  const keyedDocs = `SELECT d.doc_id FROM ${k} CROSS JOIN search_documents d ON d.project_id = k.project_id AND d.kind = '${kind.kind}' AND d.source_key = ${keyed}`;
  const currentDocs = `SELECT d.doc_id FROM ${k} CROSS JOIN ${kind.table} s ON ${sourceOn}
      CROSS JOIN search_documents d ON d.project_id = s.project_id AND d.kind = '${kind.kind}' AND d.source_key = ${kind.sourceKey}
      WHERE ${kind.where} AND CAST(MAX(${kind.recordAt}, 0) AS INTEGER) = d.record_at AND s.session_id IS d.session_id`;
  const sourceOfDocument = kind.kind === 'card'
    ? `s.project_id = search_documents.project_id AND s.session_id = search_documents.session_id AND s.turn_key = json_extract(search_documents.source_key, '$[1]')`
    : `s.project_id = search_documents.project_id AND s.${kind.keys[1]} = search_documents.source_key`;
  const words = `SELECT ${kind.facets}, ${kind.headline}, ${kind.body} FROM ${kind.table} s WHERE ${sourceOfDocument}`;
  return [
    `DELETE FROM search_documents WHERE doc_id IN (${keyedDocs}) AND doc_id NOT IN (${currentDocs})`,
    `UPDATE search_documents SET (facets, headline, body) = (${words}) WHERE doc_id IN (${keyedDocs}) AND (facets, headline, body) IS NOT (${words})`,
    `INSERT INTO search_documents(doc_id, project_id, kind, source_key, session_id, record_at, facets, headline, body)
      SELECT ${allocateDocId('c.ms', 'ROW_NUMBER() OVER (PARTITION BY c.ms / 1000 ORDER BY c.source_key) - 1')}, c.project_id, '${kind.kind}', c.source_key, c.session_id, c.ms,
        c.facets, c.headline, c.body
      FROM (SELECT s.project_id, ${kind.sourceKey} AS source_key, s.session_id, CAST(MAX(${kind.recordAt}, 0) AS INTEGER) AS ms,
          ${kind.facets} AS facets, ${kind.headline} AS headline, ${kind.body} AS body
        FROM ${k} CROSS JOIN ${kind.table} s ON ${sourceOn}
        WHERE ${kind.where} AND NOT EXISTS (SELECT 1 FROM search_documents d WHERE d.project_id = s.project_id AND d.kind = '${kind.kind}' AND d.source_key = ${kind.sourceKey})) c
      WHERE 1`,
  ].map((sql) => sql.replace(/\s+/g, ' '));
}

const rowKeys = (kind: SourceKind, row: 'NEW' | 'OLD') => `SELECT ${kind.keys.map((column) => `${row}.${column} AS ${column}`).join(', ')}`;

/** Whether the row `row` is searchable: a row that is not holds no document, so a write to it has none to re-derive. */
const searchable = (kind: SourceKind, row: 'NEW' | 'OLD') => (kind.where === '1' ? null : kind.where.replace(/\bs\./g, `${row}.`));

function documentTriggers(kind: SourceKind): string[] {
  const name = `search_documents_${kind.kind}`;
  const both = `${rowKeys(kind, 'OLD')} UNION ${rowKeys(kind, 'NEW')}`;
  const before = searchable(kind, 'OLD');
  const after = searchable(kind, 'NEW');
  return [
    trigger(`${name}_insert`, kind.table, 'INSERT', reconcileDocuments(kind, rowKeys(kind, 'NEW')), after).sql,
    trigger(`${name}_update`, kind.table, `UPDATE OF ${kind.watched.join(', ')}`, reconcileDocuments(kind, both),
      before === null ? changed(kind.watched) : `(${changed(kind.watched)}) AND (${before} OR ${after})`).sql,
    trigger(`${name}_delete`, kind.table, 'DELETE', reconcileDocuments(kind, rowKeys(kind, 'OLD')), before).sql,
  ];
}

/**
 * The catch-up phase of each source kind. Each walks every source row in key order, so a page reads a page of keys
 * however sparse the searchable rows are; the reconcile skips a row that holds no document.
 */
const PHASES = {
  searchSessions: SOURCE_KINDS.session,
  searchPlans: RESOLVED_PLAN_KIND,
  searchSpores: SOURCE_KINDS.spore,
  searchCards: SOURCE_KINDS.card,
} as const;

export const SEARCH_DOCUMENT_PHASES = Object.fromEntries(Object.entries(PHASES).map(([phase, kind]) => [phase, {
  source: { table: kind.table, columns: kind.keys, unique: true },
  reconcile: reconcileDocuments(kind, jsonKeys(kind.keys)).map((sql, i) => write<[string]>({ name: `searchDocuments.${phase}Page${i}`, sql })),
}])) as unknown as Record<keyof typeof PHASES, CatchupFamily['phases'][string]>;

/** The projection's tables, index and triggers, and the catch-up seed, as one schema step freezes them. */
export function searchDocumentStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS search_documents(doc_id INTEGER PRIMARY KEY, project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
      kind TEXT NOT NULL CHECK (kind IN ('session','plan','spore','card','chunk')), source_key TEXT NOT NULL, session_id TEXT, blob_key TEXT,
      record_at INTEGER NOT NULL, facets TEXT NOT NULL, headline TEXT, body TEXT)`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_search_documents_source ON search_documents(project_id, kind, source_key)',
    'CREATE INDEX IF NOT EXISTS idx_search_documents_blob ON search_documents(project_id, blob_key) WHERE blob_key IS NOT NULL',
    `CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(facets, headline, body, content='search_documents', content_rowid='doc_id')`,
    trigger('search_documents_fts_insert', 'search_documents', 'INSERT',
      'INSERT INTO search_documents_fts(rowid, facets, headline, body) VALUES (NEW.doc_id, NEW.facets, NEW.headline, NEW.body)').sql,
    trigger('search_documents_fts_delete', 'search_documents', 'DELETE',
      `INSERT INTO search_documents_fts(search_documents_fts, rowid, facets, headline, body) VALUES ('delete', OLD.doc_id, OLD.facets, OLD.headline, OLD.body)`).sql,
    trigger('search_documents_fts_update', 'search_documents', 'UPDATE OF facets, headline, body', [
      `INSERT INTO search_documents_fts(search_documents_fts, rowid, facets, headline, body) VALUES ('delete', OLD.doc_id, OLD.facets, OLD.headline, OLD.body)`,
      'INSERT INTO search_documents_fts(rowid, facets, headline, body) VALUES (NEW.doc_id, NEW.facets, NEW.headline, NEW.body)',
    ]).sql,
    ...Object.values(SOURCE_KINDS).flatMap(documentTriggers),
    ...Object.entries(PHASES).map(([phase, kind]) =>
      `INSERT INTO projection_catchup(projection, phase, done) SELECT '${SEARCH_DOCUMENTS_PROJECTION}', '${phase}', NOT EXISTS (SELECT 1 FROM ${kind.table})`),
  ];
}

/** The plan kind's triggers rebuilt so a past plan's document carries its resolution note. No existing document changes. */
export function resolvedPlanDocumentStatements(): string[] {
  return [
    ...['insert', 'update', 'delete'].map((event) => `DROP TRIGGER IF EXISTS search_documents_plan_${event}`),
    ...documentTriggers(RESOLVED_PLAN_KIND),
  ];
}
