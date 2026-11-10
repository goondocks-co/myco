import { BUDGET_LEAF, BUDGET_DEFAULT_USD, BUDGET_MINIMUM_USD } from '../../core/budget-policy.js';
import { EXTRACTION_TASK } from '../../core/task-catalogue.js';
import type { RelationalStore } from '../../core/adapters.js';
import { first, read, rows } from '../index.js';

/**
 * SQL over settings and capabilities for admissions that run inside another module's batch, and the reads that resolve
 * them. One module knows how a leaf and a capability are stored; a check elsewhere reads through this rather than spelling
 * the query itself.
 */

/** Capabilities a Project must opt into; every other capability is on while its Project is live. */
export const DEFAULT_OFF_CAPABILITIES: readonly string[] = ['spore_curation', 'spore_curation_backfill'];

/**
 * SQL over one leaf's stored text. `admission` holds while the leaf is absent or carries anything but `off`; `read`
 * answers the row that carries it.
 */
export function leafOffChecks(leaf: string, off: string): { admission: { sql: string; params: string[] }; read: { sql: string; params: string[] } } {
  return {
    admission: { sql: `NOT EXISTS (SELECT 1 FROM deployment_settings WHERE leaf = ? AND value = ?)`, params: [leaf, off] },
    read: { sql: `SELECT 1 AS disabled FROM deployment_settings WHERE leaf = ? AND value = ?`, params: [leaf, off] },
  };
}

/** A Project accepting new intelligence work, with any additional admission bound inside the same read. */
function projectWorkSql(project: string, admission = ''): string {
  return `EXISTS (SELECT 1 FROM projects capability_project
    WHERE capability_project.project_id = ${project} AND capability_project.archived_at IS NULL ${admission})`;
}

/** A live Project's admission to intelligence work, for the Project the SQL expression `project` names. */
export const projectAcceptsWorkSql = (project: string): string => projectWorkSql(project);

/** A live Project's admission to intelligence work, bound as: Project. */
export const PROJECT_WORK_SQL = projectWorkSql('?');

/** Live Projects default on for context, maps and learning; curation capabilities require explicit opt-in. */
export function capabilityOnSql(project: string, capability: string): string {
  return projectWorkSql(project, `AND EXISTS (SELECT 1 FROM (SELECT ${capability} AS capability) admitted
    WHERE COALESCE((SELECT pc.enabled FROM project_capabilities pc
      WHERE pc.project_id = capability_project.project_id AND pc.capability = admitted.capability),
      CASE WHEN admitted.capability IN (${DEFAULT_OFF_CAPABILITIES.map(value => `'${value}'`).join(', ')}) THEN 0 ELSE 1 END) = 1)`);
}

/** An owner has explicitly enabled this Project capability. */
export function capabilityExplicitlyOnSql(project: string, capability: string): string {
  return `EXISTS (SELECT 1 FROM project_capabilities pc WHERE pc.project_id = ${project}
    AND pc.capability = ${capability} AND pc.enabled = 1)`;
}

/** A capability's admission condition, bound as: Project, capability. */
export const CAPABILITY_ON_SQL = capabilityOnSql('?', '?');

/** An absent task preference enables learning; invalid stored preferences retain its source. */
function taskEnabledSql(task: typeof EXTRACTION_TASK): string {
  return `NOT EXISTS (SELECT 1 FROM deployment_settings WHERE leaf = 'agent.tasks'
    AND CASE WHEN json_valid(value) THEN json_type(value, '$."${task}".enabled') = 'false' ELSE 0 END)`;
}

/** History learning requires an explicit Deployment opt-in; absence keeps it off. */
export function learningHistoryEnabledSql(): string {
  return `EXISTS (SELECT 1 FROM deployment_settings WHERE leaf = 'agent.learning_history_enabled'
    AND CASE WHEN json_valid(value) THEN json_type(value) = 'true' ELSE 0 END)`;
}

/** The Deployment's automatic learning switch and per-task preference apply together. */
export function learningEnabledSql(history = false): string {
  return `EXISTS (SELECT 1 FROM deployment_settings WHERE leaf = 'agent.scheduled_tasks_enabled'
      AND CASE WHEN json_valid(value) THEN json_type(value) = 'true' ELSE 0 END)
    AND ${taskEnabledSql(EXTRACTION_TASK)}${history ? ` AND ${learningHistoryEnabledSql()}` : ''}`;
}

/** The admitted effective value, evaluated by the automatic claim write. */
export const effectiveBudgetSql = (): string => `COALESCE((SELECT CASE WHEN json_valid(value) THEN
  CASE WHEN json_type(value) IN ('integer','real') AND json_extract(value,'$')>=${BUDGET_MINIMUM_USD} AND json_extract(value,'$')<=${Number.MAX_VALUE}
  THEN json_extract(value,'$') END END FROM deployment_settings WHERE leaf='${BUDGET_LEAF}'),${BUDGET_DEFAULT_USD})`;

/** The instant this Project opted into curation; missing and disabled switches admit no work. */
export function curationEnabledAtSql(project: string): string {
  return `(SELECT updated_at FROM project_capabilities WHERE project_id = ${project} AND capability = 'spore_curation' AND enabled = 1)`;
}

/** Whether any Project explicitly admits curation claims. */
export function curationAnyEnabledSql(): string {
  return `EXISTS (SELECT 1 FROM project_capabilities INDEXED BY idx_curation_projects
    WHERE capability='spore_curation' AND enabled=1 LIMIT 1)`;
}

const projectWork = read<[project: string], { enabled: number }>({ name: 'settings.projectWork', sql: `SELECT ${projectWorkSql('?1')} AS enabled` });
const capability = read<[project: string, capability: string], { enabled: number }>({ name: 'settings.capabilityOn', sql: `SELECT ${capabilityOnSql('?1', '?2')} AS enabled` });
const stored = read<[project: string, live: string], { capability: string; enabled: number }>({ name: 'settings.retiredCapabilities', sql:
  'SELECT capability,enabled FROM project_capabilities WHERE project_id=?1 AND capability NOT IN (SELECT value FROM json_each(?2))' });
const requested = read<[project: string, capabilities: string], { capability: string; enabled: number }>({ name: 'settings.capabilities', sql:
  `SELECT requested.value AS capability,${capabilityOnSql('?1', 'requested.value')} AS enabled FROM json_each(?2) requested` });
const nextCuration = read<[after: string], { project_id: string }>({ name: 'settings.nextCurationProject', sql: `SELECT c.project_id FROM spore_curation_changes c INDEXED BY idx_curation_changes_due
  WHERE c.dirty=1 AND c.project_id>?1 ORDER BY c.project_id LIMIT 1` });

/** Whether a Project accepts new intelligence work. */
export const projectWorkEnabled = async (db: RelationalStore, projectId: string): Promise<boolean> => (await first(db, projectWork.bind(projectId)))?.enabled === 1;
export const readCapabilityOn = async (db: RelationalStore, project: string, name: string): Promise<boolean> => (await first(db, capability.bind(project, name)))?.enabled === 1;
export const readRetiredCapabilities = async (db: RelationalStore, project: string, live: readonly string[]): Promise<Record<string, boolean>> =>
  Object.fromEntries((await rows(db, stored.bind(project, JSON.stringify(live)))).map(row => [row.capability, row.enabled === 1]));
export const readCapabilities = async (db: RelationalStore, project: string, names: readonly string[]): Promise<Record<string, boolean>> =>
  Object.fromEntries((await rows(db, requested.bind(project, JSON.stringify(names)))).map(row => [row.capability, row.enabled === 1]));
/** One dirty Project after a saved discovery cursor; admission is checked on that bounded candidate. */
export const nextCurationProject = (db: RelationalStore, after: string): Promise<{ project_id: string } | null> => first(db, nextCuration.bind(after));
