/**
 * What a tool call runs with: the storage, the caller's identity from the
 * credential, and the Project the call addresses.
 *
 * The Project is the request's header Project unless the call names another
 * with `project_id`. A named Project resolves through the read scope only — a
 * Project the Deployment has never seen is answered as absent, never created;
 * creation belongs to the header path the pipeline runs before any handler.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import type { ReadScope } from '../read/scope.js';
import { resolveProjectScope } from '../api/scope.js';
import type { ToolInput } from './validate.js';

export interface ToolContext {
  env: ServerEnv;
  /** The Project the request is admitted for. */
  projectId: string;
  memberId: string;
  machineId: string;
  tokenId: string;
  now: number;
}

/** A domain refusal the tool answers as a result rather than an error, the shape the member-side handlers answer. */
export interface ToolFailure {
  ok: false;
  error: string;
}

export const failure = (error: string): ToolFailure => ({ ok: false, error });

export function toolContext(env: ServerEnv, ctx: RouteContext): ToolContext {
  return { env, projectId: ctx.projectId, memberId: ctx.memberId, machineId: ctx.machineId, tokenId: ctx.tokenId, now: ctx.now };
}

/** The scope this call reads: the named Project when `project_id` is given and known, else the header Project; null when the named Project is not one the caller may see. */
export async function scopeOf(ctx: ToolContext, input: ToolInput): Promise<ReadScope | null> {
  const named = input.project_id;
  if (typeof named !== 'string' || named.length === 0) return { projectId: ctx.projectId };
  return resolveProjectScope(ctx.env.db, { id: ctx.memberId, label: null }, named);
}

/** The arguments without the pivot key, so no handler forwards it as a filter. */
export function withoutPivot(input: ToolInput): ToolInput {
  const { project_id: _pivot, ...rest } = input;
  return rest;
}
