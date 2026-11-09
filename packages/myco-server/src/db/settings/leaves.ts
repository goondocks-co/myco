import { CURATION_DAILY_LIMIT_SETTING } from '@goondocks/myco-shared/settings-contract';
import type { RelationalStore } from '../../core/adapters.js';
import type { AdmittedSettingsChange } from '../../core/settings.js';
import type { EmbeddingSwitch } from '../../core/embedding/switch-store.js';
import {
  SWITCH_STANDS_SQL,
  SWITCH_COMPLETION_SQL,
  switchCompletionParams,
} from '../embeddings/switch.js';
import { assertion, commit, read, readSet, refusalCode, refused, write, type Bound } from '../index.js';
import { SETTINGS_REVISION_CONFLICT } from '../meta/settings-observation.js';

export interface SettingState {
  leaf: string;
  value: string | null;
  revision: number;
  updated_at: number | null;
  updated_by: string | null;
}

const states = read<[scope: string, leaves: string], SettingState>({ name: 'settings.states', sql: `
  SELECT requested.value AS leaf,s.value,COALESCE(r.revision,0) AS revision,s.updated_at,s.updated_by
  FROM json_each(?2) requested
  LEFT JOIN deployment_settings s ON ?1='' AND s.leaf=requested.value
  LEFT JOIN setting_revisions r ON r.scope=?1 AND r.leaf=requested.value
  WHERE ?1=''
  UNION ALL
  SELECT requested.value,s.value,COALESCE(r.revision,0),s.updated_at,s.updated_by
  FROM json_each(?2) requested
  LEFT JOIN project_settings s ON s.project_id=?1 AND s.leaf=requested.value
  LEFT JOIN setting_revisions r ON r.scope=?1 AND r.leaf=requested.value
  WHERE ?1<>''` });
const revisions = read<[scope: string], { leaf: string; revision: number }>({ name: 'settings.revisions', sql:
  'SELECT leaf,revision FROM setting_revisions WHERE scope=?' });
const SETTINGS_PROJECT_INACTIVE = refusalCode('settings_project_inactive');
const SETTINGS_EMBEDDING_CONFLICT = refusalCode('settings_embedding_conflict');
const unchanged = assertion<[scope: string, expected: string]>({ name: 'settings.unchanged', refusal: SETTINGS_REVISION_CONFLICT, when: `NOT EXISTS (SELECT 1 FROM json_each(?2) expected
    WHERE COALESCE((SELECT revision FROM setting_revisions WHERE scope=?1 AND leaf=expected.key),0)<>expected.value)` });
const active = assertion<[project: string]>({ name: 'settings.activeProject', refusal: SETTINGS_PROJECT_INACTIVE, when: `EXISTS(SELECT 1 FROM projects WHERE project_id=? AND archived_at IS NULL)` });
const embedding = assertion<[empty: number]>({ name: 'settings.embeddingUnchanged', refusal: SETTINGS_EMBEDDING_CONFLICT, when: `NOT ${SWITCH_STANDS_SQL} AND (?=0 OR NOT EXISTS(SELECT 1 FROM embedding_receipts WHERE ready>=0))` });
const put = write<[leaf: string, value: string, at: number, actor: string, id: string]>({ name: 'settings.put', sql: `
  INSERT INTO deployment_settings(leaf,value,updated_at,updated_by,write_id) VALUES(?,?,?,?,?)
  ON CONFLICT(leaf) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by,write_id=excluded.write_id` });
const remove = write<[leaf: string]>({ name: 'settings.remove', sql: 'DELETE FROM deployment_settings WHERE leaf=?' });
const reset = write<[leaf: string, at: number, actor: string]>({ name: 'settings.reset', sql: `
  INSERT INTO deployment_setting_resets(leaf,reset_at,reset_by) VALUES(?,?,?)
  ON CONFLICT(leaf) DO UPDATE SET reset_at=excluded.reset_at,reset_by=excluded.reset_by` });
const projectPut = write<[project: string, leaf: string, value: string, at: number, actor: string]>({ name: 'settings.projectPut', sql: `
  INSERT INTO project_settings(project_id,leaf,value,updated_at,updated_by) VALUES(?,?,?,?,?)
  ON CONFLICT(project_id,leaf) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by` });
const capabilityPut = write<[project: string, capability: string, enabled: number, at: number, actor: string]>({ name: 'settings.capabilityPut', sql: `
  INSERT INTO project_capabilities(project_id,capability,enabled,updated_at,updated_by) VALUES(?,?,?,?,?)
  ON CONFLICT(project_id,capability) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at,updated_by=excluded.updated_by` });
const completion = assertion<Array<string | number>>({ name: 'settings.embeddingComplete', refusal: SETTINGS_EMBEDDING_CONFLICT, when: SWITCH_COMPLETION_SQL });
const ended = assertion<[id: string]>({ name: 'settings.embeddingEnded', refusal: SETTINGS_EMBEDDING_CONFLICT, when: `NOT EXISTS(SELECT 1 FROM embedding_switches WHERE slot='deployment' AND id=?)` });
const endSwitch = write<Array<string | number>>({ name: 'settings.endEmbeddingSwitch', sql:
  `DELETE FROM embedding_switches WHERE slot='deployment' AND ${SWITCH_COMPLETION_SQL}` });

export async function readSettingStates(db: RelationalStore, leaves: readonly string[], scope = ''): Promise<Map<string, SettingState>> {
  const [rows] = await readSet(db, states.bind(scope, JSON.stringify(leaves)));
  return new Map(rows.map(row => [row.leaf, row]));
}

export async function settingRevisions(db: RelationalStore, scope = ''): Promise<Record<string, number>> {
  const [rows] = await readSet(db, revisions.bind(scope));
  return Object.fromEntries(rows.map(row => [row.leaf, row.revision]));
}

function assertionFailure(error: unknown): 'conflict' | 'inactive' | null {
  if (refused(error, SETTINGS_PROJECT_INACTIVE)) return 'inactive';
  return refused(error, SETTINGS_REVISION_CONFLICT) || refused(error, SETTINGS_EMBEDDING_CONFLICT) ? 'conflict' : null;
}

/** Only the admitted settings capability supplies a change. Assertions precede every mutation. */
export async function persistSettings(db: RelationalStore, change: AdmittedSettingsChange,
  switchCompletion?: { sw: EmbeddingSwitch; now: number }): Promise<'applied' | 'conflict' | 'inactive'> {
  const scope = change.capability ? `capability:${change.project!}` : change.project ?? '';
  const statements: Bound[] = [unchanged.bind(scope, JSON.stringify(change.expected))];
  if (change.project !== undefined && !change.capability) statements.push(active.bind(change.project));
  if (change.embeddingEmpty !== undefined) statements.push(embedding.bind(change.embeddingEmpty ? 1 : 0));
  const end = switchCompletion === undefined ? null : switchCompletionParams(switchCompletion.sw, switchCompletion.now);
  if (end !== null) statements.push(completion.bind(...end));
  for (const part of change.parts) {
    if (change.capability) statements.push(capabilityPut.bind(change.project!, part.leaf, part.value === true ? 1 : 0, change.now, change.actor));
    else if (change.project !== undefined) statements.push(projectPut.bind(change.project, part.leaf, JSON.stringify(part.value), change.now, change.actor));
    else if (part.value === undefined) statements.push(remove.bind(part.leaf), reset.bind(part.leaf, change.now, change.actor));
    else statements.push(put.bind(part.leaf, JSON.stringify(part.value), change.now, change.actor, crypto.randomUUID()));
  }
  if (end !== null) statements.push(endSwitch.bind(...end), ended.bind(switchCompletion!.sw.id));
  try { await commit(db, ...statements); return 'applied'; }
  catch (error) {
    const refusal = assertionFailure(error);
    if (refusal === null) throw error;
    return refusal;
  }
}

/** Revision predicates for consumers that compose their own atomic admission. */
export function observedRevisionPredicate(expected: Readonly<Record<string, number>>, compact: boolean): { sql: string; params: unknown[] } {
  if (compact) return { sql: `NOT EXISTS(SELECT 1 FROM json_each(?) observed WHERE
    COALESCE((SELECT revision FROM setting_revisions WHERE scope='' AND leaf=observed.key),0)<>observed.value)`, params: [JSON.stringify(expected)] };
  return { sql: Object.keys(expected).map(() => `(COALESCE((SELECT revision FROM setting_revisions WHERE scope='' AND leaf=?),0)=?)`).join(' AND ') || '1',
    params: Object.entries(expected).flatMap(([leaf, revision]) => [leaf, revision]) };
}

export const projectCurationLimitSql = (project: string): string => `COALESCE((SELECT CAST(value AS INTEGER) FROM project_settings
  WHERE project_id=${project} AND leaf='${CURATION_DAILY_LIMIT_SETTING.leaf}'),${CURATION_DAILY_LIMIT_SETTING.rule.default})`;
const curationLimit = read<[project: string], { value: number }>({ name: 'settings.curationLimit', sql:
  `SELECT ${projectCurationLimitSql('?')} AS value` });
const projectEditor = read<[project: string], { active: number; capabilities: string; limit: number; revisions: string; capabilityRevisions: string }>({
  name: 'settings.projectEditor', sql: `SELECT
    EXISTS(SELECT 1 FROM projects WHERE project_id=?1 AND archived_at IS NULL) AS active,
    (SELECT json_group_object(capability,enabled) FROM project_capabilities WHERE project_id=?1) AS capabilities,
    ${projectCurationLimitSql('?1')} AS "limit",
    (SELECT json_group_object(leaf,revision) FROM setting_revisions WHERE scope=?1) AS revisions,
    (SELECT json_group_object(leaf,revision) FROM setting_revisions WHERE scope='capability:' || ?1) AS capabilityRevisions` });

export async function readCurationLimit(db: RelationalStore, project: string): Promise<number> {
  const [[row]] = await readSet(db, curationLimit.bind(project));
  if (row === undefined) throw new Error('Project setting was not read');
  return row.value;
}

export async function readProjectEditor(db: RelationalStore, project: string) {
  const [[row]] = await readSet(db, projectEditor.bind(project));
  if (row === undefined) throw new Error('Project settings were not read');
  return { active: row.active === 1, limit: row.limit,
    capabilities: JSON.parse(row.capabilities) as Record<string, number>,
    revisions: JSON.parse(row.revisions) as Record<string, number>,
    capabilityRevisions: JSON.parse(row.capabilityRevisions) as Record<string, number> };
}
