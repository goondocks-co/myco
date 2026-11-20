import { notifyTelemetrySessions } from '../db/telemetry/changes.js';
import { withTelemetryInputs, telemetryTraceSnapshot } from '../db/telemetry/inputs.js';
import { normalizeRemote } from '@goondocks/myco-shared/member-protocol';
import type { RelationalStore } from './adapters.js';
import {
  inferTelemetrySessions,
  finishTelemetryWait,
  telemetrySessionsNamed,
  telemetryTraceSpans,
  telemetryTracesDue,
  telemetrySnapshotChanged,
  type InferenceMatch,
  type Resolution,
  type SessionIdentity,
  type StoredSpan,
  type TraceRef,
} from '../db/telemetry/matching.js';
import { TELEMETRY_ANCESTOR_LIMIT, TELEMETRY_MATCH_WAIT_MS } from './telemetry-policy.js';

/** The nearest differently named ancestor in the trace; cycles and overlong ancestry supply no parent. */
function ancestor(
  span: StoredSpan,
  byId: ReadonlyMap<string, StoredSpan>,
): { span: StoredSpan; keys: string[] } | null {
  const keys = new Set([span.key_id]);
  const seen = new Set([span.span_id]);
  let parent = span.parent_span_id;
  let nearest: StoredSpan | null = null;
  for (let depth = 0; parent !== null && depth < TELEMETRY_ANCESTOR_LIMIT; depth++) {
    if (seen.has(parent)) return null;
    seen.add(parent);
    const held = byId.get(parent);
    if (held === undefined) return nearest === null ? null : { span: nearest, keys: [...keys] };
    keys.add(held.key_id);
    if (nearest === null && held.conversation_id !== null && held.conversation_id !== span.conversation_id)
      nearest = held;
    parent = held.parent_span_id;
  }
  return parent === null && nearest !== null ? { span: nearest, keys: [...keys] } : null;
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
  const owned = spans.filter((span) => span.key_id === trace.key_id);
  if (owned.length === 0) return 0;
  const byId = new Map(spans.map((span) => [span.span_id, span]));
  const ancestors = new Map(owned.map((span) => [span.span_id, ancestor(span, byId)]));
  const namedIds = [
    ...new Set(
      owned
        .flatMap((span) => [span.conversation_id, ancestors.get(span.span_id)?.span.conversation_id ?? null])
        .filter((id): id is string => id !== null),
    ),
  ];
  const dependencies = {
    ids: expired ? [] : namedIds,
    windows: expired
      ? []
      : owned.flatMap((span) => {
          const attrs = JSON.parse(span.attributes) as Record<string, unknown>;
          const remote =
            typeof attrs['vcs.repository.url.full'] === 'string'
              ? normalizeRemote(attrs['vcs.repository.url.full'])
              : null;
          return span.conversation_id === null &&
            span.operation === 'invoke_agent' &&
            remote !== null &&
            typeof attrs['vcs.ref.head.name'] === 'string'
            ? [{ spanId: span.span_id, remote, ref: attrs['vcs.ref.head.name'], start: span.start_ms }]
            : [];
        }),
  };
  try {
    return await withTelemetryInputs(db, { trace, now, dependencies }, async () => {
      const named = await telemetrySessionsNamed(db, [
        ...new Set(spans.flatMap((span) => (span.conversation_id === null ? [] : [span.conversation_id]))),
      ]);
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
      const matches: InferenceMatch[] = [];
      for (const span of owned) {
        if (span.conversation_id !== null || span.operation !== 'invoke_agent') continue;
        const parent = exact(ancestors.get(span.span_id)?.span.conversation_id ?? null);
        if (parent === null) continue;
        const detail = details.get(span.span_id)!;
        if (detail.repository !== null && detail.ref !== null && detail.ref !== '')
          matches.push({
            traceId: span.trace_id,
            spanId: span.span_id,
            remote: detail.repository,
            branch: detail.ref,
            start: span.start_ms,
            parent: parent.session_id,
            parentProject: parent.project_id,
            agent: span.agent_name,
          });
      }
      const inferred = await inferTelemetrySessions(db, matches);
      const remotes = new Map(matches.map((match) => [match.spanId, match.remote]));
      const resolutions: Resolution[] = [];
      for (const span of owned) {
        const ancestry = ancestors.get(span.span_id) ?? null,
          parentSpan = ancestry?.span,
          parent = exact(parentSpan?.conversation_id ?? null);
        const invocation = span.operation === 'invoke_agent';
        const matchedBy = span.conversation_id === null ? 'inferred' : 'exact';
        const session =
          span.conversation_id === null ? (inferred.get(span.span_id) ?? null) : exact(span.conversation_id);
        if (session === null || (!invocation && parent === null)) continue;
        resolutions.push({
          ...session,
          evidence: JSON.stringify(
            [
              ...new Set([
                span.key_id,
                ...(ancestry?.keys ?? []),
                ...(JSON.parse(inferred.get(span.span_id)?.evidence ?? '[]') as string[]),
              ]),
            ].sort(),
          ),
          ...details.get(span.span_id)!,
          agent_name: span.agent_name,
          ...(remotes.has(span.span_id) ? { inferenceRemote: remotes.get(span.span_id)! } : {}),
          span_id: span.span_id,
          key_id: span.key_id,
          parent_span_id: parent === null ? null : (parentSpan?.span_id ?? null),
          parent_project_id: parent?.project_id ?? null,
          parent_session_id: parent?.session_id ?? null,
          matched_by: matchedBy,
          invocation: invocation ? 1 : 0,
        });
      }
      return {
        resolutions,
        pending:
          !expired &&
          (owned.some((span) => span.conversation_id !== null && exact(span.conversation_id) === null) ||
            matches.some((match) => !inferred.has(match.spanId))),
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
  for (const trace of await telemetryTracesDue(db, now)) matched += await reconcileTelemetryTrace(db, trace, now);
  return matched;
}
