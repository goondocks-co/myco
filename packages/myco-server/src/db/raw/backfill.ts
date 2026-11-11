/**
 * The raw provenance backfill: one checkpoint row walks every raw source and processed field in key order, and each
 * page attributes its rows and moves the checkpoint in one batch that holds only while the checkpoint is unmoved.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { LIVE_PROCESSED_FIELDS, processedReferenceSql } from '../processed-resources.js';
import { commit, first, read, rows, write, type Bound, type Statement } from '../index.js';
import { rawCredentialOwner, rawCredentialProvenance, rawTranscriptClaimMember, rawTranscriptOwner, rawTranscriptProvenance } from './provenance.js';

const RAW_SOURCES = [
  { table: 'blobs', id: 'key', kind: 'blob' },
  { table: 'transcripts', id: 'transcript_id', kind: 'transcript' },
  { table: 'events', id: 'event_id', kind: 'event' },
] as const;
type Source = (typeof RAW_SOURCES)[number] | { table: string; id: string; blob: string; kind: string };
const SOURCES: readonly Source[] = [...RAW_SOURCES, ...Object.entries(LIVE_PROCESSED_FIELDS).map(([kind, field]) => ({ ...field, kind }))];

/** How many sources the walk covers; the checkpoint's `source` past the last one means the walk is complete. */
export const RAW_BACKFILL_SOURCES = SOURCES.length;

interface BackfillState { source: number; cursor_project: string; cursor_id: string; complete: number }
const state = read<[], BackfillState>({ name: 'raw.backfillState', sql:
  'SELECT source, cursor_project, cursor_id, complete FROM raw_provenance_backfill WHERE id = 1' });
const pending = read<[], { complete: number }>({ name: 'raw.backfillComplete', sql: 'SELECT complete FROM raw_provenance_backfill WHERE id = 1' });

/** The checkpoint still stands at the page's own position: slots 2 to 4 are its source and cursor. */
const HELD = 'EXISTS (SELECT 1 FROM raw_provenance_backfill WHERE id = 1 AND source = ?2 AND cursor_project = ?3 AND cursor_id = ?4 AND complete = 0)';

type PageGuard = [selected: string, source: number, cursorProject: string, cursorId: string];
interface SourceStatements {
  readonly page: Statement<[cursorProject: string, cursorId: string, limit: number], { project_id: string; resource_id: string }, 'read'>;
  readonly attribute: Statement<PageGuard, { inserted: number }, 'write'>;
  readonly follow: readonly Statement<PageGuard, never, 'write'>[];
}

const capitalized = (kind: string) => `${kind[0]!.toUpperCase()}${kind.slice(1)}`;

function sourceStatements(source: Source): SourceStatements {
  const name = capitalized(source.kind);
  const page = `(SELECT s.* FROM ${source.table} s JOIN json_each(?1) selected
    ON s.project_id = json_extract(selected.value, '$.project_id') AND s.${source.id} = json_extract(selected.value, '$.resource_id'))`;
  let insert: string;
  if (source.kind === 'event') {
    insert = `INSERT INTO raw_credentials (token_id, owner_member_id, provenance)
      SELECT DISTINCT s.token_id, ${rawCredentialOwner('s.token_id')}, ${rawCredentialProvenance('s.token_id')}
        FROM ${page} s WHERE ${HELD} ON CONFLICT DO NOTHING`;
  } else if (source.kind === 'blob' || source.kind === 'transcript') {
    const blob = source.kind === 'blob';
    insert = `INSERT INTO raw_resources (project_id,kind,resource_id,reference_id,owner_member_id,machine_id,token_id,provenance,revision,claim_member_id)
      SELECT s.project_id, '${source.kind}', s.${source.id}, ${blob ? 's.token_id' : "''"},
        ${blob ? rawCredentialOwner('s.token_id') : rawTranscriptOwner('s')},
        ${blob ? '(SELECT machine_id FROM member_credentials WHERE id = s.token_id)' : 's.machine_id'}, s.token_id,
        ${blob ? rawCredentialProvenance('s.token_id') : rawTranscriptProvenance('s')}, (SELECT revision + 1 FROM raw_provenance_state WHERE id = 1), ${blob ? 'NULL' : rawTranscriptClaimMember('s')}
        FROM ${page} s WHERE ${HELD} ON CONFLICT DO NOTHING`;
  } else {
    if (!('blob' in source)) throw new Error('Missing processed field backfill');
    insert = `INSERT INTO processed_resources (project_id,kind,resource_id,blob_key,source_token_id,event_id)
      SELECT s.project_id, '${source.kind}', s.${source.id}, s.${source.blob}, s.token_id, s.event_id
        FROM ${page} s WHERE s.${source.blob} IS NOT NULL AND ${processedReferenceSql('s', source)} AND ${HELD} ON CONFLICT DO NOTHING`;
  }
  return {
    page: read({ name: `raw.backfillPage${name}`, sql: `SELECT s.project_id, s.${source.id} AS resource_id FROM ${source.table} s
      WHERE (s.project_id, s.${source.id}) > (?1, ?2) ORDER BY s.project_id, s.${source.id} LIMIT ?3` }),
    attribute: write({ name: `raw.backfillAttribute${name}`, sql: `${insert} RETURNING 1 AS inserted` }),
    follow: source.kind !== 'event' ? [] : [
      write({ name: 'raw.backfillAdvanceRevision', sql:
        `UPDATE raw_provenance_state SET revision = revision + 1 WHERE id = 1 AND ${HELD} AND json_array_length(?1) > 0` }),
      write({ name: 'raw.backfillStampEvents', sql:
        `UPDATE events SET raw_revision = (SELECT revision FROM raw_provenance_state WHERE id = 1) WHERE raw_revision IS NULL AND (project_id, event_id) IN
      (SELECT s.project_id,s.event_id FROM ${page} s) AND ${HELD}` }),
    ],
  };
}

const BY_SOURCE = SOURCES.map(sourceStatements);

const checkpoint = write<[next: number, cursorProject: string, cursorId: string, complete: number, now: number, held: number, heldProject: string, heldId: string]>({
  name: 'raw.backfillCheckpoint', sql: `UPDATE raw_provenance_backfill SET source = ?1, cursor_project = ?2, cursor_id = ?3, complete = ?4, updated_at = ?5
      WHERE id = 1 AND source = ?6 AND cursor_project = ?7 AND cursor_id = ?8 AND complete = 0` });

/** The walk's checkpoint, or null before the row exists. */
export const rawBackfillState = (db: RelationalStore): Promise<BackfillState | null> => first(db, state.bind());

export async function rawBackfillPending(db: RelationalStore): Promise<boolean> {
  return (await first(db, pending.bind()))?.complete === 0;
}

/** The next rows of the checkpoint's source after its cursor, in key order. */
export function rawBackfillPage(db: RelationalStore, held: BackfillState, limit: number): Promise<{ project_id: string; resource_id: string }[]> {
  const statements = BY_SOURCE[held.source];
  if (statements === undefined) throw new Error('Unknown raw provenance backfill source');
  return rows(db, statements.page.bind(held.cursor_project, held.cursor_id, limit));
}

/**
 * Attributes the page's rows and moves the checkpoint to `next`, in one batch that changes nothing once another page
 * has moved the checkpoint from `held`. Answers how many rows the page attributed.
 */
export async function commitRawBackfillPage(db: RelationalStore, page: {
  held: BackfillState; selected: readonly { project_id: string; resource_id: string }[];
  next: { source: number; cursorProject: string; cursorId: string }; now: number;
}): Promise<number> {
  const { held, next } = page;
  const statements = BY_SOURCE[held.source];
  if (statements === undefined) throw new Error('Unknown raw provenance backfill source');
  const guard: PageGuard = [JSON.stringify(page.selected), held.source, held.cursor_project, held.cursor_id];
  const writes: Bound[] = statements.follow.map(statement => statement.bind(...guard));
  const [attributed] = await commit(db, statements.attribute.bind(...guard), ...writes,
    checkpoint.bind(next.source, next.cursorProject, next.cursorId, next.source === SOURCES.length ? 1 : 0, page.now,
      held.source, held.cursor_project, held.cursor_id));
  return attributed.results.length;
}
