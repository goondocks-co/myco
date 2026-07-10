/**
 * OKF wiki row queries — the DB-resident wiki content model.
 *
 * Three tables: `okf_generations` (one row per synthesis run's wiki state),
 * `okf_pages` (head pointer per page), `okf_page_revisions` (full content
 * snapshot per page-generation — revisions are the truth). All three sync.
 *
 * These are RAW row operations. Every write MUST go through the `OkfStore`
 * capability (packages/myco/src/okf/store.ts) — the single sanctioned writer
 * that owns the okf_disabled gate, sanitization, transactions, and the
 * publish/blocked lifecycle. Do not call the insert/update functions here
 * from anywhere else.
 */

import { getDatabase } from '@myco/db/client.js';
import { appendProjectCondition, type ProjectScope } from '@myco/db/queries/project-scope.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type OkfGenerationStatus = 'draft' | 'published' | 'blocked' | 'superseded';

export interface OkfGenerationRow {
  id: string;
  project_id: string | null;
  machine_id: string;
  generation: number;
  run_id: string | null;
  status: OkfGenerationStatus;
  /** JSON WikiPlan — the plan→map handoff persisted as a row. */
  plan: string;
  page_count: number;
  log_summary: string;
  inputs_hash: string;
  /** JSON {headSha, maxVaultUpdatedAt} — the okf-synthesize-due baseline. */
  last_run_ref: string | null;
  /** JSON PublishFinding[] — populated when status is 'blocked'. */
  findings: string;
  created_at: number;
  updated_at: number;
  synced_at: number | null;
}

export interface OkfPageRow {
  id: string;
  project_id: string | null;
  machine_id: string;
  path: string;
  type: string;
  title: string;
  description: string;
  tags: string;
  status: 'active' | 'retired';
  generation: number;
  created_at: number;
  updated_at: number;
  synced_at: number | null;
}

export interface OkfPageRevisionRow {
  id: string;
  project_id: string | null;
  machine_id: string;
  page_id: string;
  page_generation: number;
  bundle_generation_id: string;
  action: string;
  rationale: string;
  frontmatter: string;
  body: string;
  created_at: number;
  synced_at: number | null;
}

const GENERATION_COLUMNS =
  'id, project_id, machine_id, generation, run_id, status, plan, page_count, log_summary, inputs_hash, last_run_ref, findings, created_at, updated_at, synced_at';
const PAGE_COLUMNS =
  'id, project_id, machine_id, path, type, title, description, tags, status, generation, created_at, updated_at, synced_at';
const REVISION_COLUMNS =
  'id, project_id, machine_id, page_id, page_generation, bundle_generation_id, action, rationale, frontmatter, body, created_at, synced_at';

// ---------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------

export function insertOkfGeneration(row: Omit<OkfGenerationRow, 'synced_at'>): OkfGenerationRow {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO okf_generations (
       id, project_id, machine_id, generation, run_id, status, plan,
       page_count, log_summary, inputs_hash, last_run_ref, findings,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.project_id, row.machine_id, row.generation, row.run_id,
    row.status, row.plan, row.page_count, row.log_summary, row.inputs_hash,
    row.last_run_ref, row.findings, row.created_at, row.updated_at,
  );
  const inserted = getOkfGenerationById(row.id)!;
  syncRow('okf_generations', inserted);
  return inserted;
}

export function updateOkfGeneration(
  id: string,
  patch: Partial<Pick<OkfGenerationRow, 'status' | 'page_count' | 'log_summary' | 'inputs_hash' | 'last_run_ref' | 'findings' | 'updated_at'>>,
): OkfGenerationRow | null {
  const db = getDatabase();
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${key} = ?`);
    params.push(value);
  }
  if (sets.length === 0) return getOkfGenerationById(id);
  params.push(id);
  db.prepare(`UPDATE okf_generations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const updated = getOkfGenerationById(id);
  if (updated) syncRow('okf_generations', updated);
  return updated;
}

export function getOkfGenerationById(id: string): OkfGenerationRow | null {
  const db = getDatabase();
  return (db.prepare(`SELECT ${GENERATION_COLUMNS} FROM okf_generations WHERE id = ?`).get(id) as OkfGenerationRow | undefined) ?? null;
}

/** Latest generation for the scope, optionally restricted to one or more statuses. */
export function latestOkfGeneration(
  scope: ProjectScope,
  statuses?: readonly OkfGenerationStatus[],
): OkfGenerationRow | null {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];
  appendProjectCondition(conditions, params, scope);
  if (statuses && statuses.length > 0) {
    conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return (db.prepare(
    `SELECT ${GENERATION_COLUMNS} FROM okf_generations ${where} ORDER BY generation DESC LIMIT 1`,
  ).get(...params) as OkfGenerationRow | undefined) ?? null;
}

/** Next per-project generation number. MUST be read inside the same transaction as the insert that uses it. */
export function nextOkfGenerationNumber(scope: ProjectScope): number {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];
  appendProjectCondition(conditions, params, scope);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const row = db.prepare(`SELECT MAX(generation) AS max_generation FROM okf_generations ${where}`).get(...params) as { max_generation: number | null };
  return (row.max_generation ?? 0) + 1;
}

/** Every non-published generation older than `keepId`, for the supersede sweep. */
export function listOpenOkfGenerations(scope: ProjectScope, excludeId?: string): OkfGenerationRow[] {
  const db = getDatabase();
  const conditions: string[] = ["status IN ('draft', 'blocked')"];
  const params: unknown[] = [];
  appendProjectCondition(conditions, params, scope);
  if (excludeId) {
    conditions.push('id != ?');
    params.push(excludeId);
  }
  return db.prepare(
    `SELECT ${GENERATION_COLUMNS} FROM okf_generations WHERE ${conditions.join(' AND ')} ORDER BY generation ASC`,
  ).all(...params) as OkfGenerationRow[];
}

// ---------------------------------------------------------------------------
// Pages + revisions
// ---------------------------------------------------------------------------

export function getOkfPageByPath(scope: ProjectScope, pagePath: string): OkfPageRow | null {
  const db = getDatabase();
  const conditions: string[] = ['path = ?'];
  const params: unknown[] = [pagePath];
  appendProjectCondition(conditions, params, scope);
  return (db.prepare(
    `SELECT ${PAGE_COLUMNS} FROM okf_pages WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as OkfPageRow | undefined) ?? null;
}

export function listOkfPages(scope: ProjectScope, status: 'active' | 'retired' | 'all' = 'active'): OkfPageRow[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }
  appendProjectCondition(conditions, params, scope);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT ${PAGE_COLUMNS} FROM okf_pages ${where} ORDER BY path ASC`).all(...params) as OkfPageRow[];
}

/** Get one wiki page head by its `okf_pages.id` — the content-claim system's
 *  artifact lookup (a claim's `artifact_id` is this id, not the bundle path). */
export function getOkfPageById(scope: ProjectScope, id: string): OkfPageRow | null {
  const db = getDatabase();
  const conditions: string[] = ['id = ?'];
  const params: unknown[] = [id];
  appendProjectCondition(conditions, params, scope);
  return (db.prepare(
    `SELECT ${PAGE_COLUMNS} FROM okf_pages WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as OkfPageRow | undefined) ?? null;
}

export function insertOkfPage(row: Omit<OkfPageRow, 'synced_at'>): OkfPageRow {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO okf_pages (
       id, project_id, machine_id, path, type, title, description, tags,
       status, generation, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.project_id, row.machine_id, row.path, row.type, row.title,
    row.description, row.tags, row.status, row.generation, row.created_at, row.updated_at,
  );
  const inserted = db.prepare(`SELECT ${PAGE_COLUMNS} FROM okf_pages WHERE id = ?`).get(row.id) as OkfPageRow;
  syncRow('okf_pages', inserted);
  return inserted;
}

export function updateOkfPage(
  id: string,
  patch: Partial<Pick<OkfPageRow, 'type' | 'title' | 'description' | 'tags' | 'status' | 'generation' | 'updated_at'>>,
): OkfPageRow | null {
  const db = getDatabase();
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${key} = ?`);
    params.push(value);
  }
  if (sets.length === 0) return null;
  params.push(id);
  db.prepare(`UPDATE okf_pages SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const updated = (db.prepare(`SELECT ${PAGE_COLUMNS} FROM okf_pages WHERE id = ?`).get(id) as OkfPageRow | undefined) ?? null;
  if (updated) syncRow('okf_pages', updated);
  return updated;
}

export function insertOkfPageRevision(row: Omit<OkfPageRevisionRow, 'synced_at'>): OkfPageRevisionRow {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO okf_page_revisions (
       id, project_id, machine_id, page_id, page_generation,
       bundle_generation_id, action, rationale, frontmatter, body, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.project_id, row.machine_id, row.page_id, row.page_generation,
    row.bundle_generation_id, row.action, row.rationale, row.frontmatter,
    row.body, row.created_at,
  );
  const inserted = db.prepare(`SELECT ${REVISION_COLUMNS} FROM okf_page_revisions WHERE id = ?`).get(row.id) as OkfPageRevisionRow;
  syncRow('okf_page_revisions', inserted);
  return inserted;
}

export function updateOkfPageRevisionBody(id: string, body: string): OkfPageRevisionRow | null {
  const db = getDatabase();
  db.prepare('UPDATE okf_page_revisions SET body = ? WHERE id = ?').run(body, id);
  const updated = (db.prepare(`SELECT ${REVISION_COLUMNS} FROM okf_page_revisions WHERE id = ?`).get(id) as OkfPageRevisionRow | undefined) ?? null;
  if (updated) syncRow('okf_page_revisions', updated);
  return updated;
}

/** All revisions written against one bundle generation, path-ordered via their page head. */
export function listRevisionsForGeneration(bundleGenerationId: string): Array<OkfPageRevisionRow & { path: string }> {
  const db = getDatabase();
  return db.prepare(
    `SELECT r.id, r.project_id, r.machine_id, r.page_id, r.page_generation,
            r.bundle_generation_id, r.action, r.rationale, r.frontmatter, r.body,
            r.created_at, r.synced_at, p.path AS path
     FROM okf_page_revisions r
     JOIN okf_pages p ON p.id = r.page_id
     WHERE r.bundle_generation_id = ?
     ORDER BY p.path ASC`,
  ).all(bundleGenerationId) as Array<OkfPageRevisionRow & { path: string }>;
}

/** Latest revision for a page head (its current content). */
export function latestRevisionForPage(pageId: string): OkfPageRevisionRow | null {
  const db = getDatabase();
  return (db.prepare(
    `SELECT ${REVISION_COLUMNS} FROM okf_page_revisions WHERE page_id = ? ORDER BY page_generation DESC LIMIT 1`,
  ).get(pageId) as OkfPageRevisionRow | undefined) ?? null;
}

/**
 * Revision at a SPECIFIC `page_generation` — the content-claim materialize
 * path (design §4) writes the claim's PINNED generation, not necessarily the
 * page's current head generation: a claim can be refreshed independently of
 * further edits landing on the page after it was taken. Mirrors
 * `getSkillContentAtGeneration` (`skill-lineage.ts`)'s unscoped lookup —
 * `pageId` is a UUID FK the caller already resolved under its own tenancy
 * scope via `getOkfPageById`.
 */
export function getOkfPageRevisionAtGeneration(pageId: string, pageGeneration: number): OkfPageRevisionRow | null {
  const db = getDatabase();
  return (db.prepare(
    `SELECT ${REVISION_COLUMNS} FROM okf_page_revisions
      WHERE page_id = ? AND page_generation = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
  ).get(pageId, pageGeneration) as OkfPageRevisionRow | undefined) ?? null;
}

/**
 * Every revision recorded for one page (its full page_generation history),
 * newest first — the content-claim system's remote content-fetch surface:
 * an attached member dials the host for this list and picks the claimed
 * generation client-side, mirroring `listLineageForSkill` for skills.
 */
export function listRevisionsForPage(scope: ProjectScope, pageId: string, limit = 200): OkfPageRevisionRow[] {
  const db = getDatabase();
  const conditions: string[] = ['page_id = ?'];
  const params: unknown[] = [pageId];
  appendProjectCondition(conditions, params, scope);
  return db.prepare(
    `SELECT ${REVISION_COLUMNS} FROM okf_page_revisions WHERE ${conditions.join(' AND ')}
      ORDER BY page_generation DESC LIMIT ?`,
  ).all(...params, limit) as OkfPageRevisionRow[];
}
