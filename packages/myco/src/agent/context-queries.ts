/**
 * Context query execution for pre-phase vault lookups.
 *
 * Executes lightweight vault queries before the orchestrator makes planning
 * decisions. Uses the same DB query functions as the vault tools but bypasses
 * the MCP layer entirely.
 */

import type { ContextQuery } from './types.js';
import { errorMessage as toErrorMessage } from '@myco/utils/error-message.js';
import { getUnprocessedBatches } from '@myco/db/queries/batches.js';
import { listSpores } from '@myco/db/queries/spores.js';
import { listSessions } from '@myco/db/queries/sessions.js';
import { getStatesForAgent } from '@myco/db/queries/agent-state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default limit for context query results when none specified. */
const DEFAULT_CONTEXT_QUERY_LIMIT = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a single context query execution. */
export interface ContextQueryResult {
  tool: string;
  purpose: string;
  data: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a list of context queries against the vault database.
 *
 * Each query is routed to the appropriate DB function based on `query.tool`.
 * On failure:
 * - Required queries throw — the caller should abort.
 * - Optional queries return a result with `error` set and `data: null`.
 *
 * Unknown tool names always throw, regardless of `required`.
 *
 * @param agentId - The agent ID to scope agent-specific queries.
 * @param queries - The list of context queries to execute.
 * @returns Resolved results in the same order as the input queries.
 */
export async function executeContextQueries(
  agentId: string,
  queries: ContextQuery[],
): Promise<ContextQueryResult[]> {
  // Validate all tool names upfront — unknown tools are a programming error.
  for (const query of queries) {
    validateTool(query.tool);
  }

  // Execute all queries in parallel — they hit independent DB tables.
  const settled = await Promise.allSettled(
    queries.map(async (query) => {
      const limit = query.limit ?? DEFAULT_CONTEXT_QUERY_LIMIT;
      const data = await executeQuery(agentId, query.tool, limit);
      return { tool: query.tool, purpose: query.purpose, data } satisfies ContextQueryResult;
    }),
  );

  // Map settled results, throwing for required failures.
  const results: ContextQueryResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const query = queries[i];

    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
    } else {
      const message = toErrorMessage(outcome.reason);

      if (query.required) {
        throw new Error(
          `Required context query "${query.tool}" failed: ${message}`,
        );
      }

      results.push({
        tool: query.tool,
        purpose: query.purpose,
        data: null,
        error: message,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Set of recognized context query tool names. */
const KNOWN_CONTEXT_QUERY_TOOLS = new Set([
  'vault_unprocessed',
  'vault_spores',
  'vault_sessions',
  'vault_state',
]);

/**
 * Guard against unknown tool names.
 *
 * Unknown tools are a programming error (misconfigured task YAML), so they
 * always throw — even if the query is not marked required.
 */
function validateTool(tool: string): void {
  if (!KNOWN_CONTEXT_QUERY_TOOLS.has(tool)) {
    throw new Error(`Unknown context query tool: "${tool}"`);
  }
}

/**
 * Route a single query to the appropriate DB function.
 */
async function executeQuery(
  agentId: string,
  tool: string,
  limit: number,
): Promise<unknown> {
  switch (tool) {
    case 'vault_unprocessed':
      return getUnprocessedBatches({ limit });

    case 'vault_spores':
      return listSpores({ agent_id: agentId, limit });

    case 'vault_sessions':
      return listSessions({ limit });

    case 'vault_state':
      return getStatesForAgent(agentId);

    default:
      throw new Error(`Unknown context query tool: "${tool}"`);
  }
}
