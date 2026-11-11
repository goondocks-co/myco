/**
 * Restoring a backup's session document: the target's document as the plan reads it, the holders that keep the
 * artifact's chunks while it is restored, and the commit that converts or merges it while the document the plan read
 * still stands. A session with no document row and one with a row are separate statements, each fixed at load.
 */
import type { RelationalStore } from '../../core/adapters.js';
import type { ContentPublicationGuard } from '../../core/registered-content.js';
import { first, write, read, type Bound } from '../index.js';
import { namedContentGuard } from '../storage/content-guard.js';
import { registeredObjectKeySql } from '../storage/registered-object-key.js';

/** The target's document as a restore found it: none, or its state, hold and generation. */
export type RestoreSelection = { project: string; session: string } & (
  | { absent: true }
  | { absent: false; state: string; hold: string | null; now: number; generation: number | null; nextChunk: number }
);

/** The target session and its document as a restore reads them before it writes. */
export interface RestoreTarget {
  state: string | null; restore_hold: string | null; due_at: number | null; generation: number | null; next_chunk: number; prompts: number;
  first_prompt: string | null; open_turn_key: string | null; build: string | null; token_id: string; agent: string | null;
}

const objectOf = read<[project: string, key: string], { physical: string }>({ name: 'documentRestore.registeredObject', sql:
  `SELECT ${registeredObjectKeySql('b.project_id', 'b.key')} physical FROM blobs b WHERE b.project_id=?1 AND b.key=?2` });
const target = read<[project: string, session: string], RestoreTarget>({ name: 'documentRestore.target', sql: `SELECT d.state,d.restore_hold,d.due_at,d.generation,
    d.next_chunk,d.prompts,d.first_prompt,d.open_turn_key,d.build,s.created_by_token_id token_id,s.agent
  FROM sessions s LEFT JOIN session_documents d ON s.project_id = d.project_id AND s.session_id = d.session_id
  WHERE s.project_id = ?1 AND s.session_id = ?2
    AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=s.project_id AND t.session_id=s.session_id)` });
const holdChunk = write<[project: string, session: string, key: string, source: string, now: number]>({ name: 'documentRestore.holdArtifactChunk', sql:
  'INSERT OR IGNORE INTO retired_objects(project_id,session_id,blob_key,source_id,retired_at) VALUES(?1,?2,?3,?4,?5)' });

/** The stored object the destination registers for an artifact blob, or null when none does. */
export const registeredArtifactObject = async (db: RelationalStore, project: string, key: string): Promise<string | null> =>
  (await first(db, objectOf.bind(project, key)))?.physical ?? null;
/** The target session, with its document when it has one; null for a session that is gone or tombstoned. */
export const restoreTarget = (db: RelationalStore, project: string, session: string): Promise<RestoreTarget | null> => first(db, target.bind(project, session));
/** Holds an artifact chunk for the session before any restore pass registers it. */
export const holdArtifactChunkWrite = (project: string, session: string, chunk: { key: string; source: string }, now: number): Bound =>
  holdChunk.bind(project, session, chunk.key, chunk.source, now);

const ABSENT = 'NOT EXISTS(SELECT 1 FROM session_documents WHERE project_id=? AND session_id=?)';
const PRESENT = 'EXISTS(SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND state=? AND restore_hold IS ? AND (restore_hold IS NULL OR due_at<=?) AND generation IS ?)';
const HOLDER = 'EXISTS (SELECT 1 FROM retired_objects WHERE project_id=? AND session_id=? AND blob_key=? AND source_id=?)';

/** A chunk version registers only while the document the restore read still stands and the version's holder does. */
export function restoreRegistrationGuard(selection: RestoreSelection, version: { key: string; sourceId: string }): ContentPublicationGuard {
  const { project, session } = selection;
  const held = [project, session, version.key, version.sourceId];
  return selection.absent ? { sql: `${ABSENT} AND ${HOLDER}`, params: [project, session, ...held] }
    : { sql: `${PRESENT} AND ${HOLDER}`, params: [project, session, selection.state, selection.hold, selection.now, selection.generation, ...held] };
}

const CHUNKS_UNCHANGED = `NOT EXISTS (SELECT 1 FROM json_each(?3) j LEFT JOIN session_chunks c ON c.project_id=?1 AND c.session_id=?2 AND c.generation=?4
    AND c.chunk_no=json_extract(j.value,'$.n') WHERE c.blob_key IS NOT json_extract(j.value,'$.k'))`;
const UNTOMBSTONED = 'NOT EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=?1 AND session_id=?2)';
const absentHeld = namedContentGuard<[project: string, session: string, chunks: string, generation: number]>('documentRestore.absentDocumentHeld',
  `NOT EXISTS(SELECT 1 FROM session_documents WHERE project_id=?1 AND session_id=?2) AND ${UNTOMBSTONED} AND ${CHUNKS_UNCHANGED}`);
const presentHeld = namedContentGuard<[project: string, session: string, chunks: string, generation: number,
  state: string, hold: string | null, now: number, readGeneration: number | null, nextChunk: number]>('documentRestore.documentHeld',
  `EXISTS(SELECT 1 FROM session_documents WHERE project_id=?1 AND session_id=?2 AND state=?5 AND restore_hold IS ?6 AND (restore_hold IS NULL OR due_at<=?7) AND generation IS ?8)
    AND ${UNTOMBSTONED} AND EXISTS(SELECT 1 FROM session_documents WHERE project_id=?1 AND session_id=?2 AND next_chunk=?9) AND ${CHUNKS_UNCHANGED}`);
const unpublished = namedContentGuard<[project: string, session: string]>('documentRestore.nothingPublished',
  'NOT EXISTS(SELECT 1 FROM transcript_publication WHERE project_id=?1 AND session_id=?2 AND published_offset>0)');

/** The commit fails unless the document the restore read still stands, untombstoned, with the chunks it expects at `generation`. */
export function restoredDocumentHeld(selection: RestoreSelection, chunks: string, generation: number): Bound[] {
  const { project, session } = selection;
  return selection.absent ? absentHeld(project, session, chunks, generation)
    : presentHeld(project, session, chunks, generation, selection.state, selection.hold, selection.now, selection.generation, selection.nextChunk);
}
/** A conversion the plan decided fails once a live document has published anything. */
export const nothingPublishedGuard = (project: string, session: string): Bound[] => unpublished(project, session);

const openDocument = write<[project: string, session: string, generation: number, now: number]>({ name: 'documentRestore.openDocument', sql:
  `INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES(?1,?2,'live',?3,?4)` });
/** A document row for a session that has none, live at the restored generation. */
export const openRestoredDocumentWrite = (project: string, session: string, generation: number, now: number): Bound => openDocument.bind(project, session, generation, now);

/** The catalog tables a conversion fills before its flip. */
const BUILT = ['document_owners', 'document_continuations', 'document_plan_keys', 'document_metadata_ready', 'document_metadata_progress', 'session_chunks',
  'session_pages', 'session_sealed_records', 'session_prompts', 'session_paths', 'session_edit_paths', 'session_turn_entries', 'session_turn_totals',
  'session_path_build', 'myco_tool_calls', 'transcript_publication'] as const;
const camel = (table: string) => table.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()).replace(/^./, letter => letter.toUpperCase());
const clearBuilt = BUILT.map(table => write<[project: string, session: string]>({ name: `documentRestore.clear${camel(table)}`, sql:
  `DELETE FROM ${table} WHERE project_id=?1 AND session_id=?2` }));
const retireChunks = write<[now: number, project: string, session: string]>({ name: 'documentRestore.retireChunks', sql: `INSERT OR IGNORE INTO retired_objects(project_id,session_id,blob_key,source_id,retired_at)
  SELECT project_id,session_id,blob_key,source_id,?1 FROM session_chunks WHERE project_id=?2 AND session_id=?3` });
const resetDocument = write<[generation: number, project: string, session: string]>({ name: 'documentRestore.resetDocument', sql: `UPDATE session_documents SET generation=?1,build=NULL,prompts=0,user_prompts=0,replies=0,tool_calls=0,failed_tools=0,plans=0,
    myco_calls=0,files_edited=0,paths_count=0,myco_build=0,paths_build=NULL,rollup_after=NULL,rollup_page=0,rollup_record=0,
    first_prompt=NULL,last_record_at=NULL,open_turn_key=NULL,next_chunk=0 WHERE project_id=?2 AND session_id=?3` });

/** Empties a held document for conversion: its chunks held for release, its catalog cleared, its row reset to `generation`. */
export function clearForConversionWrites(project: string, session: string, generation: number, now: number): Bound[] {
  return [retireChunks.bind(now, project, session), ...clearBuilt.map(statement => statement.bind(project, session)), resetDocument.bind(generation, project, session)];
}
