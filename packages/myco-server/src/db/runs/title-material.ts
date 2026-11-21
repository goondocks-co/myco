import type { RelationalStore } from '../../core/adapters.js';
import type { TitleSnapshot } from '../documents/titling-material.js';
import { first, read, rows, write } from '../index.js';

const remember = write<[project: string, run: string, snapshot: string, token: string], { id: string }>({ name: 'titleMaterial.remember', sql: `
  UPDATE agent_runs SET run_context=json_set(run_context,'$.titleSnapshot',json_object('tokenId',?4,'source',json(?3)))
  WHERE project_id=?1 AND id=?2 AND task='title-summary' AND status='running' RETURNING id` });
const held = read<[project: string, run: string, token: string], { snapshot: string | null }>({ name: 'titleMaterial.held', sql: `
  SELECT json_extract(run_context,'$.titleSnapshot.source') AS snapshot FROM agent_runs WHERE project_id=?1 AND id=?2 AND task='title-summary' AND status='running' AND json_extract(run_context,'$.titleSnapshot.tokenId')=?3` });

/** The run records the exact material served before it may write a title. */
export async function rememberTitleMaterial(db: RelationalStore, project: string, run: string, token: string, snapshot: TitleSnapshot): Promise<void> {
  if ((await rows(db, remember.bind(project, run, JSON.stringify(snapshot), token))).length === 0) throw new Error('title_material_run_not_running');
}
export async function heldTitleMaterial(db: RelationalStore, project: string, run: string, token: string): Promise<TitleSnapshot | null> {
  const row = await first(db, held.bind(project, run, token));
  return row?.snapshot == null ? null : JSON.parse(row.snapshot) as TitleSnapshot;
}
