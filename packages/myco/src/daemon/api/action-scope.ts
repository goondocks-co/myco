/**
 * `ActionScope` is the wire-format envelope every multi-scoped action
 * endpoint accepts in its POST body. It makes the user's pill choice
 * an explicit instruction so a "Reconcile All Groves" click actually
 * fans out across every Grove instead of being silently narrowed to
 * the request's header-bound Grove.
 *
 * Three kinds, mirroring the three Operations pill values:
 *
 *   - `project`    — operate on one project's namespace inside one Grove.
 *   - `grove`      — operate on one Grove (every project in it).
 *   - `all-groves` — fan out across every registered Grove.
 *
 * Default behavior when `scope` is missing from the body is the
 * project-scoped equivalent of the request context — semantically
 * identical to today's behavior, just explicit. This preserves
 * backward compatibility for clients that have not been updated to
 * pass a scope.
 */

import { z } from 'zod';
import { assertGroveProjectId, isGroveEraId } from '@myco/grove/ids.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const projectIdSchema = z
  .string()
  .min(1)
  .refine((v) => isGroveEraId(v, 'project'), {
    message: 'Invalid Grove project id: expected proj_<32 hex chars>',
  })
  .transform((v) => assertGroveProjectId(v));

export const ActionScopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('project'),
    grove_id: z.string().min(1),
    project_id: projectIdSchema,
  }),
  z.object({
    kind: z.literal('grove'),
    grove_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('all-groves'),
  }),
]);

export type ActionScope = z.infer<typeof ActionScopeSchema>;

// ---------------------------------------------------------------------------
// Resolution from request body
// ---------------------------------------------------------------------------

export interface ResolveActionScopeOptions {
  body: unknown;
  requestContext?: MycoRequestContext;
  /**
   * Default scope kind when no `scope` is supplied in the body. Defaults
   * to `'project'` (the historical behavior — the request context's
   * project becomes the implicit scope). Set to `'grove'` for endpoints
   * whose data plane has no project-narrowed path (whole-DB backup,
   * vacuum, optimize, integrity-check, reindex) so the missing-body
   * default doesn't silently route a Grove-only action through the
   * `'project'` arm. (P2 #36)
   */
  defaultKind?: 'project' | 'grove';
}

/**
 * Read an `ActionScope` from the body if present; otherwise default to
 * a project-scoped (or grove-scoped, per `defaultKind`) action derived
 * from the request context. Throws `InvalidActionScopeError` when the
 * body has a malformed `scope` or when no scope is supplied and the
 * request lacks a Grove context.
 */
export function resolveActionScope(options: ResolveActionScopeOptions): ActionScope {
  const raw = (options.body as { scope?: unknown } | null | undefined)?.scope;
  if (raw !== undefined) {
    const parsed = ActionScopeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new InvalidActionScopeError(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return parsed.data;
  }
  const ctx = options.requestContext;
  if (!ctx?.groveId || !ctx.projectId) {
    throw new InvalidActionScopeError(
      'No scope in body and request context lacks Grove/project ids',
    );
  }
  if (options.defaultKind === 'grove') {
    return { kind: 'grove', grove_id: ctx.groveId };
  }
  // ctx.projectId is already typed as GroveProjectId (branded at the
  // request-context boundary), so no cast is needed here.
  return {
    kind: 'project',
    grove_id: ctx.groveId,
    project_id: ctx.projectId,
  };
}

export class InvalidActionScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidActionScopeError';
  }
}

/**
 * Stable string key for an ActionScope. Used by `ActionInflightRegistry`
 * to coalesce concurrent identical actions into one in-flight job.
 */
export function actionScopeKey(scope: ActionScope): string {
  switch (scope.kind) {
    case 'project':
      return `project:${scope.grove_id}:${scope.project_id}`;
    case 'grove':
      return `grove:${scope.grove_id}`;
    case 'all-groves':
      return 'all-groves';
  }
}
