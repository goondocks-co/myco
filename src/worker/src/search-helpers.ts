/**
 * Shared search helpers used by both the REST /search endpoint and MCP myco_search tool.
 */

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
}

interface VectorMatch {
  metadata: { table: string; id: string; machine_id: string };
  score: number;
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
  const groups = new Map<string, Array<{ id: string; machine_id: string; score: number }>>();
  for (const match of matches) {
    const { table, id, machine_id } = match.metadata;
    const group = groups.get(table) ?? [];
    group.push({ id, machine_id, score: match.score });
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
        results.push({ id: item.id, machine_id: item.machine_id, type: table, score: item.score, data: row });
      }
    }
    return results;
  });

  const resultArrays = await Promise.all(hydrationPromises);
  const results = resultArrays.flat();
  results.sort((a, b) => b.score - a.score);
  return results;
}
