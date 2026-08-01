/**
 * "Groves are never team-facing" — the handler-scope gate, BOTH halves.
 *
 * The route-stamp gate classifies ROUTES; it cannot constrain what a handler
 * reads or writes. That property has now bitten twice on the read side
 * (#727 fixed instances, not the class), and once on the write side (a
 * param-named route whose context never bound the project it destroyed). This
 * gate holds the class:
 *
 *  1. ENUMERATION half — the overlay narrowing mechanism (`scopeForRequest` /
 *     `overlayGroveFilter`) keeps its two load-bearing properties, pinned to
 *     the source: overlay requests narrow to the REQUEST's grove, and an
 *     overlay request with no resolved grove gets NOTHING rather than
 *     everything. The enumerating handlers are pinned to actually call it.
 *
 *  2. WRITE half — every non-GET route on SERVE_DEFAULT_ROUTES must appear in
 *     the classification registry below. Adding a new overlay-reachable WRITE
 *     route without deciding its scope story fails here by name. The registry
 *     is a REVIEW artifact: each entry is a claim the next reviewer can
 *     challenge, not a proof — the honest limitation, same as W1's
 *     file-granularity.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVE_DEFAULT_ROUTES } from '@myco/host/routing.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * Every overlay-reachable WRITE route, with its scope story. Categories:
 *  - 'context-bound': the handler resolves its data through the request
 *    context (central write gate binds grove+project from params/headers).
 *  - 'host-run-mutation': the host executes the mutation against its own
 *    served Grove on the member's behalf — the DESIGNED data plane
 *    (scope-map §5.6 / WS2); tenancy is the served-grove binding.
 */
const SERVE_WRITE_ROUTE_SCOPES: Record<
  string,
  'context-bound' | 'host-run-mutation' | 'body-keyed-session-guarded' | 'read-only-post' | 'context-bound-or-daemon-rows'
> = {
  // The /context trio attaches bookkeeping to a BODY-supplied session id; the
  // ownership guard in recordInjectionActivity (pinned below) is what keeps a
  // foreign project's session untouchable.
  'POST /context': 'body-keyed-session-guarded',
  'POST /context/resume': 'read-only-post',
  'POST /context/prompt': 'body-keyed-session-guarded',
  'POST /context/subagent': 'body-keyed-session-guarded',
  'POST /api/cortex/instructions/refresh': 'host-run-mutation',
  'POST /api/cortex/prompt-builder': 'host-run-mutation',
  'POST /api/sessions/:id/complete': 'context-bound',
  'DELETE /api/sessions/:id': 'context-bound',
  'DELETE /api/plans/:id': 'context-bound',
  'PATCH /api/plans/:id': 'context-bound',
  'PUT /api/skill-candidates/:id': 'context-bound',
  'DELETE /api/skill-candidates/:id': 'context-bound',
  'DELETE /api/skill-records/:id': 'context-bound',
  'POST /api/digest/revisions/:id/restore': 'host-run-mutation',
  'POST /api/agent/run': 'host-run-mutation',
  'POST /api/agent/runs/:id/resume': 'host-run-mutation',
  'POST /api/notifications': 'context-bound-or-daemon-rows',
  'PATCH /api/notifications/:id': 'context-bound-or-daemon-rows',
  'POST /api/notifications/dismiss-all': 'context-bound-or-daemon-rows',
  'POST /api/notifications/mark-all-read': 'context-bound-or-daemon-rows',
  'POST /api/content-claims': 'host-run-mutation',
  'POST /api/content-claims/:id/refresh': 'host-run-mutation',
  'POST /api/content-claims/:id/release': 'host-run-mutation',
  'POST /api/content-claims/:id/published': 'host-run-mutation',
};

describe('serve-route scope gate', () => {
  test('WRITE half: every non-GET serve route is classified — a new one fails by name until its scope story is decided', () => {
    const writes = [...SERVE_DEFAULT_ROUTES].filter((r) => !r.startsWith('GET '));
    const unclassified = writes.filter((r) => !(r in SERVE_WRITE_ROUTE_SCOPES));
    expect(unclassified).toEqual([]);
    // And the registry carries no dead entries (a removed route must leave).
    const dead = Object.keys(SERVE_WRITE_ROUTE_SCOPES).filter((r) => !SERVE_DEFAULT_ROUTES.has(r));
    expect(dead).toEqual([]);
  });

  test('ENUMERATION half: the overlay narrowing keeps empty-not-everything, pinned to source', () => {
    const groves = read('packages/myco/src/daemon/api/groves.ts');
    // Overlay requests narrow to the request grove…
    expect(groves).toMatch(/if \(!req\.isOverlay\) return daemonScope;/);
    // …and no resolved grove yields NOTHING (the #727 inversion would yield everything).
    expect(groves).toMatch(/groveIds: groveId \? \[groveId\] : \[\]/);
    // The overlay fan-out filter exists for cross-Grove walks.
    expect(groves).toMatch(/export function overlayGroveFilter/);
  });

  test('mutating handlers refuse the grove-only ALL scope, and the body-keyed session guard exists', () => {
    // Grove-only caller tenancy resolves ALL_PROJECTS_SCOPE for reads (the
    // external listener's deliberate widening) — but a WRITE under it would
    // reach every project's rows while the pause gate (conditioned on a
    // present projectId) never ran. The mutation resolver refuses instead.
    const rc = read('packages/myco/src/grove/request-context.ts');
    expect(rc).toMatch(/export function mutationScopeFromRequestContext/);
    expect(rc).toMatch(/scope\.kind === 'all' \? null : scope/);
    const sessions = read('packages/myco/src/daemon/api/sessions.ts');
    expect((sessions.match(/mutationScopeFromRequestContext\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    const runs = read('packages/myco/src/daemon/api/agent-runs.ts');
    expect(runs).toMatch(/mutationScopeFromRequestContext\(/);
    // The /context trio's body-keyed writes verify session ownership first.
    const injections = read('packages/myco/src/daemon/injection-records.ts');
    expect(injections).toMatch(/owner !== null && owner !== projectId/);
  });

  test('the enumerating handlers actually route through the narrowing (a handler bypassing it re-opens #727)', () => {
    const groves = read('packages/myco/src/daemon/api/groves.ts');
    // Every grove enumeration must take the narrowing: a listGroveSummaries
    // call WITHOUT scopeForRequest is exactly the #727 shape.
    const calls = groves.match(/(?<!function )listGroveSummaries\(/g) ?? [];
    const narrowed = groves.match(/listGroveSummaries\(scopeForRequest\(/g) ?? [];
    expect(narrowed.length).toBe(calls.length);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // The cross-Grove fan-outs must keep their overlay filter — these are the
    // two production call sites; deleting either re-opens #727 for its route.
    const maintenance = read('packages/myco/src/daemon/api/maintenance.ts');
    expect(maintenance).toMatch(/shouldVisitGrove: overlayGroveFilter\(req\)/);
    const activity = read('packages/myco/src/daemon/api/projects-activity.ts');
    expect(activity).toMatch(/shouldVisitGrove: overlayGroveFilter\(req\)/);
  });

  test('notification mutators never use the read-scope resolver (grove-only ALL would bypass the pause gate)', () => {
    const notifications = read('packages/myco/src/daemon/api/notifications.ts');
    const mutators = ['handleUpdateNotification', 'handleDismissAll', 'handleMarkAllRead'];
    for (const fn of mutators) {
      const start = notifications.indexOf(`export async function ${fn}`);
      expect(start, `${fn} missing`).toBeGreaterThan(-1);
      const body = notifications.slice(start, notifications.indexOf('\nexport', start + 10));
      expect(body, `${fn} must use mutationScopeFromRequestContext`).toContain('mutationScopeFromRequestContext');
      expect(body, `${fn} must not use the read resolver`).not.toContain('projectScopeFromRequestContext(');
    }
  });
});
