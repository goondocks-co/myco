/**
 * Copyright 2026 Christopher Lovell
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { getState } from '@myco/db/queries/agent-state.js';
import { listReports, type ReportRow } from '@myco/db/queries/reports.js';
import { listWriteIntents } from '@myco/db/queries/write-intents.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import {
  findLatestVaultSetStateValue,
  parseSkillEvolveClassificationPayload,
  parseSkillEvolveInventoryPayload,
  SKILL_EVOLVE_ASSESS_REPORT_ACTION,
  SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY,
  SKILL_EVOLVE_INVENTORY_REPORT_ACTION,
  SKILL_EVOLVE_INVENTORY_STATE_KEY,
  SKILL_EVOLVE_TASK_NAME,
} from './skill-evolve-output.js';

interface PhaseRecoveryContextInput {
  taskName: string;
  phaseName: string;
  runId: string;
  agentId: string;
  requestContext?: MycoRequestContext;
  dryRun?: boolean;
  restoredPhaseNames: ReadonlySet<string>;
}

interface RecoverySource {
  prerequisitePhase: string;
  stateKey: string;
  reportAction: string;
  readPayload: (value: unknown) => unknown | null;
}

function recoverySourceForPhase(input: PhaseRecoveryContextInput): RecoverySource | null {
  if (input.taskName !== SKILL_EVOLVE_TASK_NAME) return null;
  if (input.phaseName === 'assess' && input.restoredPhaseNames.has('inventory')) {
    return {
      prerequisitePhase: 'inventory',
      stateKey: SKILL_EVOLVE_INVENTORY_STATE_KEY,
      reportAction: SKILL_EVOLVE_INVENTORY_REPORT_ACTION,
      readPayload: parseSkillEvolveInventoryPayload,
    };
  }
  if (input.phaseName === 'act' && input.restoredPhaseNames.has('assess')) {
    return {
      prerequisitePhase: 'assess',
      stateKey: SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY,
      reportAction: SKILL_EVOLVE_ASSESS_REPORT_ACTION,
      readPayload: parseSkillEvolveClassificationPayload,
    };
  }
  return null;
}

function readStateValue(input: PhaseRecoveryContextInput, stateKey: string): unknown {
  if (input.dryRun) {
    const intents = listWriteIntents(input.runId, { scope: ALL_PROJECTS_SCOPE });
    return findLatestVaultSetStateValue(intents, stateKey);
  }

  const projectId = input.requestContext?.projectId;
  if (!projectId) return undefined;
  return getState(input.agentId, projectId, stateKey)?.value;
}

function latestReport(runId: string, action: string): ReportRow | null {
  const reports = listReports(runId, { scope: ALL_PROJECTS_SCOPE })
    .filter((report) => report.action === action);
  return reports.length > 0 ? reports[reports.length - 1] : null;
}

function jsonBlock(value: unknown): string {
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}

export function buildPhaseRecoveryContext(input: PhaseRecoveryContextInput): string | null {
  const source = recoverySourceForPhase(input);
  if (!source) return null;

  const payload = source.readPayload(readStateValue(input, source.stateKey));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if ((payload as { run_id?: unknown }).run_id !== input.runId) return null;

  const report = latestReport(input.runId, source.reportAction);
  const parts = [
    '## Durable Phase Recovery Context',
    `Prerequisite phase "${source.prerequisitePhase}" was restored from a checkpoint. Use the persisted state below as the durable input for this phase; do not rely on the terse prior phase summary alone.`,
    `### ${source.stateKey}`,
    jsonBlock(payload),
  ];

  if (report) {
    parts.push(
      `### Latest ${source.reportAction} report`,
      `summary: ${report.summary}`,
      `details: ${report.details ?? '{}'}`,
    );
  }

  return parts.join('\n\n');
}
