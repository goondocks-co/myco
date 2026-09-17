/**
 * Where a registered blob's bytes are stored.
 *
 * A `blobs` row is keyed by its content, `(project_id, key)`. The stored object it registered is named by the row's
 * generation as well: `<project>/<key>~<generation>`. Each upload writes under a generation no other write uses, so a
 * store delete issued for one generation can never remove bytes a later upload of the same content stored. A row with
 * no generation predates generations and names `<project>/<key>`; nothing writes that name now.
 *
 * This module is the only place the physical name is spelled, in TypeScript and in SQL, and a gate holds the two to
 * each other.
 */
import { BLOB_KEY_GRAMMAR } from '../ingest/kinds.js';

/** The project id grammar `db/project-id.ts` holds every row to. */
const PROJECT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** A generation: a lowercase UUID, as `crypto.randomUUID()` mints it. */
export const GENERATION_GRAMMAR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where an artifact holds a registered blob: its logical identity, the same for every generation of the content. */
export function blobArtifactKey(projectId: string, key: string): string {
  return `${projectId}/${key}`;
}

/** The stored object a row `(projectId, key, generation)` registered. */
export function blobObjectKey(projectId: string, key: string, generation: string | null): string {
  if (generation !== null && !GENERATION_GRAMMAR.test(generation)) throw new Error('a blob generation is not a lowercase UUID');
  return generation === null ? blobArtifactKey(projectId, key) : `${blobArtifactKey(projectId, key)}~${generation}`;
}

/** SQL for the stored object a row registered, from SQL expressions naming its project, key and generation. */
export function blobObjectKeySql(project: string, key: string, generation: string): string {
  return `(${project} || '/' || ${key} || COALESCE('~' || ${generation}, ''))`;
}

/**
 * SQL for the stored object the registered row of blob `key` in Project `project` names, or NULL when no row registers
 * it. `project` and `key` are SQL expressions of the enclosing statement.
 */
export function registeredObjectKeySql(project: string, key: string): string {
  return `(SELECT ${blobObjectKeySql('ro.project_id', 'ro.key', 'ro.generation')} FROM blobs ro WHERE ro.project_id = ${project} AND ro.key = ${key})`;
}

/**
 * The logical identity and generation a snapshot row names, held to the grammar every writer uses. A row outside it
 * is refused: a substituted or malformed mapping must never direct a copy to other bytes.
 */
export function snapshotBlobObject(row: { project_id: unknown; key: unknown; generation: unknown }): { projectId: string; key: string; generation: string | null; objectKey: string } {
  const { project_id: projectId, key, generation } = row;
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId) || projectId === '.' || projectId === '..') throw new Error('a blob row names a Project outside the project id grammar');
  if (typeof key !== 'string' || !BLOB_KEY_GRAMMAR.test(key)) throw new Error('a blob row names a key outside the content digest grammar');
  if (generation !== null && (typeof generation !== 'string' || !GENERATION_GRAMMAR.test(generation))) {
    throw new Error('a blob row names a generation outside the stored-object grammar');
  }
  return { projectId, key, generation, objectKey: blobObjectKey(projectId, key, generation) };
}
