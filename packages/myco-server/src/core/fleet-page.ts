import type { RunnerFleetRecord } from '@goondocks/myco-shared/runner-fleet';

const FLEET_PAGE_DEFAULT = 100;
const FLEET_PAGE_MAX = 200;
const CURSOR_SEPARATOR = '\u0000';

export interface FleetPosition { name: string; id: string }
export interface FleetPage { limit: number; cursor: FleetPosition | null }

const encodeCursor = (name: string, id: string): string => btoa(encodeURIComponent(`${name}${CURSOR_SEPARATOR}${id}`));

function decodeCursor(raw: string): { name: string; id: string } | null {
  let text: string;
  try { text = decodeURIComponent(atob(raw)); } catch { return null; }
  const split = text.indexOf(CURSOR_SEPARATOR);
  return split <= 0 ? null : { name: text.slice(0, split), id: text.slice(split + 1) };
}

/** A page request off the URL, or the code naming what does not read. */
export function parseFleetPage(url: URL): FleetPage | 'invalid_limit' | 'invalid_cursor' {
  const requested = Number(url.searchParams.get('limit') ?? FLEET_PAGE_DEFAULT);
  if (!Number.isSafeInteger(requested) || requested < 1) return 'invalid_limit';
  const limit = Math.min(requested, FLEET_PAGE_MAX);
  const raw = url.searchParams.get('cursor');
  const cursor = raw === null ? null : decodeCursor(raw);
  return raw !== null && cursor === null ? 'invalid_cursor' : { limit, cursor };
}

const after = (runner: Pick<RunnerFleetRecord, 'name' | 'id'>, cursor: { name: string; id: string }): boolean =>
  runner.name > cursor.name || (runner.name === cursor.name && runner.id > cursor.id);

/** One keyset page of the active runners in (name, id) order, stable however the fleet's recency moves. */
export function pageRunners(runners: readonly RunnerFleetRecord[], limit: number, cursor: FleetPosition | null): { rows: RunnerFleetRecord[]; cursor: string | null } {
  const ordered = [...runners].sort((left, right) => left.name === right.name ? (left.id < right.id ? -1 : 1) : (left.name < right.name ? -1 : 1));
  const remaining = cursor === null ? ordered : ordered.filter(runner => after(runner, cursor));
  const rows = remaining.slice(0, limit);
  const last = rows.at(-1);
  return { rows, cursor: remaining.length > limit && last !== undefined ? encodeCursor(last.name, last.id) : null };
}

/** Exact availability across every active runner, whatever page the caller holds. */
export function fleetTotals(runners: readonly RunnerFleetRecord[]) {
  return {
    active: runners.length,
    enabled: runners.filter(runner => runner.state === 'enabled').length,
    paused: runners.filter(runner => runner.state === 'paused').length,
    connected: runners.filter(runner => runner.connected).length,
    busy: runners.filter(runner => runner.busy !== null).length,
    ready: runners.filter(runner => runner.connected && runner.state === 'enabled' && runner.readiness.state === 'ready').length,
  };
}
