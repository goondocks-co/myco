import { useQuery } from '@tanstack/react-query';
import type { StoredKeyFailure } from '@goondocks/myco-shared/run-diagnostic';
import type { FleetQueue, RunnerCredentialChoice, RunnerFallbackNotice, StoredKeyFailureNotice } from '@goondocks/myco-shared/runner-fleet';
import { fetchJson, type RunnerRow, type WorkerRow } from '../lib/api';
import { live } from '../lib/live';

/** `GET /api/runners`: the active runners, legacy workers, the queue, and for an admin which agents have a usable stored key. */
export interface FleetAnswer {
  observedAt: number;
  runners: RunnerRow[];
  legacyWorkers: WorkerRow[];
  queue: FleetQueue;
  storedCredentials?: Record<string, boolean>;
  cursor?: string | null;
  totals?: { active: number };
}

export const RUNNERS_KEY = ['runners'] as const;

/** The runners as the server reads them, read again as the fleet and runs move. */
export function useFleet() {
  return useQuery({ queryKey: RUNNERS_KEY, queryFn: ({ signal }) => fetchJson<FleetAnswer>('/api/runners', signal), ...live<FleetAnswer>({ follows: ['fleet', 'runs'] }) });
}

/** `GET /api/runners/agents`: every agent a registered runner offers installed, what each runner pays with, and which agent each uses today. */
export interface AgentPayersAnswer {
  agents: Array<{ agent: string; storedUsable: boolean; storedFailure?: StoredKeyFailure; fallbacks?: Array<RunnerFallbackNotice & { runnerId: string }>; waiting?: Array<StoredKeyFailureNotice & { runnerId: string }>; runners: Array<{ id: string; name: string; choice: RunnerCredentialChoice | null }> }>;
  today: Array<{ id: string; name: string; agent: string | null }>;
}

/** Who pays for each agent on every registered runner, read under the runners' key so a fleet change reads it again. */
export function useAgentPayers(enabled = true) {
  return useQuery({ queryKey: [...RUNNERS_KEY, 'agents'], enabled, queryFn: ({ signal }) => fetchJson<AgentPayersAnswer>('/api/runners/agents', signal), ...live<AgentPayersAnswer>({ follows: ['fleet', 'runs'] }) });
}
