import { refreshTelemetryWork } from '../db/telemetry/work.js';
import { notifyTelemetrySessions } from '../db/telemetry/changes.js';
import { withTelemetryInputs, telemetryTraceSnapshot } from '../db/telemetry/inputs.js';
import { normalizeRemote } from '@goondocks/myco-shared/member-protocol';
import type { RelationalStore } from './adapters.js';
import {
  finishTelemetryWait,
  telemetrySessionsNamed,
  telemetryTraceSpans,
  telemetryTracesDue,
  telemetrySnapshotChanged,
  type Resolution,
  type SessionIdentity,
  type StoredSpan,
  type TraceRef,
} from '../db/telemetry/matching.js';
import { TELEMETRY_ANCESTOR_LIMIT, TELEMETRY_MATCH_WAIT_MS } from './telemetry-policy.js';

/** The nearest differently named ancestor in the trace; cycles and overlong ancestry supply no parent. */
function ancestor(span: StoredSpan, byId: ReadonlyMap<string, StoredSpan>): StoredSpan | null {
  const seen = new Set([span.span_id]);
  let parent = span.parent_span_id;
  let nearest: StoredSpan | null = null;
  for (let depth = 0; parent !== null && depth < TELEMETRY_ANCESTOR_LIMIT; depth++) {
    if (seen.has(parent)) return null;
    seen.add(parent);
    const held = byId.get(parent);
    if (held === undefined) return nearest;
    if (nearest === null && held.conversation_id !== null && held.conversation_id !== span.conversation_id)
      nearest = held;
    parent = held.parent_span_id;
  }
  return parent === null ? nearest : null;
}

/** Records canonical session references only; telemetry never creates a session or changes its Project or author. */
async function reconcileTelemetryTrace(db: RelationalStore, trace: TraceRef, now: number): Promise<number> {
  let expired = now - trace.last_received_at >= TELEMETRY_MATCH_WAIT_MS;
  if (expired) {
    await finishTelemetryWait(db, trace, now);
    const fresh = await telemetryTraceSnapshot(db, trace);
    if (fresh === undefined) return 0;
    trace = fresh;
    expired = now - trace.last_received_at >= TELEMETRY_MATCH_WAIT_MS;
  }
  const spans = await telemetryTraceSpans(db, trace);
  const owned = spans;
  if (owned.length === 0) return 0;
  const byId = new Map(spans.map((span) => [span.span_id, span]));
  const ancestors = new Map(owned.map((span) => [span.span_id, ancestor(span, byId)]));
  const namedIds = [
    ...new Set(spans.flatMap((span) => (span.conversation_id === null ? [] : [span.conversation_id]))),
  ];
  const dependencies = { ids: expired ? [] : namedIds };
  try {
    return await withTelemetryInputs(db, { trace, now, dependencies }, async () => {
      const named = await telemetrySessionsNamed(db, namedIds);
      const identities = new Map<string, SessionIdentity[]>();
      for (const identity of named)
        identities.set(identity.session_id, [...(identities.get(identity.session_id) ?? []), identity]);
      const exact = (id: string | null): SessionIdentity | null =>
        id !== null && identities.get(id)?.length === 1 ? identities.get(id)![0]! : null;
      const details = new Map(
        spans.map((span) => {
          const attrs = JSON.parse(span.attributes) as Record<string, string | number>;
          return [
            span.span_id,
            {
              repository:
                typeof attrs['vcs.repository.url.full'] === 'string'
                  ? normalizeRemote(attrs['vcs.repository.url.full'])
                  : null,
              ref: typeof attrs['vcs.ref.head.name'] === 'string' ? attrs['vcs.ref.head.name'] : null,
            },
          ];
        }),
      );
      const resolutions: Resolution[] = [];
      for (const span of owned) {
        const ancestry = ancestors.get(span.span_id) ?? null,
          parentSpan = ancestry ?? undefined,
          parent = exact(parentSpan?.conversation_id ?? null);
        const invocation = span.operation === 'invoke_agent';
        const session = exact(span.conversation_id);
        if (session === null || (!invocation && parent === null)) continue;
        resolutions.push({
          ...session,
          ...details.get(span.span_id)!,
          agent_name: span.agent_name,
          span_id: span.span_id,
          key_id: span.key_id,
          parent_span_id: parent === null ? null : (parentSpan?.span_id ?? null),
          parent_project_id: parent?.project_id ?? null,
          parent_session_id: parent?.session_id ?? null,
          matched_by: 'exact',
          invocation: invocation ? 1 : 0,
        });
      }
      return {
        resolutions,
        pending:
          !expired &&
          owned.some((span) => span.conversation_id !== null && exact(span.conversation_id) === null),
      };
    });
  } catch (error) {
    if (telemetrySnapshotChanged(error)) return 0;
    throw error;
  }
}

/** A bounded wake pass also revisits spans whose sessions or ancestors arrived after the export. */
export async function reconcileTelemetry(db: RelationalStore, now: number): Promise<number> {
  await notifyTelemetrySessions(db);
  let matched = 0;
  for (const trace of await telemetryTracesDue(db, now))
    matched += await reconcileTelemetryTrace(db, trace, now);
  await refreshTelemetryWork(db);
  return matched;
}
