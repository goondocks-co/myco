import type { PreparedStatement, RelationalStore } from './adapters.js';
import { contentAssertion } from './registered-content.js';
import { NOT_TOMBSTONED_PARAMS } from './tombstones.js';

export interface MaterialVersionUnit {
  nextSeq: number;
  maxSeq: number;
  revision: number;
  bindings: {
    kind: string;
    identity: string;
    record_id: string;
    content_hash: string;
    hash_scheme: string;
    owner: 'view' | 'fact';
    material_seq: number;
  }[];
}

/** The allocator and its current bindings are one snapshot and one restore unit. */
export async function exportMaterialVersions(
  db: RelationalStore,
  project: string,
  session: string,
): Promise<MaterialVersionUnit | null> {
  const row = await db
    .prepare(
      `SELECT l.next_seq,l.max_seq,l.revision,
    (SELECT json_group_array(json_object('kind',v.kind,'identity',v.identity,'record_id',v.record_id,
      'content_hash',v.content_hash,'hash_scheme',v.hash_scheme,'owner',v.owner,'material_seq',v.material_seq))
      FROM material_versions v WHERE v.project_id=l.project_id AND v.session_id=l.session_id) bindings
    FROM learning_sessions l WHERE l.project_id=? AND l.session_id=?`,
    )
    .bind(project, session)
    .first<{ next_seq: number; max_seq: number; revision: number; bindings: string }>();
  if (row === null) return null;
  return { nextSeq: row.next_seq, maxSeq: row.max_seq, revision: row.revision, bindings: JSON.parse(row.bindings) };
}

/** An absent version unit leaves initialization explicitly pending. */
export function restoreMaterialVersionStatements(
  db: RelationalStore,
  project: string,
  session: string,
  unit: MaterialVersionUnit | null,
): PreparedStatement[] {
  if (unit === null) return [];
  const integers = [unit.nextSeq, unit.maxSeq, unit.revision, ...unit.bindings.map((row) => row.material_seq)];
  if (
    integers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    unit.nextSeq <= unit.maxSeq ||
    unit.bindings.some(
      (row) =>
        row.material_seq < 1 ||
        row.material_seq > unit.maxSeq ||
        !row.identity ||
        !row.content_hash ||
        !row.hash_scheme ||
        !['view', 'fact'].includes(row.owner),
    ) ||
    new Set(unit.bindings.map((row) => JSON.stringify([row.kind, row.identity]))).size !== unit.bindings.length ||
    new Set(unit.bindings.map((row) => row.material_seq)).size !== unit.bindings.length
  )
    throw new Error('material_version_unit_invalid');
  const input = JSON.stringify(unit.bindings);
  return [
    ...contentAssertion(db, NOT_TOMBSTONED_PARAMS, [project, session]),
    ...contentAssertion(
      db,
      `NOT EXISTS(SELECT 1 FROM learning_sessions WHERE project_id=? AND session_id=?
      AND (next_seq<>? OR max_seq<>? OR revision<>?))
      AND NOT EXISTS(SELECT 1 FROM material_versions v WHERE v.project_id=? AND v.session_id=? AND NOT EXISTS(
        SELECT 1 FROM json_each(?) j WHERE v.kind=json_extract(j.value,'$.kind') AND v.identity=json_extract(j.value,'$.identity')
          AND v.record_id=json_extract(j.value,'$.record_id') AND v.content_hash=json_extract(j.value,'$.content_hash')
          AND v.hash_scheme=json_extract(j.value,'$.hash_scheme') AND v.owner=json_extract(j.value,'$.owner') AND v.material_seq=json_extract(j.value,'$.material_seq')))`,
      [project, session, unit.nextSeq, unit.maxSeq, unit.revision, project, session, input],
    ),
    db
      .prepare(
        `INSERT OR IGNORE INTO learning_sessions(project_id,session_id,next_seq,max_seq,revision) VALUES(?,?,?,?,?)`,
      )
      .bind(project, session, unit.nextSeq, unit.maxSeq, unit.revision),
    db
      .prepare(
        `INSERT OR IGNORE INTO material_versions(project_id,session_id,kind,identity,record_id,content_hash,hash_scheme,owner,material_seq)
      SELECT ?,?,json_extract(value,'$.kind'),json_extract(value,'$.identity'),json_extract(value,'$.record_id'),
        json_extract(value,'$.content_hash'),json_extract(value,'$.hash_scheme'),json_extract(value,'$.owner'),json_extract(value,'$.material_seq') FROM json_each(?)`,
      )
      .bind(project, session, input),
  ];
}
