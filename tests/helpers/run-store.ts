/**
 * Build a local `RunStore` the way the executor does.
 *
 * The store is a real dependency of the finalizers now, so tests construct one
 * rather than having the production code fall back to building its own — a
 * fallback would be the "keep the old path" shim that hides whether callers
 * actually thread the store through.
 */
import { projectScopeFromRequestContext } from '@myco/grove/request-context.js';
import { createLocalRunStore } from '@myco/agent/runtime/run-store-local.js';
import { serializeRunStore, type RunStore } from '@myco/agent/runtime/run-store.js';

export function testRunStore(
  requestContext: Parameters<typeof projectScopeFromRequestContext>[0],
  agentId: string,
): RunStore {
  return serializeRunStore(
    createLocalRunStore({ scope: projectScopeFromRequestContext(requestContext), agentId }),
  );
}
