import { retiring, type SchemaStep } from './schema-step.js';
import { LAST_S5C2, NEXT_S5C2 } from './schema-vNEXT-s5c2.js';

/** The per-kind word indexes unified search replaced; each kept itself current with three triggers on its record table. */
const RECORD_INDEXES = ['sessions_fts', 'spores_fts', 'plans_fts', 'turn_cards_fts'] as const;
const RECORD_INDEX_TRIGGERS = RECORD_INDEXES.flatMap((table) => ['ai', 'ad', 'au'].map((operation) => `${table}_${operation}`));

/** The retired plan-body indexer: its queue, the chunks it read bodies into, their word index and vocabulary. */
const CHUNK_INDEX_TRIGGERS = ['search_blob_chunks_fts_ai', 'search_blob_chunks_fts_ad', 'search_blob_chunks_fts_au'] as const;
const CHUNK_QUEUE_TRIGGERS = ['plans_search_blob_ai', 'plans_search_blob_au', 'blobs_search_ad'] as const;
const VOCABULARY_TABLES = ['plans_search_terms', 'blob_search_terms'] as const;

/** One trigger per search dependency and writer that moved `search_revisions`, which the ranked pages read before unified search. */
const REVISION_TRIGGERS = [
  'search_revision_plan_plans_update', 'search_revision_plan_search_blob_chunks_update',
  ...['insert', 'update', 'delete'].flatMap((operation) => [
    `search_revision_plan_processed_resources_${operation}`, `search_revision_projects_projects_${operation}`,
    `search_revision_release_knowledge_release_state_${operation}`, `search_revision_session_sessions_${operation}`,
    ...['plan', 'session', 'turn'].map((kind) => `search_revision_${kind}_session_tombstones_${operation}`),
  ]),
  'search_revision_spore_spores_update', 'search_revision_turn_turn_cards_update',
];

/** Every search structure unified search left unread, by name: the backup lists skip them in an older artifact. */
export const RETIRED_SEARCH_TABLES: readonly string[] = [...RECORD_INDEXES, 'search_blob_chunks_fts', 'search_blob_chunks', 'search_blob_queue', ...VOCABULARY_TABLES, 'search_revisions'];

/**
 * Unified search reads one index; these steps drop the structures it replaced. The triggers go first, so session, spore,
 * plan and card writes stop maintaining them at once, with the vocabularies over the indexes, the revision counters and
 * the indexer's partial plan index. The word indexes drop in the next step, and the indexer's chunks, the largest of
 * these tables, then its queue in the last, child ahead of parent. Each step is one transaction.
 */
export const SEARCH_RETIREMENT_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_S5C2,
    statements: [
      ...[...RECORD_INDEX_TRIGGERS, ...CHUNK_INDEX_TRIGGERS, ...CHUNK_QUEUE_TRIGGERS, ...REVISION_TRIGGERS].map((name) => `DROP TRIGGER IF EXISTS ${name}`),
      ...VOCABULARY_TABLES.map((name) => `DROP TABLE IF EXISTS ${name}`),
      'DROP TABLE IF EXISTS search_revisions',
      'DROP INDEX IF EXISTS idx_plans_search_blob',
    ],
    retires: [
      ...retiring('trigger', RECORD_INDEX_TRIGGERS, 'They kept the per-kind word indexes current; unified search reads search_documents, and nothing reads those indexes.'),
      ...retiring('trigger', CHUNK_INDEX_TRIGGERS, 'They kept the retired plan-body chunks\' word index current; plan bodies are indexed into search_documents.'),
      ...retiring('trigger', CHUNK_QUEUE_TRIGGERS, 'They queued plan bodies for the retired chunk indexer; search_blob_refs and search_blobs track plan bodies now.'),
      ...retiring('trigger', REVISION_TRIGGERS, 'They moved search_revisions, which only the ranked pages unified search replaced read.'),
      ...retiring('table', VOCABULARY_TABLES, 'Term vocabularies over the retired word indexes; nothing reads them.'),
      ...retiring('table', ['search_revisions'], 'One revision per search dependency for the ranked pages unified search replaced; nothing reads it, and backups never carried it.'),
      ...retiring('index', ['idx_plans_search_blob'], 'The retired chunk indexer\'s partial order over plan bodies; idx_plans_blob_key holds the same keys for every other reader.'),
    ],
  },
  {
    version: NEXT_S5C2 + 1,
    statements: [...RECORD_INDEXES, 'search_blob_chunks_fts'].map((name) => `DROP TABLE IF EXISTS ${name}`),
    retires: retiring('table', [...RECORD_INDEXES, 'search_blob_chunks_fts'], 'Word indexes no reader reads since unified search moved every caller onto search_documents; backups never carried them.'),
  },
  {
    version: LAST_S5C2,
    statements: ['DROP TABLE IF EXISTS search_blob_chunks', 'DROP INDEX IF EXISTS idx_search_blob_pending', 'DROP TABLE IF EXISTS search_blob_queue'],
    retires: [
      ...retiring('table', ['search_blob_chunks', 'search_blob_queue'], 'The retired plan-body indexer\'s chunks and queue; nothing writes or reads them since search_blobs replaced them, and backups never carried them.'),
      ...retiring('index', ['idx_search_blob_pending'], 'The retired indexer\'s order over its own queue.'),
    ],
  },
];
