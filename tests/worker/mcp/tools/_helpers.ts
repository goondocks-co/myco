export interface FakeD1Result {
  results: Record<string, unknown>[];
}

export function createFakeD1() {
  const results: FakeD1Result[] = [];
  const queries: Array<{ sql: string; values: unknown[] }> = [];

  return {
    queries,
    addResult(rows: Record<string, unknown>[]) {
      results.push({ results: rows });
    },
    db: {
      prepare(sql: string) {
        let boundValues: unknown[] = [];
        return {
          bind(...values: unknown[]) {
            boundValues = values;
            return this;
          },
          async all() {
            queries.push({ sql, values: [...boundValues] });
            return results.shift() ?? { results: [] };
          },
          async first<T>() {
            queries.push({ sql, values: [...boundValues] });
            const result = results.shift();
            return (result?.results[0] as T) ?? null;
          },
          async run() {
            queries.push({ sql, values: [...boundValues] });
            return { success: true };
          },
        };
      },
    } as unknown as D1Database,
  };
}

export function createFakeVectorize(
  matches: Array<{ id: string; score: number; metadata: Record<string, unknown> }> = [],
) {
  const query = async () => ({ matches, count: matches.length });
  return {
    query,
  } as unknown as VectorizeIndex;
}

export function createFakeAI(vector: number[] = [0.1, 0.2, 0.3]) {
  return {
    run: async () => ({ data: [vector] }),
  } as unknown as Ai;
}

export function parseToolResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}
