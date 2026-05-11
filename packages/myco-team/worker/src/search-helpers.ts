/**
 * Shared search helpers used by both the REST /search endpoint and MCP myco_search tool.
 */

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SEARCH_OVERFETCH_MULTIPLIER = 4;
export const MAX_EMBEDDING_TEXT_CHARS = 8000;

export interface TeamVectorMetadata {
  table: string;
  id: string;
  machine_id: string;
  project_id?: string;
  status?: string;
  observation_type?: string;
  created_at?: number;
  session_id?: string;
  source_path?: string;
  name?: string;
  project_root?: string;
  release_state?: string;
  release_confidence?: string;
  release_basis_kind?: string;
  release_checked_at?: number;
}

export interface SemanticSearchArgs {
  query: string;
  types?: string[];
  limit?: number;
  status?: string;
  observation_type?: string;
  since?: number;
  until?: number;
  session_id?: string;
  source_path?: string;
  name?: string;
  project_id?: string;
  release_state?: string;
  release_confidence?: string;
}

/**
 * Embed text via Workers AI (bge-m3) and return the vector.
 */
export async function embedText(ai: Ai, text: string): Promise<number[]> {
  const preparedText = text.length > MAX_EMBEDDING_TEXT_CHARS
    ? `${text.slice(0, MAX_EMBEDDING_TEXT_CHARS)}

[truncated for embedding]`
    : text;
  const result = await ai.run('@cf/baai/bge-m3', { text: [preparedText] }) as { data: number[][] };
  return result.data[0];
}

export interface HydratedResult {
  id: string;
  machine_id: string;
  type: string;
  score: number;
  data: Record<string, unknown>;
  metadata: TeamVectorMetadata;
}

interface VectorMatch {
  metadata: TeamVectorMetadata;
  score: number;
}

interface ReleaseStateRow {
  machine_id: string;
  record_id: string;
  state: string;
  confidence: string;
  basis_kind?: string | null;
  basis_ref?: string | null;
  checked_at: number;
  reason?: string | null;
}

const RELEASE_STATE_NAMESPACES = new Set([
  'sessions',
  'spores',
  'plans',
  'artifacts',
  'skill_records',
]);

function isTeamVectorMetadata(metadata: unknown): metadata is TeamVectorMetadata {
  if (!metadata || typeof metadata !== 'object') return false;
  const candidate = metadata as Record<string, unknown>;
  return typeof candidate.table === 'string'
    && typeof candidate.id === 'string'
    && typeof candidate.machine_id === 'string';
}

function clampLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function matchesFilters(metadata: TeamVectorMetadata, args: Omit<SemanticSearchArgs, 'query' | 'limit'>): boolean {
  if (args.types && args.types.length > 0 && !args.types.includes(metadata.table)) return false;
  if (args.status && metadata.status !== args.status) return false;
  if (args.observation_type && metadata.observation_type !== args.observation_type) return false;
  if (args.session_id && metadata.session_id !== args.session_id) return false;
  if (args.source_path && metadata.source_path !== args.source_path) return false;
  if (args.name && metadata.name !== args.name) return false;
  if (args.project_id && metadata.project_id !== args.project_id) return false;

  const createdAt = typeof metadata.created_at === 'number' ? metadata.created_at : undefined;
  if (args.since !== undefined && (createdAt === undefined || createdAt < args.since)) return false;
  if (args.until !== undefined && (createdAt === undefined || createdAt > args.until)) return false;

  return true;
}

function releaseStateKey(recordId: unknown, machineId: unknown): string {
  return `${String(recordId)}:${String(machineId)}`;
}

function releaseStateAnnotation(row: ReleaseStateRow): Record<string, unknown> {
  return {
    state: row.state,
    confidence: row.confidence,
    basis_kind: row.basis_kind ?? null,
    basis_ref: row.basis_ref ?? null,
    checked_at: row.checked_at,
    reason: row.reason ?? null,
  };
}

async function fetchReleaseStateMap(
  db: D1Database,
  table: string,
  items: Array<{ id: string; machine_id: string }>,
): Promise<Map<string, ReleaseStateRow>> {
  if (!RELEASE_STATE_NAMESPACES.has(table) || items.length === 0) {
    return new Map();
  }
  const placeholders = items.map(() => '(?, ?)').join(', ');
  const binds = items.flatMap((item) => [item.id, item.machine_id]);
  const { results } = await db.prepare(
    `SELECT machine_id, record_id, state, confidence, basis_kind, basis_ref, checked_at, reason
       FROM knowledge_release_state
      WHERE namespace = ?
        AND (record_id, machine_id) IN (VALUES ${placeholders})`,
  ).bind(table, ...binds).all<ReleaseStateRow>();

  const map = new Map<string, ReleaseStateRow>();
  for (const row of results ?? []) {
    map.set(releaseStateKey(row.record_id, row.machine_id), row);
  }
  return map;
}

function withReleaseState(
  row: Record<string, unknown>,
  metadata: TeamVectorMetadata,
  releaseState: ReleaseStateRow | undefined,
): { data: Record<string, unknown>; metadata: TeamVectorMetadata } {
  if (!releaseState) return { data: row, metadata };
  const annotation = releaseStateAnnotation(releaseState);
  return {
    data: { ...row, release_state: annotation },
    metadata: {
      ...metadata,
      release_state: releaseState.state,
      release_confidence: releaseState.confidence,
      ...(releaseState.basis_kind ? { release_basis_kind: releaseState.basis_kind } : {}),
      release_checked_at: releaseState.checked_at,
    },
  };
}

function matchesReleaseFilters(result: HydratedResult, args: SemanticSearchArgs): boolean {
  if (!args.release_state && !args.release_confidence) return true;
  const annotation = result.data.release_state as Record<string, unknown> | undefined;
  if (!annotation) return false;
  if (args.release_state && annotation.state !== args.release_state) return false;
  if (args.release_confidence && annotation.confidence !== args.release_confidence) return false;
  return true;
}

/**
 * Group Vectorize matches by table and batch-hydrate each group from D1.
 * Queries run in parallel across tables.
 */
export async function hydrateVectorMatches(
  db: D1Database,
  matches: VectorMatch[],
): Promise<HydratedResult[]> {
  // Group by table
  const groups = new Map<string, Array<{ id: string; machine_id: string; score: number; metadata: TeamVectorMetadata }>>();
  for (const match of matches) {
    const { table, id, machine_id } = match.metadata;
    const group = groups.get(table) ?? [];
    group.push({ id, machine_id, score: match.score, metadata: match.metadata });
    groups.set(table, group);
  }

  // Hydrate all tables in parallel
  const hydrationPromises = [...groups.entries()].map(async ([table, items]) => {
    const placeholders = items.map(() => '(?, ?)').join(', ');
    const binds = items.flatMap((item) => [item.id, item.machine_id]);
    const { results: rows } = await db.prepare(
      `SELECT * FROM ${table} WHERE (id, machine_id) IN (VALUES ${placeholders})`,
    ).bind(...binds).all();

    const rowMap = new Map<string, Record<string, unknown>>();
    for (const row of rows as Record<string, unknown>[]) {
      rowMap.set(`${row.id}:${row.machine_id}`, row);
    }
    const releaseStateMap = await fetchReleaseStateMap(db, table, items);

    const results: HydratedResult[] = [];
    for (const item of items) {
      const row = rowMap.get(`${item.id}:${item.machine_id}`);
      if (row) {
        const annotated = withReleaseState(
          row,
          item.metadata,
          releaseStateMap.get(releaseStateKey(item.id, item.machine_id)),
        );
        results.push({
          id: item.id,
          machine_id: item.machine_id,
          type: table,
          score: item.score,
          data: annotated.data,
          metadata: annotated.metadata,
        });
      }
    }
    return results;
  });

  const resultArrays = await Promise.all(hydrationPromises);
  const results = resultArrays.flat();
  results.sort((a, b) => b.score - a.score);
  return results;
}

export async function searchKnowledge(
  db: D1Database,
  vectorize: VectorizeIndex,
  ai: Ai,
  args: SemanticSearchArgs,
): Promise<HydratedResult[]> {
  const limit = clampLimit(args.limit);
  const queryTopK = Math.min(MAX_LIMIT, Math.max(limit, limit * SEARCH_OVERFETCH_MULTIPLIER));
  const queryVector = await embedText(ai, args.query);
  const matches = await vectorize.query(queryVector, { topK: queryTopK, returnMetadata: 'all' });

  const validMatches: VectorMatch[] = matches.matches.flatMap((match) => {
    if (!isTeamVectorMetadata(match.metadata)) return [];
    if (!matchesFilters(match.metadata, args)) return [];
    return [{ metadata: match.metadata, score: match.score }];
  });

  const results = await hydrateVectorMatches(db, validMatches);
  return results.filter((result) => matchesReleaseFilters(result, args)).slice(0, limit);
}
