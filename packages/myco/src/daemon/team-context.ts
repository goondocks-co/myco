/**
 * Module-level machine identity for team sync. The enablement flag is NOT
 * here anymore — it is per-Grove in `team_sync_state` (read via
 * `getTeamSyncEnabled()`), so the write path can't be gated by the wrong
 * Grove's setting.
 */
import { SYNC_PROTOCOL_VERSION, DEFAULT_MACHINE_ID } from '@myco/constants.js';
import { getMachineId } from './machine-id.js';

let teamMachineId = DEFAULT_MACHINE_ID;

export function initTeamContext(machineId: string): void {
  teamMachineId = machineId;
}

export function getTeamMachineId(): string {
  // Resolve the persisted, machine-global id so every process/context (daemon,
  // MCP server, agent subprocess) gets the real id — not the 'local' default —
  // even when initTeamContext() was never called in this process. An explicit
  // initTeamContext(<id>) still overrides (e.g. tests or daemon startup).
  return teamMachineId !== DEFAULT_MACHINE_ID ? teamMachineId : getMachineId();
}

export function getTeamSyncProtocolVersion(): number {
  return SYNC_PROTOCOL_VERSION;
}

export function resetTeamContext(): void {
  teamMachineId = DEFAULT_MACHINE_ID;
}
