import { search_InvalidSearch as InvalidSearch } from '../../read/catalog/search.js';
import { SEARCH_TOOL_LIMIT, type SearchOptions } from '@goondocks/myco-shared/search-types';
import { searchDeployment } from '../../core/search.js';
import { searchCuration } from '../../core/spore-curation.js';
import { CURATION_TASK } from '../../core/task-catalogue.js';
import { failure, scopeOf, type ToolContext } from '../context.js';
import { ToolError, type ToolInput } from '../validate.js';

export async function handleSearch(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const options: SearchOptions = { query: input.query as string, limit: (input.limit as number | undefined) ?? SEARCH_TOOL_LIMIT };
  for (const key of ['type', 'mode', 'session_id', 'status', 'observation_type', 'release_state', 'release_confidence', 'order', 'agent', 'branch'] as const) {
    if (typeof input[key] === 'string') options[key] = input[key];
  }
  if (typeof input.cursor === 'string') options.cursor = input.cursor;
  for (const key of ['since', 'until'] as const) if (typeof input[key] === 'number') options[key] = input[key];
  try {
    if (ctx.principal.kind === 'run' && ctx.principal.task === CURATION_TASK) return await searchCuration(ctx.env, scope.projectId, ctx.principal.runId, options.query);
    return await searchDeployment(ctx.env, scope, options);
  }
  catch (error) {
    if (error instanceof InvalidSearch) throw new ToolError('invalid_input', error.message);
    throw error;
  }
}
