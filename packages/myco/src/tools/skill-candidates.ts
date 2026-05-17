/**
 * myco_skill_candidates — agent-facing CRUD for skill candidates.
 *
 * Closes the agent-native gap where agents could produce candidates
 * via skill-survey but could not triage them. The REST surface
 * (/api/skill-candidates*) already exists; this tool wraps it so an
 * MCP client can list, fetch, update (incl. defer/dismiss), or delete
 * candidates without driving the UI.
 *
 * Transition policy mirrors the daemon-side `AGENT_SETTABLE_STATUSES`
 * gate: 'identified', 'dismissed', and 'deferred' are agent-allowed;
 * 'approved' and 'generated' are rejected pre-flight with a typed
 * error so the agent gets a useful message instead of a 400 from the
 * daemon.
 */

import { DaemonClient } from '@myco/hooks/client.js';
import { ToolError, type ToolFailure } from './error.js';
import { requestContextHeaders, type MycoRequestContext } from './request-context.js';

export const SKILL_CANDIDATE_OPS = ['list', 'get', 'update', 'delete'] as const;
export type SkillCandidateOp = typeof SKILL_CANDIDATE_OPS[number];

/**
 * Statuses the agent surface is allowed to write through this tool.
 * Mirrors AGENT_SETTABLE_STATUSES on the daemon side; duplicated here
 * so the agent can be rejected pre-flight instead of relying on the
 * daemon's 400. Keep in sync with constants/skill-candidate-status.ts.
 */
const AGENT_SETTABLE_STATUSES = new Set(['identified', 'dismissed', 'deferred']);

export interface SkillCandidatesInput {
  op?: SkillCandidateOp;
  id?: string;
  status?: string;
  /** list — limit override (default DEFAULT_LIST_LIMIT on the daemon). */
  limit?: number;
  /** list — pagination offset. */
  offset?: number;
  /** list — comma-separated status filter (e.g. "identified,deferred"). */
  status_filter?: string;
  /** update — any candidate metadata field the REST surface accepts. */
  fields?: Record<string, unknown>;
}

export async function handleMycoSkillCandidates(
  input: SkillCandidatesInput,
  client: DaemonClient,
  requestContext?: MycoRequestContext,
): Promise<unknown | ToolFailure> {
  const op = input.op ?? 'list';
  if (!SKILL_CANDIDATE_OPS.includes(op)) {
    throw new ToolError('invalid_input', `Unknown op '${op}' for myco_skill_candidates`);
  }

  const headers = requestContext ? requestContextHeaders(requestContext) : undefined;

  switch (op) {
    case 'list': {
      const params = new URLSearchParams();
      if (input.status_filter) params.set('status', input.status_filter);
      if (typeof input.limit === 'number') params.set('limit', String(input.limit));
      if (typeof input.offset === 'number') params.set('offset', String(input.offset));
      const qs = params.toString();
      const endpoint = qs ? `/api/skill-candidates?${qs}` : '/api/skill-candidates';
      const result = headers
        ? await client.get(endpoint, { headers })
        : await client.get(endpoint);
      if (!result.ok || !result.data) {
        throw new ToolError('tool_call_failed', extractError(result) ?? 'Candidate list unavailable');
      }
      return result.data;
    }

    case 'get': {
      if (!input.id) throw new ToolError('invalid_input', 'id is required for op: get');
      const endpoint = `/api/skill-candidates/${encodeURIComponent(input.id)}`;
      const result = headers
        ? await client.get(endpoint, { headers })
        : await client.get(endpoint);
      if (!result.ok || !result.data) {
        const message = extractError(result) ?? `Candidate not found: ${input.id}`;
        return { error: message };
      }
      return result.data;
    }

    case 'update': {
      if (!input.id) throw new ToolError('invalid_input', 'id is required for op: update');
      // Pre-flight: reject status writes the agent isn't allowed to make.
      // The daemon enforces the same gate; this just gives a clearer
      // error before the round-trip.
      if (input.status !== undefined && !AGENT_SETTABLE_STATUSES.has(input.status)) {
        throw new ToolError(
          'invalid_input',
          `Status '${input.status}' is not agent-settable. Allowed: ${[...AGENT_SETTABLE_STATUSES].join(', ')}. ` +
          `Approved is a human-only transition via the UI; generated is internal.`,
        );
      }
      const body: Record<string, unknown> = { ...(input.fields ?? {}) };
      if (input.status !== undefined) body.status = input.status;
      if (Object.keys(body).length === 0) {
        throw new ToolError('invalid_input', 'update requires status or fields');
      }
      const endpoint = `/api/skill-candidates/${encodeURIComponent(input.id)}`;
      const result = headers
        ? await client.put(endpoint, body, { headers })
        : await client.put(endpoint, body);
      if (!result.ok) {
        throw new ToolError('tool_call_failed', extractError(result) ?? 'Candidate update failed');
      }
      return result.data ?? { ok: true };
    }

    case 'delete': {
      if (!input.id) throw new ToolError('invalid_input', 'id is required for op: delete');
      const endpoint = `/api/skill-candidates/${encodeURIComponent(input.id)}`;
      const result = headers
        ? await client.delete(endpoint, undefined, { headers })
        : await client.delete(endpoint);
      if (!result.ok) {
        throw new ToolError('tool_call_failed', extractError(result) ?? 'Candidate delete failed');
      }
      return result.data ?? { ok: true };
    }
  }
}

function extractError(result: { data?: unknown }): string | null {
  const body = result.data;
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === 'string') return err;
  }
  return null;
}
