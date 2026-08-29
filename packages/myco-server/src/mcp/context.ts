/**
 * What a tool call runs with: the storage, the principal the credential
 * names, and the Project the call addresses.
 *
 * Two principals reach the tool surface. A member, whose credential is
 * Deployment-wide: its call reads the request's header Project unless it
 * names another with `project_id`, and a named Project resolves through the
 * read scope only — a Project the Deployment has never seen is answered as
 * absent, never created. An External Agent grant, whose row names one
 * Project: its call reads that Project and no other; `project_id` is judged
 * before any handler runs (`server.ts callTool`), so here it is never a pivot.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { GrantContext, RouteContext } from '../context.js';
import type { ReadScope } from '../read/scope.js';
import { resolveProjectScope } from '../api/scope.js';
import { unknownTool, type ToolInput } from './validate.js';

export interface MemberPrincipal {
  kind: 'member';
  memberId: string;
  machineId: string;
  tokenId: string;
}

export interface GrantPrincipal {
  kind: 'grant';
  grantId: string;
}

export type Principal = MemberPrincipal | GrantPrincipal;

export interface ToolContext {
  env: ServerEnv;
  /** The Project the request is admitted for. */
  projectId: string;
  principal: Principal;
  now: number;
}

/** A domain refusal the tool answers as a result rather than an error, the shape the member-side handlers answer. */
export interface ToolFailure {
  ok: false;
  error: string;
}

export const failure = (error: string): ToolFailure => ({ ok: false, error });

export function toolContext(env: ServerEnv, ctx: RouteContext): ToolContext {
  return { env, projectId: ctx.projectId, principal: { kind: 'member', memberId: ctx.memberId, machineId: ctx.machineId, tokenId: ctx.tokenId }, now: ctx.now };
}

export function grantToolContext(env: ServerEnv, ctx: GrantContext): ToolContext {
  return { env, projectId: ctx.projectId, principal: { kind: 'grant', grantId: ctx.grantId }, now: ctx.now };
}

/** The identifiers telemetry names the principal by. */
export function principalFields(ctx: ToolContext): Record<string, string> {
  const p = ctx.principal;
  return p.kind === 'member' ? { memberId: p.memberId, tokenId: p.tokenId } : { grantId: p.grantId };
}

/** The member behind a call that writes on its behalf. A grant never reaches such a call — the allowlist refuses it first — and is refused the same way here. */
export function memberOf(ctx: ToolContext, tool: string): MemberPrincipal {
  if (ctx.principal.kind !== 'member') throw unknownTool(tool);
  return ctx.principal;
}

/** The scope this call reads: a grant's own Project; for a member, the named Project when `project_id` is given and known, else the header Project; null when the named Project is not one the caller may see. */
export async function scopeOf(ctx: ToolContext, input: ToolInput): Promise<ReadScope | null> {
  if (ctx.principal.kind === 'grant') return { projectId: ctx.projectId };
  const named = input.project_id;
  if (typeof named !== 'string' || named.length === 0) return { projectId: ctx.projectId };
  return resolveProjectScope(ctx.env.db, { id: ctx.principal.memberId, label: null }, named);
}

/** The arguments without the pivot key, so no handler forwards it as a filter. */
export function withoutPivot(input: ToolInput): ToolInput {
  const { project_id: _pivot, ...rest } = input;
  return rest;
}
