/**
 * Shared test fixture for `MycoRequestContext` — used to build `RouteRequest`
 * mocks that satisfy D5's strictness gate in `projectScopeFromRequestContext`.
 *
 * Production middleware always sets `requestContext` on every `RouteRequest`,
 * so D5 hardened the contract to throw on missing context. Test fixtures that
 * historically relied on the silent `{kind:'all'}` fallthrough must now thread
 * a real `MycoRequestContext` through. Use `TEST_REQUEST_CONTEXT` (a static
 * Grove-bound default) for handler tests; use `makeTestRequestContext` to
 * build a custom one with overrides.
 *
 * Tests that DO want to exercise cross-project / admin-style reads should
 * pass `ALL_PROJECTS_SCOPE` to the query helper directly rather than building
 * a context-less request. The strict throw exists precisely to make that
 * choice explicit.
 */

import { resolveLegacyRequestContext } from '@myco/tools/request-context.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';

const TEST_VAULT_DIR = '/tmp/myco-test/.myco';
const TEST_PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

/**
 * Static, LEGACY (non-Grove) request context used as the default for handler
 * tests that don't care about scope details. `groveId: null` means
 * `projectScopeFromRequestContext` returns `GLOBAL_SCOPE` (kind: 'global'),
 * matching the NULL project_id behavior of test fixtures that insert rows
 * via `makeCandidate` / `makeRow` helpers without setting project_id.
 *
 * Tests that DO want Grove-bound scope behavior (e.g. tests that exercise
 * Grove-specific filtering) should construct their own context via
 * `makeTestRequestContext({ groveId: 'grove_...' })`.
 */
export const TEST_REQUEST_CONTEXT: MycoRequestContext = resolveLegacyRequestContext(TEST_VAULT_DIR, {
  projectId: TEST_PROJECT_ID,
  groveId: null,
  machineId: 'test-machine',
});

/**
 * Build a custom test request context. Use when a test needs a specific
 * projectId / groveId / sessionId combination. The defaults match
 * `TEST_REQUEST_CONTEXT` so spreads work cleanly.
 */
export function makeTestRequestContext(
  overrides: Partial<{
    vaultDir: string;
    projectId: string;
    groveId: string | null;
    machineId: string;
    sessionId: string | null;
  }> = {},
): MycoRequestContext {
  return resolveLegacyRequestContext(overrides.vaultDir ?? TEST_VAULT_DIR, {
    projectId: (overrides.projectId ?? TEST_PROJECT_ID) as MycoRequestContext['projectId'],
    groveId: overrides.groveId ?? null,
    machineId: overrides.machineId ?? 'test-machine',
    sessionId: overrides.sessionId ?? null,
  });
}
