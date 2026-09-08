/**
 * What a tool call runs with: the storage, the principal the credential
 * names, and the Project the call addresses.
 *
 * Three principals reach the tool surface. A member, whose credential is
 * Deployment-wide: its call reads the request's header Project unless it
 * names another with `project_id`, and a named Project resolves through the
 * read scope only — a Project the Deployment has never seen is answered as
 * absent, never created. A run, whose credential the dispatcher minted for one
 * run: its call reads that run's Project and no other, and may call only the
 * `(tool, op)` pairs its task declares (`run-surface.ts`). An External Agent
 * grant, whose row names one Project: its call reads that Project and no
 * other. For a run and a grant, `project_id` is judged before any handler runs
 * (`server.ts callTool`), so here it is never a pivot.
 *
 * A write names the principal behind it twice: `agent_id` is the actor class —
 * the built-in `user` agent for a member, the run's agent for a run — and
 * `author` is the instance, a member id or a run id. `writerOf` answers both
 * for the handlers that write.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { GrantContext, RouteContext, RunContext } from '../context.js';
import type { ReadScope } from '../read/scope.js';
import { sessionNamedByRun } from '../api/run-admission.js';
import { resolveProjectScope } from '../api/scope.js';
import { taskTools } from '../core/task-catalogue.js';
import { projectHoldsSession, sessionHeldByMachine } from '../read/sessions.js';
import { runAllowlist, type RunAllowlist } from './run-surface.js';
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

export interface RunPrincipal {
  kind: 'run';
  runId: string;
  task: string | null;
  /** The agent the run dispatched under; every write it makes carries it as `agent_id`. */
  agentId: string;
  /** The session the run's dispatch named, or null; the only session a run may write against. */
  sessionId: string | null;
  tokenId: string;
  allow: RunAllowlist;
}

export type Principal = MemberPrincipal | GrantPrincipal | RunPrincipal;

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

/** The agent every member-recorded spore carries; seeded by the schema. */
export const USER_AGENT_ID = 'user';

export function toolContext(env: ServerEnv, ctx: RouteContext): ToolContext {
  return { env, projectId: ctx.projectId, principal: { kind: 'member', memberId: ctx.memberId, machineId: ctx.machineId, tokenId: ctx.tokenId }, now: ctx.now };
}

export function grantToolContext(env: ServerEnv, ctx: GrantContext): ToolContext {
  return { env, projectId: ctx.projectId, principal: { kind: 'grant', grantId: ctx.grantId }, now: ctx.now };
}

/** The run's surface is its task's declared tools mapped onto MCP; a dry run keeps the reads and loses every write. */
export function runToolContext(env: ServerEnv, ctx: RunContext): ToolContext {
  const { run } = ctx;
  return {
    env,
    projectId: ctx.projectId,
    principal: {
      kind: 'run', runId: run.id, task: run.task, agentId: run.agentId, sessionId: sessionNamedByRun(run), tokenId: ctx.tokenId,
      allow: runAllowlist(taskTools(run.task), { dryRun: run.dryRun === 1 }),
    },
    now: ctx.now,
  };
}

/** The identifiers telemetry names the principal by. */
export function principalFields(ctx: ToolContext): Record<string, string> {
  const p = ctx.principal;
  if (p.kind === 'member') return { memberId: p.memberId, tokenId: p.tokenId };
  if (p.kind === 'run') return { runId: p.runId, tokenId: p.tokenId };
  return { grantId: p.grantId };
}

/** The one Project a principal is bound to — a run's, a grant's — or null for a member, whose credential spans the Deployment. */
export function boundProject(ctx: ToolContext): string | null {
  return ctx.principal.kind === 'member' ? null : ctx.projectId;
}

/** The member behind a call that writes on its behalf. A grant or a run never reaches such a call — the allowlist refuses it first — and is refused the same way here. */
export function memberOf(ctx: ToolContext, tool: string): MemberPrincipal {
  if (ctx.principal.kind !== 'member') throw unknownTool(tool);
  return ctx.principal;
}

/** What a write carries as its principal: the actor class and the instance. */
export interface Writer {
  agentId: string;
  author: string;
}

/** The principal a write is attributed to. A grant has no write surface yet (#1149 gives it an agent row and an author value); until then a grant reaching a write is refused as the allowlist refuses it. */
export function writerOf(ctx: ToolContext, tool: string): Writer {
  const p = ctx.principal;
  if (p.kind === 'member') return { agentId: USER_AGENT_ID, author: p.memberId };
  if (p.kind === 'run') return { agentId: p.agentId, author: p.runId };
  throw unknownTool(tool);
}

/** The one refusal for a `session_id` this caller may not name, whatever the cause. */
export const SESSION_NOT_FOUND = 'session_id not found';

/**
 * The session a write names, or null when it names none; the refusal when the
 * caller may not name it.
 *
 * **A member names a session its own machine holds.** The agent echoes the id
 * the prompt hook injected, and the tool admits it only when the addressed
 * Project holds that session under the machine behind the credential. Every
 * other case answers one refusal, so an id that is not the caller's tells the
 * caller nothing about whether the Deployment holds it.
 *
 * **A run names the session its dispatch named**, exactly as the run routes
 * attribute a run's writes; naming any other is the same refusal. A dispatch
 * whose session the Project does not hold writes with no session rather than
 * failing the row's key — the `author` column still names the run, whose
 * context names the session.
 */
export async function sessionOf(ctx: ToolContext, scope: ReadScope, input: ToolInput, tool: string): Promise<{ ok: true; sessionId: string | null } | ToolFailure> {
  const named = typeof input.session_id === 'string' && input.session_id.length > 0 ? input.session_id : undefined;
  if (ctx.principal.kind === 'run') {
    const own = ctx.principal.sessionId;
    if (named !== undefined && named !== own) return failure(SESSION_NOT_FOUND);
    if (own === null) return { ok: true, sessionId: null };
    return { ok: true, sessionId: (await projectHoldsSession(ctx.env.db, scope, own)) ? own : null };
  }
  if (named === undefined) return { ok: true, sessionId: null };
  const { machineId } = memberOf(ctx, tool);
  if (!(await sessionHeldByMachine(ctx.env.db, scope, named, machineId))) return failure(SESSION_NOT_FOUND);
  return { ok: true, sessionId: named };
}

/** The scope this call reads: a run's or a grant's own Project; for a member, the named Project when `project_id` is given and known, else the header Project; null when the named Project is not one the caller may see. */
export async function scopeOf(ctx: ToolContext, input: ToolInput): Promise<ReadScope | null> {
  if (ctx.principal.kind !== 'member') return { projectId: ctx.projectId };
  const named = input.project_id;
  if (typeof named !== 'string' || named.length === 0) return { projectId: ctx.projectId };
  return resolveProjectScope(ctx.env.db, { id: ctx.principal.memberId, label: null }, named);
}

/** The arguments without the pivot key, so no handler forwards it as a filter. */
export function withoutPivot(input: ToolInput): ToolInput {
  const { project_id: _pivot, ...rest } = input;
  return rest;
}
