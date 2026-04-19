/**
 * Shared search helpers used by both the REST /search endpoint and MCP myco_search tool.
 */

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SEARCH_OVERFETCH_MULTIPLIER = 4;

export interface TeamVectorMetadata {
  table: string;
  id: string;
  machine_id: string;
  status?: string;
  observation_type?: string;
  created_at?: number;
  session_id?: string;
  source_path?: string;
  name?: string;
  project_root?: string;
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
}

/**
 * Embed text via Workers AI (bge-m3) and return the vector.
 */
export async function embedText(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run('@cf/baai/bge-m3', { text: [text] }) as { data: number[][] };
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

  const createdAt = typeof metadata.created_at === 'number' ? metadata.created_at : undefined;
  if (args.since !== undefined && (createdAt === undefined || createdAt < args.since)) return false;
  if (args.until !== undefined && (createdAt === undefined || createdAt > args.until)) return false;

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

    const results: HydratedResult[] = [];
    for (const item of items) {
      const row = rowMap.get(`${item.id}:${item.machine_id}`);
      if (row) {
        results.push({
          id: item.id,
          machine_id: item.machine_id,
          type: table,
          score: item.score,
          data: row,
          metadata: item.metadata,
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

  const validMatches = matches.matches
    .filter((match) => match.metadata)
    .map((match) => ({
      metadata: match.metadata as TeamVectorMetadata,
      score: match.score,
    }))
    .filter((match) => matchesFilters(match.metadata, args));

  const results = await hydrateVectorMatches(db, validMatches);
  return results.slice(0, limit);
}
