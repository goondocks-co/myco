/**
 * Plans as the Deployment administers them.
 *
 * A save is a `plan` capture event through the same ingest path a member hook
 * uses, so a plan named by its file lands on the row the hook would write — the
 * key is the member's own derivation over the path as the hook sends it. A
 * status change is an administrative edit by a member, written to the row
 * directly and stamped strictly after it; the owner route and the tool share it.
 *
 * Deleting is not served: a Deployment keeps every plan; `abandoned` is the
 * status for one that no longer applies.
 */
import { SERVER_PROTOCOL } from '../constants.js';
import { utf8, uuidv5 } from '../hash.js';
import { ingestEvent } from '../ingest/events.js';
import { getPlan, latestPromptId, PLAN_STATUS_MESSAGE, setPlanStatus, WRITABLE_PLAN_STATUSES, type ProjectPlanRow } from '../read/plans.js';
import type { ReadScope } from '../read/scope.js';
import type { RelationalStore, ServerEnv } from './adapters.js';

/** What the `plan` events the tool emits say produced them. */
export const MCP_PRODUCER = { adapter: 'mcp', version: String(SERVER_PROTOCOL) } as const;

/** A path as the member keys it: forward slashes. The member sends it project-relative or `~/`-prefixed and the tool's caller passes the same form; nothing else is rewritten. */
export const normalizePlanPath = (path: string): string => path.replace(/\\/g, '/');

/** The key a plan is stored under: the id given, the member's derivation for a file, or a derivation of the logical key. */
export async function planKeyFor(projectId: string, input: { id?: string; sourcePath?: string; planKey?: string }): Promise<string | null> {
  if (input.id !== undefined) return input.id;
  if (input.sourcePath !== undefined) return uuidv5('plan', projectId, normalizePlanPath(input.sourcePath));
  if (input.planKey !== undefined) return uuidv5('plan-key', projectId, input.planKey);
  return null;
}

export interface SavePlanInput {
  id?: string;
  sessionId: string;
  content?: string;
  title?: string;
  status?: string;
  sourcePath?: string;
  planKey?: string;
  tags?: string[];
  /** The prompt the plan came from; the session's latest when absent. Must belong to the caller's own machine. */
  promptId?: string;
}

export type SavePlanOutcome =
  | { ok: true; row: ProjectPlanRow; logicalKey: string }
  | { ok: false; error: string; code?: string };

/** The member the save is written as: its machine owns the session the event names, and its credential is charged. */
export interface SavingMember { machineId: string; tokenId: string }

/**
 * Creates or updates a plan as a capture event. A create names the prompt it came from; an update carries none, so the row keeps its own — a member's machine may not name a prompt another machine captured, and a plan is shared across them.
 */
export async function savePlan(env: ServerEnv, member: SavingMember, scope: ReadScope, input: SavePlanInput, nowMs: number): Promise<SavePlanOutcome> {
  if (input.content === undefined && input.id === undefined) return { ok: false, error: 'content is required when creating a new plan' };
  if (input.status !== undefined && !WRITABLE_PLAN_STATUSES.has(input.status)) return { ok: false, error: PLAN_STATUS_MESSAGE };
  if (input.sourcePath !== undefined && input.planKey !== undefined) return { ok: false, error: 'Pass either source_path or plan_key, not both' };

  const planKey = await planKeyFor(scope.projectId, input);
  if (planKey === null) return { ok: false, error: 'source_path or plan_key is required when creating a new plan' };
  const existing = await getPlan(env.db, scope, planKey);
  if (input.id !== undefined && existing === null) return { ok: false, error: 'Plan not found' };

  const text = input.content ?? existing?.content ?? null;
  const blob = text === null ? existing?.blobKey ?? null : null;
  if (text === null && blob === null) return { ok: false, error: 'content is required when creating a new plan' };
  const tags = input.tags ?? existing?.tags ?? [];
  const promptId = existing === null ? input.promptId ?? (await latestPromptId(env.db, scope, input.sessionId)) ?? undefined : undefined;
  const payload: Record<string, unknown> = {
    planKey,
    promptId,
    title: input.title ?? existing?.title ?? undefined,
    status: input.status ?? existing?.status ?? 'active',
    originPath: input.sourcePath === undefined ? existing?.originPath ?? undefined : normalizePlanPath(input.sourcePath),
    tags,
    ...(text === null ? { blob } : { content: text }),
  };
  // An update is stamped strictly after the row it read, so a same-millisecond
  // edit still projects as the newer write on replay in any order; the
  // projection's tiebreak on equal timestamps compares event ids, which carry
  // no edit order.
  const createdAt = existing === null ? nowMs : Math.max(nowMs, existing.updatedAt + 1);
  const envelope = { eventId: crypto.randomUUID(), sessionId: input.sessionId, kind: 'plan', createdAt, channel: 'http', producer: MCP_PRODUCER, payload };
  const bodyBytes = utf8(JSON.stringify(payload)).byteLength;
  const result = await ingestEvent(env.db, { projectId: scope.projectId, machineId: member.machineId, tokenId: member.tokenId, bodyBytes, now: nowMs }, envelope);
  if (!result.persisted || result.projected === false) return { ok: false, code: result.code, error: result.reason ?? 'plan was not recorded' };

  const row = await getPlan(env.db, scope, planKey);
  if (row === null) return { ok: false, error: 'Plan was not recorded' };
  const logicalKey = input.sourcePath !== undefined ? `path:${normalizePlanPath(input.sourcePath)}` : input.planKey !== undefined ? `session:${row.sessionId}:key:${input.planKey}` : planKey;
  return { ok: true, row, logicalKey };
}

/** Sets a plan's status as an administrative edit by a member and answers the row as it stands; null when no such plan sits in the scope. */
export async function changePlanStatus(db: RelationalStore, scope: ReadScope, planKey: string, status: string, by: string, nowMs: number): Promise<ProjectPlanRow | null> {
  await setPlanStatus(db, scope, planKey, status, by, nowMs);
  return getPlan(db, scope, planKey);
}
