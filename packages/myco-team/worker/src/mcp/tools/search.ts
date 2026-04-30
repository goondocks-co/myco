import type { Env } from '../../index';
import { searchKnowledge } from '../../search-helpers';
import { textJson, toCloudSearchResult } from '../result-shape';

interface SearchArgs {
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

export async function handleSearch(args: SearchArgs, env: Pick<Env, 'MYCO_TEAM_DB' | 'MYCO_TEAM_VECTORS' | 'AI'>) {
  const results = await searchKnowledge(env.MYCO_TEAM_DB, env.MYCO_TEAM_VECTORS, env.AI, args);
  return textJson({ results: results.map(toCloudSearchResult) });
}
