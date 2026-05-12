/**
 * Full-text search using SQLite FTS5.
 *
 * Searches prompt_batches and activities via their FTS5 virtual tables.
 * Semantic search (vector similarity) is handled by the external VectorStore —
 * this module covers text-based retrieval only.
 *
 * All queries use parameterized placeholders throughout.
 */

import { getDatabase, type Database } from '@myco/db/client.js';
import {
  SEARCH_RESULTS_DEFAULT_LIMIT,
  SEARCH_PREVIEW_CHARS,
} from '@myco/constants.js';
import { appendProjectCondition, projectScopeClause, type ProjectScope } from '@myco/db/queries/project-scope.js';
import type { VectorSearchResult } from '@myco/daemon/embedding/types.js';
import { parseCanopyRecordId } from '@myco/canopy/hydrate.js';
import {
  releaseStateAnnotationMap,
  releaseStateField,
  type ReleaseStateAnnotation,
} from '@myco/release-provenance/annotations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All result types that can appear in search results. */
export type SearchResultType =
  | 'session'
  | 'spore'
  | 'plan'
  | 'artifact'
  | 'prompt_batch'
  | 'activity'
  | 'skill'
  | 'canopy';

/**
 * A single result returned from full-text or semantic search.
 *
 * The `canopy` variant carries extra per-file fields (`project_id`, `path`,
 * `language`, `llm_description`) so the unified search renderer can display
 * canopy hits the same way as the dedicated Canopy facet without a separate
 * code path. The shared fields (`title`, `preview`) are populated for the
 * generic renderer; canopy-specific fields are mirrored alongside them so
 * the canopy result row can read them directly.
 */
export interface SearchResult {
  id: string;
  type: SearchResultType;
  title: string;
  preview: string;
  score: number;
  session_id?: string;
  // Canopy-specific fields (populated when `type === 'canopy'`).
  project_id?: string | null;
  path?: string | null;
  language?: string | null;
  llm_description?: string | null;
  release_state?: ReleaseStateAnnotation;
}

/** Options for fullTextSearch. */
export interface SearchOptions {
  /** Restrict results to a single type. */
  type?: string;
  /** Maximum number of results to return (default: SEARCH_RESULTS_DEFAULT_LIMIT). */
  limit?: number;
  /**
   * When explicitly `false`, hide results belonging to sessions still in
   * `status = 'active'` (and active sessions themselves). Intelligence-task
   * reads opt in to this; UI/CLI callers leave it unset.
   */
  includeActive?: boolean;
  /** Project scope for project-scoped tables. */
  scope: ProjectScope;
  /** Optional database handle for request-scoped Grove reads. Defaults to the process singleton. */
  db?: Database;
}


// ---------------------------------------------------------------------------
// Query sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a free-form search string for FTS5 MATCH.
 *
 * FTS5 MATCH treats several characters as operators: `-` means NOT, `:` is
 * a column filter, `"..."` is a literal phrase, `+` means must-match, `(`/`)`
 * group, `*` is a prefix wildcard, and unquoted hyphens in identifiers
 * (`skill-evolve-inventory`) or slashes in paths (`packages/myco/src/loader.ts`)
 * are routinely rejected as syntax errors.
 *
 * Natural-language callers (agents querying the vault, users typing in a UI
 * search box) don't know or care about FTS5 syntax — they expect their
 * string to "just work." This helper tokenizes on whitespace and wraps any
 * token containing non-word characters in double quotes, turning it into
 * a literal phrase search. Plain alphanumeric/underscore tokens are left
 * unquoted so they AND together with their neighbours normally.
 *
 * Examples:
 *   "packages/myco/src/loader.ts tools"  → "\"packages/myco/src/loader.ts\" tools"
 *   "skill-evolve merge_candidates"       → "\"skill-evolve\" merge_candidates"
 *   "plain words"                         → "plain words"
 *
 * Callers that DO want FTS5 operator semantics should skip this helper
 * and pass their own pre-formed MATCH expression to `fullTextSearch`.
 */
export function sanitizeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter((tok) => tok.length > 0)
    .map((tok) => /^[\w]+$/.test(tok) ? tok : `"${tok.replace(/"/g, '""')}"`)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Full-text search across capture tables using SQLite FTS5.
 *
 * Searches prompt_batches (indexed on user_prompt) and activities (indexed
 * on tool_name, tool_input, file_path). The raw query string is passed
 * directly to FTS5 MATCH — callers should sanitize if needed.
 *
 * FTS5 `rank` values are negative (lower = better match). This function
 * converts them to positive scores via `Math.abs()` so higher = better
 * in the returned results.
 *
 * When `options.type` is specified, only the matching table branch is queried.
 *
 * @param query — search string (FTS5 MATCH syntax)
 * @param options — optional type filter and result limit
 * @returns SearchResult[] ordered by score DESC
 */
export function fullTextSearch(
  query: string,
  options: SearchOptions,
): SearchResult[] {
  const db = options.db ?? getDatabase();
  const limit = options.limit ?? SEARCH_RESULTS_DEFAULT_LIMIT;
  const typeFilter = options.type;
  const excludeActive = options.includeActive === false;

  const results: SearchResult[] = [];

  // -- prompt_batches branch ------------------------------------------------
  if (typeFilter === undefined || typeFilter === 'prompt_batch') {
    const conditions = ['prompt_batches_fts MATCH ?'];
    const params: unknown[] = [query];
    if (excludeActive) {
      conditions.push(`EXISTS (SELECT 1 FROM sessions s WHERE s.id = pb.session_id AND s.status != 'active')`);
    }
    appendProjectCondition(conditions, params, options.scope, 'pb');
    const batchRows = db.prepare(
      `SELECT pb.id, pb.prompt_number, pb.session_id,
              substr(COALESCE(pb.user_prompt, '') || ' ' || COALESCE(pb.response_summary, ''), 1, ?) AS preview,
              fts.rank
       FROM prompt_batches_fts fts
       JOIN prompt_batches pb ON pb.id = fts.rowid
       WHERE ${conditions.join(' AND ')}
       ORDER BY fts.rank
       LIMIT ?`
    ).all(SEARCH_PREVIEW_CHARS, ...params, limit) as Array<{
      id: number;
      prompt_number: number | null;
      session_id: string | null;
      preview: string;
      rank: number;
    }>;

    const batchReleaseStates = releaseStateAnnotationMap(
      'prompt_batches', batchRows.map((r) => String(r.id)), options.scope, db,
    );
    for (const row of batchRows) {
      results.push({
        ...releaseStateField(batchReleaseStates.get(String(row.id))),
        id: String(row.id),
        type: 'prompt_batch',
        title: row.prompt_number != null
          ? `Batch #${row.prompt_number}`
          : `Batch ${row.id}`,
        preview: row.preview,
        score: Math.abs(row.rank),
        ...(row.session_id != null ? { session_id: row.session_id } : {}),
      });
    }
  }

  // -- activities branch ----------------------------------------------------
  if (typeFilter === undefined || typeFilter === 'activity') {
    const conditions = ['activities_fts MATCH ?'];
    const params: unknown[] = [query];
    if (excludeActive) {
      conditions.push(`EXISTS (SELECT 1 FROM sessions s WHERE s.id = a.session_id AND s.status != 'active')`);
    }
    appendProjectCondition(conditions, params, options.scope, 'a');
    const activityRows = db.prepare(
      `SELECT a.id, a.tool_name, a.tool_input, a.file_path, a.session_id,
              fts.rank
       FROM activities_fts fts
       JOIN activities a ON a.id = fts.rowid
       WHERE ${conditions.join(' AND ')}
       ORDER BY fts.rank
       LIMIT ?`
    ).all(...params, limit) as Array<{
      id: number;
      tool_name: string;
      tool_input: string | null;
      file_path: string | null;
      session_id: string | null;
      rank: number;
    }>;

    const activitySessionIds = activityRows
      .map((r) => r.session_id)
      .filter((id): id is string => id != null);
    const activityReleaseStates = releaseStateAnnotationMap(
      'sessions', activitySessionIds, options.scope, db,
    );
    for (const row of activityRows) {
      const preview = (row.tool_input ?? row.file_path ?? '').slice(0, SEARCH_PREVIEW_CHARS);
      results.push({
        ...releaseStateField(row.session_id ? activityReleaseStates.get(row.session_id) : null),
        id: String(row.id),
        type: 'activity',
        title: row.tool_name,
        preview,
        score: Math.abs(row.rank),
        ...(row.session_id != null ? { session_id: row.session_id } : {}),
      });
    }
  }

  // -- spores branch --------------------------------------------------------
  if (typeFilter === undefined || typeFilter === 'spore') {
    // Spores may have a NULL session_id (agent-authored, no source session),
    // which are always kept; only spores attached to still-active sessions
    // are excluded when the gate is on.
    const conditions = ['spores_fts MATCH ?'];
    const params: unknown[] = [query];
    if (excludeActive) {
      conditions.push(`(s.session_id IS NULL OR EXISTS (SELECT 1 FROM sessions ss WHERE ss.id = s.session_id AND ss.status != 'active'))`);
    }
    appendProjectCondition(conditions, params, options.scope, 's');
    const sporeRows = db.prepare(
      `SELECT s.id, s.observation_type, s.session_id,
              substr(COALESCE(s.content, ''), 1, ?) AS preview,
              fts.rank
       FROM spores_fts fts
       JOIN spores s ON s.rowid = fts.rowid
       WHERE ${conditions.join(' AND ')}
       ORDER BY fts.rank
       LIMIT ?`
    ).all(SEARCH_PREVIEW_CHARS, ...params, limit) as Array<{
      id: string;
      observation_type: string;
      session_id: string | null;
      preview: string;
      rank: number;
    }>;

    const sporeReleaseStates = releaseStateAnnotationMap(
      'spores', sporeRows.map((r) => String(r.id)), options.scope, db,
    );
    for (const row of sporeRows) {
      results.push({
        ...releaseStateField(sporeReleaseStates.get(String(row.id))),
        id: String(row.id),
        type: 'spore',
        title: row.observation_type,
        preview: row.preview,
        score: Math.abs(row.rank),
        ...(row.session_id != null ? { session_id: row.session_id } : {}),
      });
    }
  }

  // -- sessions branch ------------------------------------------------------
  if (typeFilter === undefined || typeFilter === 'session') {
    const conditions = ['sessions_fts MATCH ?'];
    const params: unknown[] = [query];
    if (excludeActive) {
      conditions.push(`s.status != 'active'`);
    }
    appendProjectCondition(conditions, params, options.scope, 's');
    const sessionRows = db.prepare(
      `SELECT s.id, s.title,
              substr(COALESCE(s.summary, s.title, ''), 1, ?) AS preview,
              fts.rank
       FROM sessions_fts fts
       JOIN sessions s ON s.rowid = fts.rowid
       WHERE ${conditions.join(' AND ')}
       ORDER BY fts.rank
       LIMIT ?`
    ).all(SEARCH_PREVIEW_CHARS, ...params, limit) as Array<{
      id: string;
      title: string | null;
      preview: string;
      rank: number;
    }>;

    const sessionReleaseStates = releaseStateAnnotationMap(
      'sessions', sessionRows.map((r) => String(r.id)), options.scope, db,
    );
    for (const row of sessionRows) {
      results.push({
        ...releaseStateField(sessionReleaseStates.get(String(row.id))),
        id: String(row.id),
        type: 'session',
        title: row.title ?? `Session ${row.id.slice(-6)}`,
        preview: row.preview,
        score: Math.abs(row.rank),
      });
    }
  }

  // Sort combined results by score DESC and apply limit.
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Hydration — convert VectorSearchResults into SearchResults
// ---------------------------------------------------------------------------

/** Row shape returned from sessions table for hydration. */
interface SessionRow {
  id: string;
  title: string | null;
  summary: string | null;
  session_id?: undefined;
}

/** Row shape returned from spores table for hydration. */
interface SporeRow {
  id: string;
  observation_type: string;
  content: string;
  session_id: string | null;
}

/** Row shape returned from plans table for hydration. */
interface PlanRow {
  id: string;
  title: string | null;
  content: string | null;
  session_id: string | null;
}

/** Row shape returned from artifacts table for hydration. */
interface ArtifactRow {
  id: string;
  title: string;
  content: string | null;
}

/**
 * Hydrate vector search results into SearchResults by fetching full records
 * from the record store.
 *
 * Groups results by namespace, queries each table for the relevant IDs, then
 * maps them into SearchResult format with titles and previews.
 */
export function hydrateSearchResults(
  vectorResults: VectorSearchResult[],
  options: { scope: ProjectScope; db?: Database },
): SearchResult[] {
  if (vectorResults.length === 0) return [];

  const db = options.db ?? getDatabase();
  const results: SearchResult[] = [];

  // Group result IDs by namespace
  const byNamespace = new Map<string, VectorSearchResult[]>();
  for (const vr of vectorResults) {
    const group = byNamespace.get(vr.namespace) ?? [];
    group.push(vr);
    byNamespace.set(vr.namespace, group);
  }

  // Use json_each so statement text remains compact even for large result sets.
  const sessionScope = projectScopeClause(options.scope);
  const sporeScope = projectScopeClause(options.scope);
  const planScope = projectScopeClause(options.scope);
  const artifactScope = projectScopeClause(options.scope);
  const skillScope = projectScopeClause(options.scope);

  // --- sessions ---
  const sessionResults = byNamespace.get('sessions');
  if (sessionResults && sessionResults.length > 0) {
    const ids = sessionResults.map((r) => r.id);
    const rows = db.prepare(
      `SELECT id, title, summary
         FROM sessions
        WHERE id IN (SELECT value FROM json_each(?))${sessionScope.sql}`,
    ).all(JSON.stringify(ids), ...sessionScope.params) as SessionRow[];

    const rowMap = new Map(rows.map((r) => [r.id, r]));
    const sessionReleaseStates = releaseStateAnnotationMap('sessions', ids, options.scope, db);
    for (const vr of sessionResults) {
      const row = rowMap.get(vr.id);
      if (!row) continue;
      results.push({
        ...releaseStateField(sessionReleaseStates.get(row.id)),
        id: row.id,
        type: 'session',
        title: row.title ?? `Session ${row.id.slice(-6)}`,
        preview: (row.summary ?? '').slice(0, SEARCH_PREVIEW_CHARS),
        score: vr.similarity,
      });
    }
  }

  // --- spores ---
  const sporeResults = byNamespace.get('spores');
  if (sporeResults && sporeResults.length > 0) {
    const ids = sporeResults.map((r) => r.id);
    const rows = db.prepare(
      `SELECT id, observation_type, content, session_id
         FROM spores
        WHERE id IN (SELECT value FROM json_each(?))${sporeScope.sql}`,
    ).all(JSON.stringify(ids), ...sporeScope.params) as SporeRow[];

    const rowMap = new Map(rows.map((r) => [r.id, r]));
    const sporeReleaseStates = releaseStateAnnotationMap('spores', ids, options.scope, db);
    for (const vr of sporeResults) {
      const row = rowMap.get(vr.id);
      if (!row) continue;
      results.push({
        ...releaseStateField(sporeReleaseStates.get(row.id)),
        id: row.id,
        type: 'spore',
        title: row.observation_type,
        preview: row.content.slice(0, SEARCH_PREVIEW_CHARS),
        score: vr.similarity,
        ...(row.session_id != null ? { session_id: row.session_id } : {}),
      });
    }
  }

  // --- plans ---
  const planResults = byNamespace.get('plans');
  if (planResults && planResults.length > 0) {
    const ids = planResults.map((r) => r.id);
    const rows = db.prepare(
      `SELECT id, title, content, session_id
         FROM plans
        WHERE id IN (SELECT value FROM json_each(?))${planScope.sql}`,
    ).all(JSON.stringify(ids), ...planScope.params) as PlanRow[];

    const rowMap = new Map(rows.map((r) => [r.id, r]));
    const planReleaseStates = releaseStateAnnotationMap('plans', ids, options.scope, db);
    for (const vr of planResults) {
      const row = rowMap.get(vr.id);
      if (!row) continue;
      results.push({
        ...releaseStateField(planReleaseStates.get(row.id)),
        id: row.id,
        type: 'plan',
        title: row.title ?? `Plan ${row.id.slice(-6)}`,
        preview: (row.content ?? '').slice(0, SEARCH_PREVIEW_CHARS),
        score: vr.similarity,
        ...(row.session_id != null ? { session_id: row.session_id } : {}),
      });
    }
  }

  // --- artifacts ---
  const artifactResults = byNamespace.get('artifacts');
  if (artifactResults && artifactResults.length > 0) {
    const ids = artifactResults.map((r) => r.id);
    const rows = db.prepare(
      `SELECT id, title, content
         FROM artifacts
        WHERE id IN (SELECT value FROM json_each(?))${artifactScope.sql}`,
    ).all(JSON.stringify(ids), ...artifactScope.params) as ArtifactRow[];

    const rowMap = new Map(rows.map((r) => [r.id, r]));
    const artifactReleaseStates = releaseStateAnnotationMap('artifacts', ids, options.scope, db);
    for (const vr of artifactResults) {
      const row = rowMap.get(vr.id);
      if (!row) continue;
      results.push({
        ...releaseStateField(artifactReleaseStates.get(row.id)),
        id: row.id,
        type: 'artifact',
        title: row.title,
        preview: (row.content ?? '').slice(0, SEARCH_PREVIEW_CHARS),
        score: vr.similarity,
      });
    }
  }

  // --- canopy_entries ---
  // Canopy vector rows carry the synthesized id `${project_id}:${path}` (split
  // on the first colon — paths may contain colons, project_ids cannot). We
  // parse each id back into `(project_id, path)` and look up the matching row
  // in `canopy_entries` using a single composite-key WHERE IN VALUES query so
  // the unified `All` facet can return canopy hits alongside sessions/spores
  // without an N+1 round trip.
  const canopyResults = byNamespace.get('canopy_entries');
  if (canopyResults && canopyResults.length > 0) {
    const parsed: Array<{ id: string; projectId: string; path: string; vr: VectorSearchResult }> = [];
    for (const vr of canopyResults) {
      const p = parseCanopyRecordId(vr.id);
      if (p) parsed.push({ id: vr.id, projectId: p.projectId, path: p.path, vr });
    }
    const scopedParsed = parsed.filter((p) => {
      if (options.scope.kind === 'all') return true;
      if (options.scope.kind === 'global') return false;
      return p.projectId === options.scope.id;
    });
    if (scopedParsed.length > 0) {
      const placeholders = scopedParsed.map(() => '(?, ?)').join(', ');
      const args = scopedParsed.flatMap((p) => [p.projectId, p.path]);
      const rows = db.prepare(
        `SELECT project_id, path, language, llm_description
           FROM canopy_entries
          WHERE (project_id, path) IN (VALUES ${placeholders})`,
      ).all(...args) as Array<{
        project_id: string;
        path: string;
        language: string | null;
        llm_description: string | null;
      }>;

      const rowMap = new Map(rows.map((r) => [`${r.project_id}:${r.path}`, r]));
      const canopyReleaseStates = releaseStateAnnotationMap(
        'canopy_entries', scopedParsed.map((p) => p.id), options.scope, db,
      );
      for (const p of scopedParsed) {
        const row = rowMap.get(p.id);
        if (!row) continue;
        results.push({
          ...releaseStateField(canopyReleaseStates.get(p.id)),
          id: p.id,
          type: 'canopy',
          title: row.path,
          preview: (row.llm_description ?? '').slice(0, SEARCH_PREVIEW_CHARS),
          score: p.vr.similarity,
          project_id: row.project_id,
          path: row.path,
          language: row.language,
          llm_description: row.llm_description,
        });
      }
    }
  }

  // --- skill_records ---
  const skillResults = byNamespace.get('skill_records');
  if (skillResults && skillResults.length > 0) {
    const ids = skillResults.map((r) => r.id);
    const rows = db.prepare(
      `SELECT id, name, display_name, description
         FROM skill_records
        WHERE id IN (SELECT value FROM json_each(?))${skillScope.sql}`,
    ).all(JSON.stringify(ids), ...skillScope.params) as Array<{ id: string; name: string; display_name: string; description: string }>;

    const rowMap = new Map(rows.map((r) => [r.id, r]));
    const skillReleaseStates = releaseStateAnnotationMap('skill_records', ids, options.scope, db);
    for (const vr of skillResults) {
      const row = rowMap.get(vr.id);
      if (!row) continue;
      results.push({
        ...releaseStateField(skillReleaseStates.get(row.id)),
        id: row.id,
        type: 'skill',
        title: row.display_name || row.name,
        preview: row.description.slice(0, SEARCH_PREVIEW_CHARS),
        score: vr.similarity,
      });
    }
  }

  // Preserve the original similarity-based ordering from vector search
  results.sort((a, b) => b.score - a.score);
  return results;
}
