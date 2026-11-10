import { BLOB_REFERENCES, blobReferenceColumn, kindFilter } from '../../core/blob-references.js';
import { BLOB_RESERVATION_TTL_MS } from '../../constants.js';
import { DOCUMENT_SESSION_TABLES } from '../document-tables.js';
import { jsonKeys } from '../ddl.js';
import { read, write, type Bound, type Statement } from '../index.js';

/** The tables a session's derived rows live in, each carrying `session_id` itself. */
export const DERIVED_TABLES = [
  'learning_sessions', 'event_refs',
  ...DOCUMENT_SESSION_TABLES,
  'archive_bundles', 'raw_archive_refs', 'registered_content_proofs', 'storage_cleanup_queue', 'content_scan_checkpoints',
  'transcripts', 'attachments', 'plans', 'spore_injections', 'prompt_context_answers', 'session_injections', 'prompt_identity_conflicts',
  'extraction_acks', 'turn_cards', 'session_artifacts', 'events',
] as const;

/** Rows one deletion page removes from one table. */
export const DELETION_PAGE = 128;

/** Candidate that a deletion page records from the rows it is about to remove: the keys the decision then judges. */
export interface RecordedCandidate { project_id: string; key: string }

type KeyRow = Record<string, string | number>;

interface PhaseSpec {
  /** The primary key, in order: what a page binds and a delete matches. */
  readonly key: readonly string[];
  /** Which rows of the table belong to this session, against alias `r`; `?2` is the session. */
  readonly owner?: string;
  /** Written in the page's commit before its delete, for what is reached only through the rows it removes; `?1` is the page's keys. */
  readonly before?: (name: string) => Statement<[keys: string], never, 'write'>;
  /** The column holding the generation a row's reference names, when it holds one. */
  readonly generation?: string;
}

const SESSION_OWNED = 'r.session_id=?2';
const JSON_COLUMN = (position: number) => `json_extract(value,'$[${position}]')`;
const tags = (name: string) => write<[keys: string]>({ name, sql: `DELETE FROM tags WHERE (project_id,entity_kind,entity_id) IN
  (SELECT ${JSON_COLUMN(0)},'plan',${JSON_COLUMN(1)} FROM json_each(?1))` });
/** A spore outlives its session and stops naming a prompt the deletion removes; `position` is the prompt's place in the key. */
const promptsLeaveSpores = (position: number) => (name: string) => write<[keys: string]>({ name, sql:
  `UPDATE spores SET prompt_id=NULL WHERE (project_id,prompt_id) IN (SELECT ${JSON_COLUMN(0)},${JSON_COLUMN(position)} FROM json_each(?1))` });
const eventRefPromptsLeaveSpores = (name: string) => write<[keys: string]>({ name, sql:
  `UPDATE spores SET prompt_id=NULL WHERE (project_id,prompt_id) IN (SELECT e.project_id,e.record_id FROM event_refs e
    WHERE (e.project_id,e.event_id) IN (SELECT ${JSON_COLUMN(0)},${JSON_COLUMN(1)} FROM json_each(?1)) AND e.kind='prompt' AND e.record_id IS NOT NULL)` });
const servedItems = (name: string) => write<[keys: string]>({ name, sql: `DELETE FROM injection_served_items
  WHERE (project_id,receipt_id) IN (SELECT ${JSON_COLUMN(0)},${JSON_COLUMN(2)} FROM json_each(?1))` });
const eventOmissions = (name: string) => write<[keys: string]>({ name, sql: `DELETE FROM storage_cleanup_omissions
  WHERE (project_id,resource_kind,resource_id) IN (SELECT ${JSON_COLUMN(0)},'event',${JSON_COLUMN(1)} FROM json_each(?1))` });

/** Rows of a session's tables, in deletion order: what project-wide reads can still show goes first. */
const SPECS: ReadonlyArray<readonly [table: string, spec: PhaseSpec]> = [
  ['plans', { key: ['project_id', 'plan_key'], before: tags }],
  ['turn_cards', { key: ['project_id', 'session_id', 'turn_key'] }],
  ['attachments', { key: ['project_id', 'attachment_id'] }],
  ['session_artifacts', { key: ['project_id', 'id'] }],
  ['spore_injections', { key: ['project_id', 'session_id', 'id'], before: servedItems }],
  ['prompt_context_answers', { key: ['project_id', 'session_id', 'id'] }],
  ['session_injections', { key: ['project_id', 'session_id', 'kind'] }],
  ['prompt_identity_conflicts', { key: ['project_id', 'session_id', 'prompt_id', 'source_key', 'source_thread', 'source_record'] }],
  ['extraction_acks', { key: ['project_id', 'ack_id'] }],
  ['run_reads', { key: ['project_id', 'run_id', 'session_id'] }],
  ['run_served_material', { key: ['project_id', 'served_id'] }],
  ['learning_sessions', { key: ['project_id', 'session_id'] }],
  ['session_title_work', { key: ['project_id', 'session_id', 'mode'] }],
  ['release_work_due', { key: ['project_id', 'session_id'] }],
  ['release_propagation_due', { key: ['project_id', 'session_id'] }],
  ['session_documents', { key: ['project_id', 'session_id'] }],
  ['session_prompts', { key: ['project_id', 'session_id', 'generation', 'prompt_id'], before: promptsLeaveSpores(3) }],
  ['session_chunks', { key: ['project_id', 'session_id', 'generation', 'chunk_no'] }],
  ['retired_objects', { key: ['project_id', 'session_id', 'blob_key', 'source_id'] }],
  ['session_pages', { key: ['project_id', 'session_id', 'generation', 'owner', 'page'] }],
  ['session_sealed_records', { key: ['project_id', 'session_id', 'generation', 'owner', 'k', 'record_id'] }],
  ['transcript_publication', { key: ['project_id', 'transcript_id', 'generation'] }],
  ['publish_queue', { key: ['project_id', 'session_id', 'rank', 'created_at', 'event_id'] }],
  ['session_paths', { key: ['project_id', 'session_id', 'generation', 'path'] }],
  ['session_edit_paths', { key: ['project_id', 'session_id', 'generation', 'path'] }],
  ['session_turn_entries', { key: ['project_id', 'session_id', 'generation', 'owner', 'kind', 'name'] }],
  ['session_turn_totals', { key: ['project_id', 'session_id', 'generation', 'owner'] }],
  ['session_path_build', { key: ['project_id', 'session_id', 'generation', 'path'] }],
  ['myco_tool_calls', { key: ['project_id', 'session_id', 'generation', 'tool_call_id'] }],
  ['document_owners', { key: ['project_id', 'session_id', 'generation', 'source_key'] }],
  ['document_continuations', { key: ['project_id', 'session_id', 'generation', 'transcript_id'] }],
  ['document_plan_keys', { key: ['project_id', 'session_id', 'generation', 'plan_key'] }],
  ['document_metadata_ready', { key: ['project_id', 'session_id', 'generation'] }],
  ['document_metadata_progress', { key: ['project_id', 'session_id', 'generation', 'chunk_no'] }],
  ['document_group_pins', { key: ['project_id', 'session_id', 'agent'] }],
  ['document_failure_contributions', { key: ['project_id', 'transcript_id', 'generation'] }],
  ['document_rebuild_receipts', { key: ['project_id', 'session_id', 'version'] }],
  ['publication_dependencies', { key: ['project_id', 'child_event_id', 'prerequisite_kind', 'prerequisite_id'] }],
  ['session_lifecycle_facts', { key: ['project_id', 'session_id'] }],
  ['session_user_prompt_firsts', { key: ['project_id', 'session_id', 'identity'] }],
  ['document_locator_repair', { key: ['project_id', 'session_id'] }],
  ['archive_bundles', { key: ['id'] }],
  ['raw_archive_refs', { key: ['project_id', 'source_kind', 'source_id'] }],
  ['registered_content_proofs', { key: ['project_id', 'source_kind', 'source_id', 'key'], generation: 'generation' }],
  ['storage_cleanup_queue', { key: ['project_id', 'resource_kind', 'resource_id'] }],
  ['content_scan_checkpoints', { key: ['project_id', 'source_kind', 'resource_id'] }],
  // A segment belongs to a session through its transcript, and `transcripts` is the only route to it.
  ['transcript_segments', { key: ['project_id', 'transcript_id', 'base_offset'],
    owner: 'EXISTS(SELECT 1 FROM transcripts t WHERE t.project_id=r.project_id AND t.transcript_id=r.transcript_id AND t.session_id=?2)' }],
  ['transcripts', { key: ['project_id', 'transcript_id'] }],
  ['document_transcript_pins', { key: ['project_id', 'transcript_id'] }],
  ['event_refs', { key: ['project_id', 'event_id'], before: eventRefPromptsLeaveSpores }],
  ['events', { key: ['project_id', 'event_id'], before: eventOmissions }],
  // Statistics and placements are re-derived by triggers on the rows above, so they follow them.
  ['session_statistics', { key: ['project_id', 'session_id'] }],
  ['session_attachment_counts', { key: ['project_id', 'session_id'] }],
  ['context_placements', { key: ['project_id', 'session_id', 'kind', 'record_id'] }],
  // Pin totals follow the pins their triggers maintain, so the totals are the last of the session's derived rows.
  ['document_pin_totals', { key: ['project_id', 'session_id', 'role', 'prompt_identity_scheme'] }],
];

/** The tables a phase covers and the session routes that reach them. */
export interface DeletionPhase {
  readonly name: string;
  readonly table: string;
  readonly page: Statement<[project: string, session: string, limit: number], KeyRow, 'read'>;
  statements(keys: string, session: string, cutoff: number, now: number): { before: Bound[]; recorded: Array<Bound<RecordedCandidate>>; removed: Bound<{ removed: number }> };
}

const CUTOFF_DELAY = BLOB_RESERVATION_TTL_MS;

function phase([table, spec]: readonly [string, PhaseSpec], index: number): DeletionPhase {
  const owner = spec.owner ?? SESSION_OWNED;
  const name = `deletion.${table.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}`;
  const keys = spec.key.join(',');
  const selection = `(${spec.key.map(column => `r.${column}`).join(',')}) IN (${jsonKeys(spec.key)})`;
  const references = BLOB_REFERENCES.filter(ref => ref.table === table);
  const recorded = references.map((ref, position) => {
    const column = blobReferenceColumn(ref, 'r');
    const generation = spec.generation === undefined ? '' : ` AND b.generation IS r.${spec.generation}`;
    // A blob still inside the upload grace may be a member's upload whose event has not arrived: its candidate waits out the grace as `*`.
    return write<[keys: string, session: string, cutoff: number, now: number], RecordedCandidate>({ name: `${name}Candidates${position}`, sql:
      `INSERT INTO blob_release_candidates(project_id,key,created_at,generation)
        SELECT b.project_id,b.key,CASE WHEN b.received_at<=?3 THEN ?4 ELSE b.received_at+(?4-?3) END,CASE WHEN b.received_at<=?3 THEN b.generation ELSE '*' END
        FROM ${table} r JOIN blobs b ON b.project_id=r.project_id AND b.key=${column}${generation}
        WHERE ${selection} AND ${owner} AND ${column} IS NOT NULL${kindFilter(ref).replace(' kind ', ' r.kind ')}
        ON CONFLICT(project_id,key) DO UPDATE SET generation=excluded.generation
        RETURNING project_id,key` });
  });
  const removal = write<[keys: string, session: string], { removed: number }>({ name: `${name}Remove`, sql:
    `DELETE FROM ${table} AS r WHERE ${selection} AND ${owner} RETURNING 1 AS removed` });
  const before = spec.before?.(`${name}Before`);
  const page = read<[project: string, session: string, limit: number], KeyRow>({ name: `${name}Page${index}`, sql:
    table === 'transcript_segments'
      ? `SELECT r.${spec.key.join(',r.')} FROM transcripts t CROSS JOIN transcript_segments r ON r.project_id=t.project_id AND r.transcript_id=t.transcript_id
          WHERE t.project_id=?1 AND t.session_id=?2 LIMIT ?3`
      : `SELECT ${keys} FROM ${table} WHERE project_id=?1 AND session_id=?2 LIMIT ?3` });
  return {
    name: table, table, page,
    statements: (keys, session, cutoff, now) => ({
      before: before === undefined ? [] : [before.bind(keys)],
      recorded: recorded.map(statement => statement.bind(keys, session, cutoff, now)),
      removed: removal.bind(keys, session),
    }),
  };
}

export const DELETION_PHASES: readonly DeletionPhase[] = SPECS.map(phase);

/** Reference tables owned by a run: a session deletion leaves them, and run retirement releases them. */
const RUN_OWNED_REFERENCE_TABLES = new Set(['run_bodies']);

const covered = new Set(SPECS.map(([table]) => table));
for (const table of DERIVED_TABLES) if (!covered.has(table)) throw new Error(`no deletion phase reaches ${table}`);
/** A catalogue table a deletion cannot reach would record no candidates and say nothing, so it stops the load. */
export function assertBlobReferencesRouted(references: readonly { table: string }[]): void {
  for (const { table } of references) if (!covered.has(table) && !RUN_OWNED_REFERENCE_TABLES.has(table)) throw new Error(`no route from a session to blob references in ${table}`);
}
assertBlobReferencesRouted(BLOB_REFERENCES);

/** The first page of the plans phase runs in acceptance's own commit; plan reads carry the tombstone for any plans past it. */
export const PLANS_PHASE: DeletionPhase = DELETION_PHASES[0]!;

/** A statement body for every table a verified completion checks: one row is enough to say the phases did not finish. */
export const REMAINING_TABLES: readonly string[] = SPECS.map(([table]) => table);

/** One SELECT term per table: the phases' keys, so verification and the pages read the same rows. */
export const remainingTerm = (table: string, project: string, session: string): string => table === 'transcript_segments'
  ? `EXISTS(SELECT 1 FROM transcripts t JOIN transcript_segments s ON s.project_id=t.project_id AND s.transcript_id=t.transcript_id WHERE t.project_id=${project} AND t.session_id=${session} LIMIT 1)`
  : `EXISTS(SELECT 1 FROM ${table} WHERE project_id=${project} AND session_id=${session} LIMIT 1)`;

export const RESERVATION_CUTOFF = (now: number): number => now - CUTOFF_DELAY;
