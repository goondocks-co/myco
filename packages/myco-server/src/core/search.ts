import type { ServerEnv } from './adapters.js';
import { searchProject, type SearchOptions, type SearchAnswer } from '../read/search.js';
import type { ReadScope } from '../read/scope.js';
import type { SemanticSearch } from '../read/embedding.js';

export async function resolveSemanticSearch(env: ServerEnv): Promise<SemanticSearch | null> {
  if (env.vectors === undefined) return null;
  const provider = await env.embeddingProvider?.();
  return provider == null ? null : { provider, vectors: env.vectors };
}

/** HTTP and MCP resolve the same configured capability after validating the query. */
export function searchDeployment(env: ServerEnv, scope: ReadScope, options: SearchOptions): Promise<SearchAnswer> {
  return searchProject(env.db, scope, options, () => resolveSemanticSearch(env));
}
