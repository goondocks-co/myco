/**
 * The catalog summary catch-up: the oldest live document whose tool rollup is behind, the page chunk it resumes at,
 * the paths it is building, and the one commit that advances its cursor while every read it made still holds.
 */
import type { RelationalStore } from '../../core/adapters.js';
import type { ChunkRow } from '../../content/document-reader.js';
import { first, read, rows, write, type Bound } from '../index.js';
import { namedContentGuard } from '../storage/content-guard.js';
import { registeredObjectKeySql } from '../storage/registered-object-key.js';
import type { DocumentKey } from './turn-statistics.js';

/** A live document whose rollup is due, with its cursor. */
export interface RollupDocument {
  project_id: string; session_id: string; generation: number; publication_input_revision: number; rollup_after: number; rollup_page: number; rollup_epoch: number;
  paths_build: string | null; agent: string | null;
  myco_build: number; rollup_record: number;
}
/** A path's counts while a rollup builds them. */
export interface PathBuild { path: string; calls: number; edits: number; at: number; turn: string | null }
/** A page the rollup reads, with its turn's stored tool state. */
export interface RollupPage { owner: string; page: number; tool_state: string | null; rollup_build: string | null; tool_revision: number | null; last_page: number }

const DUE = `FROM session_documents d INDEXED BY idx_session_documents_rollup`;
const DUE_WHERE = `d.rollup_after IS NOT NULL AND d.state='live' AND d.rollup_due<=?1 ORDER BY d.rollup_due,d.rollup_checked,d.project_id,d.session_id LIMIT 1`;
const CHUNK_COLUMNS = `c.chunk_no,c.blob_key,c.kind,c.bytes,c.source_id,${registeredObjectKeySql('c.project_id', 'c.blob_key')} AS object_key`;

const dueDocument = read<[now: number], RollupDocument>({ name: 'documentRollup.dueDocument', sql: `SELECT d.project_id,d.session_id,d.generation,d.publication_input_revision,
    d.rollup_after,d.rollup_page,d.rollup_epoch,d.paths_build,d.myco_build,d.rollup_record,s.agent
  ${DUE} JOIN sessions s ON s.project_id=d.project_id AND s.session_id=d.session_id WHERE ${DUE_WHERE}` });
const anyDue = read<[now: number], { pending: number }>({ name: 'documentRollup.anyDue', sql: `SELECT 1 AS pending ${DUE} WHERE ${DUE_WHERE}` });
const pageChunks = read<[...DocumentKey, after: number], ChunkRow>({ name: 'documentRollup.pageChunksAfter', sql: `SELECT ${CHUNK_COLUMNS}
  FROM session_chunks c INDEXED BY idx_session_chunks_pages
  WHERE c.project_id=?1 AND c.session_id=?2 AND c.generation=?3 AND c.kind='page' AND c.chunk_no>?4
  ORDER BY c.chunk_no LIMIT 2` });
const bodyChunk = read<[...DocumentKey, chunk: number], ChunkRow>({ name: 'documentRollup.bodyChunk', sql: `SELECT ${CHUNK_COLUMNS}
  FROM session_chunks c WHERE c.project_id=?1 AND c.session_id=?2 AND c.generation=?3 AND c.chunk_no=?4` });
const storedPaths = read<[...DocumentKey, limit: number], { path: string }>({ name: 'documentRollup.storedPaths', sql:
  'SELECT path FROM session_paths WHERE project_id=?1 AND session_id=?2 AND generation=?3 ORDER BY path LIMIT ?4' });
const buildingPaths = read<[...DocumentKey, limit: number], PathBuild>({ name: 'documentRollup.buildingPaths', sql: `SELECT path,calls,edits,at,turn FROM session_path_build
  WHERE project_id=?1 AND session_id=?2 AND generation=?3 ORDER BY path LIMIT ?4` });
const heldPages = read<[...DocumentKey, pages: string, chunk: number], RollupPage>({ name: 'documentRollup.heldPages', sql: `SELECT p.owner,p.page,sp.tool_state,sp.rollup_build,sp.tool_revision,
    (SELECT tail.page FROM session_pages tail WHERE tail.project_id=?1 AND tail.session_id=?2 AND tail.generation=?3
      AND tail.owner=p.owner ORDER BY tail.page DESC LIMIT 1) AS last_page
  FROM json_each(?4) j CROSS JOIN session_pages p
    ON p.project_id=?1 AND p.session_id=?2 AND p.generation=?3 AND p.owner=json_extract(j.value,'$.owner') AND p.page=json_extract(j.value,'$.page')
  LEFT JOIN session_prompts sp ON sp.project_id=p.project_id AND sp.session_id=p.session_id AND sp.generation=p.generation AND sp.prompt_id=p.owner
  WHERE p.chunk_no=?5` });
const transcriptAgent = read<[project: string, transcript: string], { agent: string | null }>({ name: 'documentRollup.transcriptAgent', sql:
  'SELECT agent FROM transcripts WHERE project_id=?1 AND transcript_id=?2' });

export const dueRollupDocument = (db: RelationalStore, now: number): Promise<RollupDocument | null> => first(db, dueDocument.bind(now));
export const rollupDue = async (db: RelationalStore, now: number): Promise<boolean> => (await first(db, anyDue.bind(now))) !== null;
export const rollupPageChunks = (db: RelationalStore, key: DocumentKey, after: number): Promise<ChunkRow[]> => rows(db, pageChunks.bind(...key, after));
export const rollupBodyChunk = (db: RelationalStore, key: DocumentKey, chunk: number): Promise<ChunkRow | null> => first(db, bodyChunk.bind(...key, chunk));
/** The paths a rollup starts from: the stored paths when none is building, else the build so far. */
export async function rollupPaths(db: RelationalStore, key: DocumentKey, building: boolean, limit: number): Promise<PathBuild[]> {
  if (building) return rows(db, buildingPaths.bind(...key, limit));
  return (await rows(db, storedPaths.bind(...key, limit))).map(({ path }) => ({ path, calls: 0, edits: 0, at: 0, turn: null }));
}
export const rollupHeldPages = (db: RelationalStore, key: DocumentKey, pages: string, chunk: number): Promise<RollupPage[]> =>
  rows(db, heldPages.bind(...key, pages, chunk));
export const rollupTranscriptAgent = (db: RelationalStore, project: string, transcript: string): Promise<{ agent: string | null } | null> =>
  first(db, transcriptAgent.bind(project, transcript));

const cursorHeld = namedContentGuard<[...DocumentKey, epoch: number, after: number, page: number, record: number]>('documentRollup.cursorHeld',
  `EXISTS (SELECT 1 FROM session_documents WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND state='live'
    AND rollup_epoch=?4 AND rollup_after=?5 AND rollup_page=?6 AND rollup_record=?7)`);
const noPageAfter = namedContentGuard<[...DocumentKey, after: number]>('documentRollup.noPageAfter',
  `NOT EXISTS (SELECT 1 FROM session_chunks WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND kind='page' AND chunk_no>?4)`);
const chunkHeld = namedContentGuard<[...DocumentKey, chunk: number, key: string, last: number]>('documentRollup.chunkHeld',
  `EXISTS (SELECT 1 FROM session_chunks c WHERE c.project_id=?1 AND c.session_id=?2 AND c.generation=?3 AND c.chunk_no=?4 AND c.blob_key=?5
    AND (?6=0 OR NOT EXISTS (SELECT 1 FROM session_chunks tail WHERE tail.project_id=c.project_id AND tail.session_id=c.session_id
      AND tail.generation=c.generation AND tail.kind='page' AND tail.chunk_no>c.chunk_no)))`);
const revisionsHeld = namedContentGuard<[...DocumentKey, revisions: string]>('documentRollup.revisionsHeld', `NOT EXISTS (
  SELECT 1 FROM json_each(?4) j LEFT JOIN session_prompts p ON p.project_id=?1 AND p.session_id=?2 AND p.generation=?3
    AND p.prompt_id=json_extract(j.value,'$.id') WHERE p.tool_revision IS NOT json_extract(j.value,'$.revision'))`);

/** The cursor the rollup read, and the chunk it read at it (or that none follows), still stand. */
export function rollupReadHeld(key: DocumentKey, doc: RollupDocument, chunk: { chunkNo: number; key: string; last: boolean } | null): Bound[] {
  return [...cursorHeld(...key, doc.rollup_epoch, doc.rollup_after, doc.rollup_page, doc.rollup_record),
    ...(chunk === null ? noPageAfter(...key, doc.rollup_after) : chunkHeld(...key, chunk.chunkNo, chunk.key, chunk.last ? 1 : 0))];
}
/** Every turn the rollup read still has the tool revision it read. */
export const rollupRevisionsHeld = (key: DocumentKey, revisions: string): Bound[] => revisionsHeld(...key, revisions);

const promptRollup = write<[...DocumentKey, updates: string]>({ name: 'documentRollup.promptRollup', sql: `UPDATE session_prompts SET rollup_build=json_extract(j.value,'$.build'),
    tool_state=COALESCE(json_extract(j.value,'$.state'),tool_state),tool_revision=tool_revision+1,
    failed_tools=COALESCE(json_extract(j.value,'$.failed'),failed_tools),myco_calls=COALESCE(json_extract(j.value,'$.myco'),myco_calls)
  FROM json_each(?4) j WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND prompt_id=json_extract(j.value,'$.id')
    AND prompt_id IN (SELECT json_extract(value,'$.id') FROM json_each(?4))` });
const clearPathBuild = write<DocumentKey>({ name: 'documentRollup.clearPathBuild', sql:
  'DELETE FROM session_path_build WHERE project_id=?1 AND session_id=?2 AND generation=?3' });
const savePathBuild = write<[...DocumentKey, paths: string]>({ name: 'documentRollup.savePathBuild', sql: `INSERT INTO session_path_build(project_id,session_id,generation,path,calls,edits,at,turn)
  SELECT ?1,?2,?3,json_extract(value,'$.path'),json_extract(value,'$.calls'),json_extract(value,'$.edits'),
    json_extract(value,'$.at'),json_extract(value,'$.turn') FROM json_each(?4) WHERE true
  ON CONFLICT(project_id,session_id,generation,path) DO UPDATE SET calls=excluded.calls,edits=excluded.edits,at=excluded.at,turn=excluded.turn` });
const finishPaths = write<DocumentKey>({ name: 'documentRollup.finishPaths', sql: `INSERT INTO session_paths(project_id,session_id,generation,path,tool_calls,edits,last_at,last_turn)
  SELECT project_id,session_id,generation,path,calls,edits,at,turn FROM session_path_build WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND true
  ON CONFLICT(project_id,session_id,generation,path) DO UPDATE SET tool_calls=excluded.tool_calls,edits=excluded.edits,last_at=excluded.last_at,last_turn=excluded.last_turn` });
const advance = write<[after: number | null, page: number, record: number, pathsBuild: string | null, mycoBuild: number, finished: number, mycoCalls: number,
  capped: number, now: number, ...DocumentKey]>({ name: 'documentRollup.advanceCursor', sql: `UPDATE session_documents SET rollup_after=?1,rollup_page=?2,rollup_record=?3,
    paths_build=?4,myco_build=?5,myco_calls=CASE WHEN ?6 THEN ?7 ELSE myco_calls END,
    paths_capped=MAX(paths_capped,?8),rollup_failure=NULL,rollup_due=0,rollup_checked=MAX(rollup_checked+1,?9)
  WHERE project_id=?10 AND session_id=?11 AND generation=?12` });

export const rollupPromptWrite = (key: DocumentKey, updates: string): Bound => promptRollup.bind(...key, updates);
export const clearPathBuildWrite = (key: DocumentKey): Bound => clearPathBuild.bind(...key);
export const savePathBuildWrite = (key: DocumentKey, paths: string): Bound => savePathBuild.bind(...key, paths);
/** Moves a finished build into the session's paths and clears it. */
export const finishPathsWrites = (key: DocumentKey): Bound[] => [finishPaths.bind(...key), clearPathBuild.bind(...key)];

/** Where the rollup stands after this commit, and what it found. */
export interface RollupCursor {
  after: number | null; page: number; record: number; pathsBuild: string | null; mycoBuild: number; finished: boolean; mycoCalls: number; capped: boolean; now: number;
}
export const advanceRollupWrite = (key: DocumentKey, cursor: RollupCursor): Bound =>
  advance.bind(cursor.after, cursor.page, cursor.record, cursor.pathsBuild, cursor.mycoBuild, cursor.finished ? 1 : 0, cursor.mycoCalls, cursor.capped ? 1 : 0, cursor.now, ...key);
