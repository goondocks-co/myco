/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Module-level machine identity for team sync.
 *
 * Enablement stays per-Grove in `team_sync_state`; this module only owns the
 * machine identity used to stamp synced rows and outbox records.
 */
import { DEFAULT_MACHINE_ID } from '@myco/constants.js';
import { getMachineId } from '@myco/machine-id.js';

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

export function resetTeamContext(): void {
  teamMachineId = DEFAULT_MACHINE_ID;
}
