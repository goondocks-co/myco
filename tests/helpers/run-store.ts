/**
 * Build a local `RunStore` the way the executor does.
 *
 * The store is a real dependency of the finalizers now, so tests construct one
 * rather than having the production code fall back to building its own — a
 * fallback would be the "keep the old path" shim that hides whether callers
 * actually thread the store through.
 */
import { projectScopeFromRequestContext } from '@myco/grove/request-context.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { createLocalRunStore } from '@myco/agent/runtime/run-store-local.js';
import { serializeRunStore, type RunStore } from '@myco/agent/runtime/run-store.js';

/**
 * `requestContext` omitted binds the store to ALL_PROJECTS_SCOPE, which is what
 * `projectScopeFromRequestContext` demands a caller assert explicitly rather
 * than infer from a missing context.
 */
export function testRunStore(
  requestContext: Parameters<typeof projectScopeFromRequestContext>[0],
  agentId: string,
): RunStore {
  const scope = requestContext
    ? projectScopeFromRequestContext(requestContext)
    : ALL_PROJECTS_SCOPE;
  return serializeRunStore(createLocalRunStore({ scope, agentId }));
}
