import { KEYED_PUBLICATION_FACT_TRIGGERS } from './documents/contributions.js';
import { changing, reaching, retiring, type SchemaStep } from './schema-step.js';
import { LAST_S2F, NEXT_S2F } from './schema-vNEXT-s2f.js';

/** The triggers that kept the extraction read model's unread prompts and pending transcripts, which nothing reads. */
const EXTRACTION_READ_MODEL_TRIGGERS = [
  'session_prompts_unread_insert', 'session_prompts_unread_update', 'session_prompts_unread_delete',
  'session_documents_unread_insert', 'session_documents_unread_update', 'session_documents_unread_delete',
  'extraction_acks_session_read_insert', 'extraction_acks_session_read_delete',
  'transcripts_session_read_insert', 'transcripts_session_read_update', 'transcripts_session_read_delete',
] as const;
const EXTRACTION_READ_MODEL_COLUMNS = ['eligible_prompts', 'pending_transcripts', 'live_transcripts'] as const;
const EXTRACTION_READ_MODEL_INDEXES = ['idx_session_read_extraction', 'idx_session_read_unread'] as const;
/** Indexes the retired transcript parser read through its own columns; publication reads `transcript_publication`. */
const PARSER_INDEXES = ['idx_transcripts_backlog', 'idx_transcripts_parser_version', 'idx_transcripts_terminal', 'idx_transcripts_unparsed'] as const;

/**
 * Ingest retirement. The transcript and frontier fact triggers delete a session's facts one key at a time, so a
 * transcript growing or a frontier moving reads the same rows however many sessions the Project holds. The second
 * step drops what no reader reads: the unread prompt and pending transcript counts with their triggers and indexes,
 * the transcript parse indexes, the inert due totals, and the Project-wide prompt instant index, whose readers seek a
 * session's own prompts without it.
 */
export const INGEST_RETIREMENT_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_S2F,
    statements: KEYED_PUBLICATION_FACT_TRIGGERS.flatMap(({ name, sql }) => [`DROP TRIGGER IF EXISTS ${name}`, sql]),
    retires: retiring('trigger', KEYED_PUBLICATION_FACT_TRIGGERS.map(({ name }) => name),
      'Rebuilt to delete a session\'s publication facts one key at a time; the delete through a union of keys read every fact on D1.'),
    reaches: reaching(['transcripts', 'transcript_publication'],
      'A transcript or frontier write moves its contributions and its sessions\' publication facts in the same commit.'),
  },
  {
    version: LAST_S2F,
    statements: [
      ...EXTRACTION_READ_MODEL_TRIGGERS.map((name) => `DROP TRIGGER IF EXISTS ${name}`),
      ...[...EXTRACTION_READ_MODEL_INDEXES, ...PARSER_INDEXES, 'idx_session_prompts_created'].map((name) => `DROP INDEX IF EXISTS ${name}`),
      ...EXTRACTION_READ_MODEL_COLUMNS.map((column) => `ALTER TABLE session_read_facts DROP COLUMN ${column}`),
      'DROP TABLE IF EXISTS document_due_totals',
    ],
    retires: [
      ...retiring('trigger', EXTRACTION_READ_MODEL_TRIGGERS, 'They kept the extraction read model\'s unread prompts and pending transcripts, which no reader reads since card learning replaced the extraction queue.'),
      ...retiring('index', EXTRACTION_READ_MODEL_INDEXES, 'The extraction candidate orders over unread prompts and pending transcripts; no statement reads through them.'),
      ...retiring('column', EXTRACTION_READ_MODEL_COLUMNS.map((column) => `session_read_facts.${column}`), 'Written only by the retired triggers and a restore recount; no reader.'),
      ...retiring('index', PARSER_INDEXES, 'The retired parser\'s backlog, version sweep, terminal and unparsed orders over its own transcript columns; publication reads transcript_publication, and no statement reads through them.'),
      ...retiring('index', ['idx_session_prompts_created'], 'Its only readers sought one session\'s first prompt by walking the Project\'s prompts in time order; without it they seek the session\'s own prompts.'),
      ...retiring('table', ['document_due_totals'], 'Inert since the bounded due queue replaced its writers; nothing reads it and backups never carried it.'),
    ],
    reaches: changing(['session_read_facts'], 'The extraction read model\'s columns go once nothing reads or writes them.'),
  },
];
