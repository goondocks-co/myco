/**
 * Team Host member drain health — the status-API half of consolidation Task
 * C-5 (routed-capture observability). The three member drains
 * (`capture/transcript-drain.ts`, `capture/plan-drain.ts`,
 * `capture/event-replay-drain.ts`) are warn-only: a failed POST logs and
 * retries next tick, with nothing outside the log stream saying WHY a host
 * hasn't converged. This route exposes each drain's `health()` summary
 * (derived from the SAME persisted queue state the drains themselves read —
 * no new store, no network call) so the member daemon's own dashboard can
 * show it.
 *
 *   GET /api/team-host/drain-health
 *
 * `localhost-only` (`host/routing.ts` ROUTE_RULES): this reports on THIS
 * machine's own outbound drains to every host it has joined — never
 * proxied, and never meaningful to answer on behalf of another machine.
 *
 * Response shape (documented here for consolidation Task D-2, the Team page
 * consumer):
 *
 *   {
 *     "hosts": [
 *       {
 *         "host_id": "host_...",
 *         "label": "my-host",
 *         "drains": {
 *           "transcript":   { "pending_entries": 2, "pending_bytes":   4096, "failing_entries": 0, "host_unreachable_entries": 0 },
 *           "plan":         { "pending_entries": 0,                          "failing_entries": 0, "host_unreachable_entries": 0 },
 *           "event_replay": { "pending_entries": 1, "pending_records":    3, "failing_entries": 1, "host_unreachable_entries": 1 }
 *         }
 *       }
 *     ]
 *   }
 *
 * `pending_bytes` / `pending_records` are omitted (not zero) when a drain has
 * nothing pending and nothing to size. Every joined host (from the
 * machine-global host registry) appears exactly once, even one with zero
 * counters across all three drains — the UI's "healthy, nothing to show" case,
 * not an absent row. This route does NOT probe live reachability (see `myco
 * doctor`'s Team Host check for that) — it is a cheap, poll-friendly summary
 * of persisted drain state only.
 */
import type { EventReplayDrainQueue } from '../../capture/event-replay-drain.js';
import type { PlanDrainQueue } from '../../capture/plan-drain.js';
import type { TranscriptDrainQueue } from '../../capture/transcript-drain.js';
import type { DrainHealthCounters } from '../../capture/drain-health.js';
import { readHostRegistry } from '../../host/registry.js';
import type { RouteHandler, RouteRegistrar, RouteResponse } from '../router.js';

export interface DrainHealthRouteDeps {
  transcriptDrain: Pick<TranscriptDrainQueue, 'health'>;
  planDrain: Pick<PlanDrainQueue, 'health'>;
  eventReplayDrain: Pick<EventReplayDrainQueue, 'health'>;
}

interface WireDrainCounters {
  pending_entries: number;
  pending_bytes?: number;
  pending_records?: number;
  failing_entries: number;
  host_unreachable_entries: number;
}

const EMPTY_COUNTERS: DrainHealthCounters = { pendingEntries: 0, failingEntries: 0, hostUnreachableEntries: 0 };

function toWire(counters: DrainHealthCounters, unitsField: 'pending_bytes' | 'pending_records'): WireDrainCounters {
  const wire: WireDrainCounters = {
    pending_entries: counters.pendingEntries,
    failing_entries: counters.failingEntries,
    host_unreachable_entries: counters.hostUnreachableEntries,
  };
  if (counters.pendingUnits !== undefined) wire[unitsField] = counters.pendingUnits;
  return wire;
}

export function createDrainHealthHandler(deps: DrainHealthRouteDeps): RouteHandler {
  return async (): Promise<RouteResponse> => {
    const transcriptHealth = deps.transcriptDrain.health();
    const planHealth = deps.planDrain.health();
    const eventReplayHealth = deps.eventReplayDrain.health();

    // Every joined host appears once, even with zero counters everywhere —
    // "healthy" is a row, not an absence.
    const hosts = readHostRegistry().map((host) => ({
      host_id: host.host_id,
      label: host.label,
      drains: {
        transcript: toWire(transcriptHealth.get(host.host_id) ?? EMPTY_COUNTERS, 'pending_bytes'),
        plan: toWire(planHealth.get(host.host_id) ?? EMPTY_COUNTERS, 'pending_bytes'),
        event_replay: toWire(eventReplayHealth.get(host.host_id) ?? EMPTY_COUNTERS, 'pending_records'),
      },
    }));

    return { status: 200, body: { hosts } };
  };
}

/** Register the drain-health route on the daemon server. */
export function registerDrainHealthRoute(server: RouteRegistrar, deps: DrainHealthRouteDeps): void {
  server.registerRoute('GET', '/api/team-host/drain-health', createDrainHealthHandler(deps));
}
