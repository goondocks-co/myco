/**
 * Module-level machine identity for team sync. The enablement flag is NOT
 * here anymore — it is per-Grove in `team_sync_state` (read via
 * `getTeamSyncEnabled()`), so the write path can't be gated by the wrong
 * Grove's setting.
 */
import { SYNC_PROTOCOL_VERSION, DEFAULT_MACHINE_ID } from '@myco/constants.js';

let teamMachineId = DEFAULT_MACHINE_ID;

export function initTeamContext(machineId: string): void {
  teamMachineId = machineId;
}

export function getTeamMachineId(): string {
  return teamMachineId;
}

export function getTeamSyncProtocolVersion(): number {
  return SYNC_PROTOCOL_VERSION;
}

export function resetTeamContext(): void {
  teamMachineId = DEFAULT_MACHINE_ID;
}
