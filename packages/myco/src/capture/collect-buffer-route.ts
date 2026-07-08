/**
 * The origin-route stamp for a collect-buffer record.
 *
 * An attached project's collector buffer (`capture/buffer.ts`, written by the
 * host proxy's `bufferAppend`) holds the POST bodies of ALL FIVE collect routes
 * — `/events`, `/events/stop`, `/sessions/register`, `/sessions/unregister`,
 * `/events/sync-transcript-prompts` — in one `<sessionId>.jsonl`. The body alone
 * does not say which route captured it, and the host's per-route handlers are not
 * interchangeable: `/events` rejects a body with no `type` (`event-dispatch.ts`
 * `EventBody.parse`), while a stop/register/unregister body carries no `type`. So
 * the attach-aware replay drain (capture-push §7 task 5, plan C5) must re-forward
 * each buffered body to the SAME host route it was captured on — every one of
 * those handlers is independently replay-tolerant, but only for its own shape.
 *
 * The stamp is a single reserved key on the buffered record. It is written by the
 * host proxy at append time and stripped by the replay drain before forwarding,
 * so the host never sees it. The raw event fields are untouched — a reader that
 * inspects `record.type` / `record.session_id` sees exactly the original body.
 */
export const COLLECT_ROUTE_BUFFER_KEY = '_myco_collect_route';

/** The fallback route for a record with no stamp — a buffer written before the
 *  stamp existed. `/events` is the high-volume live-event route (user_prompt /
 *  tool_use / tool_failure), whose bodies always carry a `type` and so replay
 *  cleanly; a pre-stamp buffer holds only those (the collect proxy stamps every
 *  record going forward). */
export const DEFAULT_COLLECT_ROUTE = '/events';

/** Return a copy of `event` with the origin `route` recorded. Non-mutating so the
 *  caller's own reference (e.g. the enqueue trigger the proxy also feeds) stays
 *  the untouched body. */
export function stampCollectRoute(
  event: Record<string, unknown>,
  route: string,
): Record<string, unknown> {
  return { ...event, [COLLECT_ROUTE_BUFFER_KEY]: route };
}

/** The origin route a buffered record was stamped with, or `null` when unstamped
 *  (a legacy pre-stamp record — the caller applies {@link DEFAULT_COLLECT_ROUTE}). */
export function readCollectRoute(record: Record<string, unknown>): string | null {
  const route = record[COLLECT_ROUTE_BUFFER_KEY];
  return typeof route === 'string' && route.length > 0 ? route : null;
}

/** The buffered record with the reserved route key removed — the body to forward
 *  to the host so it never observes the member-side stamp. */
export function stripCollectRoute(record: Record<string, unknown>): Record<string, unknown> {
  if (!(COLLECT_ROUTE_BUFFER_KEY in record)) return record;
  const { [COLLECT_ROUTE_BUFFER_KEY]: _omit, ...rest } = record;
  return rest;
}
