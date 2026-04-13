/**
 * Module-level state for team sync.
 *
 * Initialized once by the daemon on startup. Query modules import
 * `isTeamSyncEnabled()` and `getTeamMachineId()` to decide whether
 * to enqueue outbox records on write.
 */

import { SYNC_PROTOCOL_VERSION, DEFAULT_MACHINE_ID } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let teamSyncEnabled = false;
let teamMachineId = DEFAULT_MACHINE_ID;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize team context. Called once on daemon startup.
 */
export function initTeamContext(enabled: boolean, machineId: string): void {
  teamSyncEnabled = enabled;
  teamMachineId = machineId;
}

/**
 * Whether team sync is currently enabled.
 *
 * Query modules check this before enqueuing outbox records.
 */
export function isTeamSyncEnabled(): boolean {
  return teamSyncEnabled;
}

/**
 * The machine ID for this instance.
 */
export function getTeamMachineId(): string {
  return teamMachineId;
}

/**
 * The sync protocol version in use.
 */
export function getTeamSyncProtocolVersion(): number {
  return SYNC_PROTOCOL_VERSION;
}

/**
 * Reset team context (for testing).
 */
export function resetTeamContext(): void {
  teamSyncEnabled = false;
  teamMachineId = DEFAULT_MACHINE_ID;
}
