import { InvalidSearch, SEARCH_TOOL_LIMIT, type SearchOptions } from '../../read/search.js';
import { searchDeployment } from '../../core/search.js';
import { failure, scopeOf, type ToolContext } from '../context.js';
import { ToolError, type ToolInput } from '../validate.js';

export async function handleSearch(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  if (input.language !== undefined) throw new ToolError('invalid_input', 'Canopy entry search has been retired');
  const options: SearchOptions = { query: input.query as string, limit: (input.limit as number | undefined) ?? SEARCH_TOOL_LIMIT };
  for (const key of ['type', 'mode', 'session_id', 'status', 'observation_type', 'release_state', 'release_confidence'] as const) {
    if (typeof input[key] === 'string') options[key] = input[key];
  }
  for (const key of ['since', 'until'] as const) if (typeof input[key] === 'number') options[key] = input[key];
  try { return await searchDeployment(ctx.env, scope, options); }
  catch (error) {
    if (error instanceof InvalidSearch) throw new ToolError('invalid_input', error.message);
    throw error;
  }
}
