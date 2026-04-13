import type { Env } from '../../index';
import { embedText, hydrateVectorMatches } from '../../search-helpers';

interface SearchArgs {
  query: string;
  types?: string[];
  limit?: number;
}

export async function handleSearch(args: SearchArgs, env: Pick<Env, 'MYCO_TEAM_DB' | 'MYCO_TEAM_VECTORS' | 'AI'>) {
  const { query, types, limit = 10 } = args;
  const topK = Math.min(Math.max(limit, 1), 50);

  const queryVector = await embedText(env.AI, query);
  const matches = await env.MYCO_TEAM_VECTORS.query(queryVector, { topK, returnMetadata: 'all' });

  // Filter by types if specified, then cast metadata
  let filtered = matches.matches.filter((m) => m.metadata);
  if (types && types.length > 0) {
    const typeSet = new Set(types);
    filtered = filtered.filter((m) => typeSet.has((m.metadata as { table: string }).table));
  }

  const validMatches = filtered.map((m) => ({
    metadata: m.metadata as { table: string; id: string; machine_id: string },
    score: m.score,
  }));

  const results = await hydrateVectorMatches(env.MYCO_TEAM_DB, validMatches);

  return { content: [{ type: 'text' as const, text: JSON.stringify({ results: results.slice(0, topK) }) }] };
}
