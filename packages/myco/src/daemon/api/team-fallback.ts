import { TEAM_SOURCE_PREFIX } from '@myco/constants.js';
import type { TeamSyncClient } from '../team-sync.js';

/** Dependencies for team fallback on get-by-id handlers. */
export interface TeamFallbackDeps {
  getTeamClient?: () => TeamSyncClient | null;
  machineId?: string;
}

/**
 * Build a `source:` tag for a record — `local` when present, `team:<id>` when
 * claimed by a known teammate, bare `team` when the record has no machine id.
 */
export function tagSource(recordMachineId: string | null | undefined): string {
  if (!recordMachineId) return 'team';
  return `${TEAM_SOURCE_PREFIX}${recordMachineId}`;
}

/**
 * Fetch a record from the connected team's D1 and filter out self-echo.
 *
 * Returns the record tagged with its source when the team has a copy that
 * wasn't originally pushed by us. Returns `null` when no team is connected,
 * the team has no copy, or the copy is our own.
 *
 * Team failures are non-blocking — the inner `try` shields against test
 * mocks that bypass `TeamClient.getRecord`'s own null-on-error contract.
 */
export async function fetchTeamFallback(
  deps: TeamFallbackDeps,
  table: string,
  id: string,
): Promise<{ record: Record<string, unknown>; source: string } | null> {
  const teamClient = deps.getTeamClient?.();
  if (!teamClient) return null;

  let record: Record<string, unknown> | null = null;
  try {
    record = await teamClient.getRecord(table, id);
  } catch {
    record = null;
  }
  if (!record) return null;

  const recordMachineId = typeof record.machine_id === 'string' ? record.machine_id : null;
  if (deps.machineId && recordMachineId === deps.machineId) return null;

  return { record, source: tagSource(recordMachineId) };
}
