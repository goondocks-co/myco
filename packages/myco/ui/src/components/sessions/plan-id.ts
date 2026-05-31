/** Number of leading characters shown before the ellipsis. */
const PLAN_ID_HEAD = 8;

/**
 * Compact display label for a plan id. The full id is always what gets
 * copied; this only shortens the visible text so plan cards stay tidy.
 */
export function truncatePlanId(id: string): string {
  if (id.length <= PLAN_ID_HEAD) return id;
  return `${id.slice(0, PLAN_ID_HEAD)}…`;
}
