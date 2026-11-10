import type { RelationalStore } from '../../core/adapters.js';
import { importEnabledChecks } from '../../core/import-policy.js';
import { MAX_SPORE_LIMIT, type SporeInsert, type SporeRow } from '../../core/spores.js';
import type { ReadScope } from '../../read/scope.js';
import { assertion, commitNamed, first, read, refusalCode, refused, rows, write, type Bound } from '../index.js';
import { SPORE_COLUMNS, SPORE_READ_COLUMNS } from './browse.js';

/** One spore row: how it is written, repaired from an import, and read back by id. */
type InsertSlots = [
  project: string, id: string, agentId: string, sessionId: string | null, type: string, status: string, content: string, context: string | null,
  importance: number, filePath: string | null, tags: string | null, contentHash: string | null, properties: string | null, author: string | null,
  provenanceKind: string | null, provenanceRef: string | null, agentLine: string | null, createdAt: number,
];

const importSwitch = importEnabledChecks().admission;
const IMPORT_DISABLED = refusalCode('spore_import_disabled');
const importAdmitted = assertion<[leaf: string, off: string]>({ name: 'spores.importAdmitted', refusal: IMPORT_DISABLED, when: importSwitch.sql });
/** The assertion an import-channel write commits ahead of itself, stopping that batch while the Deployment has imports switched off. */
export const importAdmittedAssertion = (): Bound => importAdmitted.bind(importSwitch.params[0] as string, importSwitch.params[1] as string);
export const importRefused = (error: unknown): boolean => refused(error, IMPORT_DISABLED);

const insertSql = (conflict: string) => `INSERT INTO spores (project_id,id,agent_id,session_id,observation_type,status,content,context,importance,file_path,tags,content_hash,properties,author,provenance_kind,provenance_ref,agent_line,created_at,embedded)
  SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,0 WHERE 1 ${conflict} RETURNING ${SPORE_COLUMNS}`;

/** Aborts the batch on an id the Project already holds. */
const insertRow = write<InsertSlots, SporeRow>({ name: 'spores.insert', sql: insertSql('') });
/** Leaves a held id as it is and returns nothing. */
const insertUnlessHeld = write<InsertSlots, SporeRow>({ name: 'spores.insertUnlessHeld', sql: insertSql('ON CONFLICT (project_id, id) DO NOTHING') });

const repairSource = write<[sessionId: string, project: string, id: string, author: string | null, agentId: string, content: string, createdAt: number | null]>({
  name: 'spores.repairImportedSource',
  sql: `UPDATE spores SET session_id=COALESCE(session_id,?1) WHERE project_id=?2 AND id=?3 AND author=?4 AND agent_id=?5 AND content=?6 AND (?7 IS NULL OR created_at=?7)
    AND (session_id IS NULL OR session_id=?1) AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id=spores.project_id AND s.session_id=?1)`,
});

export type SporeWithSource = SporeRow & { sourceCreatedAt: number | null };
const SOURCE_CREATED_AT = `(SELECT COALESCE(s.started_at,s.first_received_at) FROM sessions s WHERE s.project_id=spores.project_id AND s.session_id=spores.session_id) AS sourceCreatedAt`;

const sporeById = read<[project: string, id: string], SporeWithSource>({ name: 'spores.byId', sql: `SELECT ${SPORE_READ_COLUMNS},${SOURCE_CREATED_AT} FROM spores WHERE project_id=?1 AND id=?2` });
const sporesByIds = read<[project: string, ids: string], SporeRow>({ name: 'spores.byIds', sql: `SELECT ${SPORE_READ_COLUMNS} FROM spores WHERE (project_id,id) IN (SELECT ?1,value FROM json_each(?2))` });
const sporesWithSourceByIds = read<[project: string, ids: string], SporeWithSource>({ name: 'spores.byIdsWithSource', sql: `SELECT ${SPORE_READ_COLUMNS},${SOURCE_CREATED_AT} FROM spores WHERE (project_id,id) IN (SELECT ?1,value FROM json_each(?2))` });
/** A spore's point read, for a batch that decides from it beside other rows. */
export const sporeReadStatement = (project: string, id: string): Bound<SporeWithSource, 'read'> => sporeById.bind(project, id);
const authored = read<[project: string, author: string], { one: number }>({ name: 'spores.authoredBy', sql: 'SELECT 1 AS one FROM spores WHERE project_id=?1 AND author=?2 LIMIT 1' });
const insertSlots = (scope: ReadScope, row: SporeInsert): InsertSlots => [scope.projectId, row.id, row.agentId, row.sessionId, row.observationType, row.status ?? 'active', row.content, row.context, row.importance ?? 5, row.filePath, row.tags, row.contentHash, row.properties, row.author,
  row.provenance?.kind ?? null, row.provenance?.ref ?? null, row.agentLine ?? null, row.createdAt];

/** The insert a consolidation commits beside its source moves: an id already held aborts that commit. */
export const sporeInsertWrite = (scope: ReadScope, row: SporeInsert): Bound<SporeRow, 'write'> => insertRow.bind(...insertSlots(scope, row));

/**
 * Writes one spore and returns it, or null when the Project already holds a spore under that id, which is left as it is.
 *
 * `RETURNING` rather than a read-back: 1.4 selects the row again after inserting it, which is free against a local file and a second round trip against a Deployment.
 */
export async function insertSpore(db: RelationalStore, scope: ReadScope, row: SporeInsert): Promise<SporeRow | null> {
  const insert = insertUnlessHeld.bind(...insertSlots(scope, row));
  if (row.channel !== 'import') return first(db, insert);
  try {
    return (await commitNamed(db, { imported: importAdmittedAssertion(), insert })).insert.results[0] ?? null;
  } catch (error) {
    if (importRefused(error)) return null;
    throw error;
  }
}

export const getSpore = (db: RelationalStore, scope: ReadScope, id: string): Promise<SporeWithSource | null> => first(db, sporeById.bind(scope.projectId, id));

/** Fill absent import provenance only when the original spore and its stored source agree. */
export async function repairImportedSporeSource(db: RelationalStore, scope: ReadScope, row: Pick<SporeInsert, 'id' | 'author' | 'agentId' | 'content' | 'sessionId'> & { createdAt?: number }): Promise<'restored' | 'kept' | 'pending'> {
  if (row.sessionId === null) return 'restored';
  try {
    await commitNamed(db, { imported: importAdmittedAssertion(), repair: repairSource.bind(row.sessionId, scope.projectId, row.id, row.author, row.agentId, row.content, row.createdAt ?? null) });
  } catch (error) {
    if (!importRefused(error)) throw error;
  }
  const held = await getSpore(db, scope, row.id);
  if (held?.sessionId === row.sessionId) return 'restored';
  if (held !== null && ((held.sessionId !== null && held.sessionId !== row.sessionId)
    || held.author !== row.author || held.agentId !== row.agentId || held.content !== row.content || (row.createdAt !== undefined && held.createdAt !== row.createdAt))) return 'kept';
  return 'pending';
}

/** The named spores of this Project, in the store's own order. Ids the Project does not hold are absent: a reader hydrating a record kept past a spore is told what is still there. */
export const listSporesByIds = (db: RelationalStore, scope: ReadScope, ids: readonly string[]): Promise<SporeRow[]> =>
  rows(db, sporesByIds.bind(scope.projectId, JSON.stringify([...new Set(ids)].slice(0, MAX_SPORE_LIMIT))));

/** The named spores of this Project with the time their source session started, keyed by id. */
export async function sporesWithSourceById(db: RelationalStore, scope: ReadScope, ids: readonly string[]): Promise<Map<string, SporeWithSource>> {
  return new Map((await rows(db, sporesWithSourceByIds.bind(scope.projectId, JSON.stringify([...new Set(ids)].slice(0, MAX_SPORE_LIMIT))))).map(spore => [spore.id, spore]));
}

/** Whether this author — a run id, a member id or a grant id — wrote at least one spore in this Project. */
export const sporeAuthoredBy = async (db: RelationalStore, scope: ReadScope, author: string): Promise<boolean> => await first(db, authored.bind(scope.projectId, author)) !== null;
