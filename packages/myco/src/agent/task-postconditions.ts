import { getState } from '@myco/db/queries/agent-state.js';
import { listReports } from '@myco/db/queries/reports.js';
import { getRun } from '@myco/db/queries/runs.js';
import { countToolCallsByRun } from '@myco/db/queries/turns.js';
import { listWriteIntents } from '@myco/db/queries/write-intents.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import {
  findLatestVaultSetStateValue,
  parseSkillEvolveClassificationPayload,
  parseSkillEvolveInventoryPayload,
  skillEvolveClassificationPayloadsEqual,
  SKILL_EVOLVE_ASSESS_REPORT_ACTION,
  SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY,
  SKILL_EVOLVE_INVENTORY_REPORT_ACTION,
  SKILL_EVOLVE_INVENTORY_STATE_KEY,
  SKILL_EVOLVE_TASK_NAME,
} from './skill-evolve-output.js';

interface PostconditionInput {
  runId: string;
  taskName?: string;
  dryRun?: boolean;
}

type PostconditionValidator = (input: PostconditionInput) => string | null;

function validateTitleSummaryRun({ runId }: PostconditionInput): string | null {
  const reports = listReports(runId, { scope: ALL_PROJECTS_SCOPE });
  if (reports.length === 0) {
    return 'title-summary completed without calling vault_report';
  }

  if (reports.some((report) => report.action === 'skip')) {
    return null;
  }

  const toolCounts = countToolCallsByRun(runId, ['vault_update_session']);
  if ((toolCounts.vault_update_session ?? 0) > 0) {
    return null;
  }

  return 'title-summary completed without vault_update_session or an explicit skip report';
}

function validateSkillEvolveRun({ runId }: PostconditionInput): string | null {
  const run = getRun(runId, ALL_PROJECTS_SCOPE);
  if (!run) {
    return `skill-evolve run not found: ${runId}`;
  }

  const reports = listReports(runId, { scope: ALL_PROJECTS_SCOPE });
  const inventoryReport = reports.find((report) => report.action === SKILL_EVOLVE_INVENTORY_REPORT_ACTION);
  if (!inventoryReport) {
    return 'skill-evolve completed without a skill-evolve-inventory report';
  }

  const assessReport = reports.find((report) => report.action === SKILL_EVOLVE_ASSESS_REPORT_ACTION);
  if (!assessReport) {
    return 'skill-evolve completed without an assess report';
  }

  const assessPayload = parseSkillEvolveClassificationPayload(assessReport.details);
  if (!assessPayload) {
    return 'skill-evolve assess report details are invalid';
  }
  if (assessPayload.run_id !== runId) {
    return 'skill-evolve assess report run_id does not match the run';
  }

  if (run.dry_run) {
    const intents = listWriteIntents(runId, { scope: ALL_PROJECTS_SCOPE });
    const inventoryIntentValue = findLatestVaultSetStateValue(intents, SKILL_EVOLVE_INVENTORY_STATE_KEY);
    const classificationIntentValue = findLatestVaultSetStateValue(intents, SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY);

    const inventoryPayload = parseSkillEvolveInventoryPayload(inventoryIntentValue);
    if (!inventoryPayload) {
      return 'skill-evolve dry-run completed without a valid skill-evolve-inventory write intent';
    }
    if (inventoryPayload.run_id !== runId) {
      return 'skill-evolve inventory write intent run_id does not match the run';
    }

    const classificationPayload = parseSkillEvolveClassificationPayload(classificationIntentValue);
    if (!classificationPayload) {
      return 'skill-evolve dry-run completed without a valid skill-evolve-classifications write intent';
    }
    if (classificationPayload.run_id !== runId) {
      return 'skill-evolve classifications write intent run_id does not match the run';
    }
    if (!skillEvolveClassificationPayloadsEqual(classificationPayload, assessPayload)) {
      return 'skill-evolve classifications write intent does not match assess report';
    }

    return null;
  }

  if (!run.project_id) {
    return 'skill-evolve completed without a project scope for state validation';
  }

  const inventoryState = getState(run.agent_id, run.project_id, SKILL_EVOLVE_INVENTORY_STATE_KEY);
  const inventoryPayload = parseSkillEvolveInventoryPayload(inventoryState?.value);
  if (!inventoryPayload) {
    return 'skill-evolve completed without valid skill-evolve-inventory state';
  }
  if (inventoryPayload.run_id !== runId) {
    return 'skill-evolve inventory state run_id does not match the run';
  }

  const classificationState = getState(run.agent_id, run.project_id, SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY);
  const classificationPayload = parseSkillEvolveClassificationPayload(classificationState?.value);
  if (!classificationPayload) {
    return 'skill-evolve completed without valid skill-evolve-classifications state';
  }
  if (classificationPayload.run_id !== runId) {
    return 'skill-evolve classifications state run_id does not match the run';
  }
  if (!skillEvolveClassificationPayloadsEqual(classificationPayload, assessPayload)) {
    return 'skill-evolve classifications state does not match assess report';
  }

  return null;
}

const TASK_POSTCONDITION_RULES: Array<{
  taskNames: string[];
  validate: PostconditionValidator;
}> = [
  {
    taskNames: ['title-summary'],
    validate: validateTitleSummaryRun,
  },
  {
    taskNames: [SKILL_EVOLVE_TASK_NAME],
    validate: validateSkillEvolveRun,
  },
];

export function validateTaskPostconditions(input: PostconditionInput): string | null {
  if (input.dryRun && input.taskName !== SKILL_EVOLVE_TASK_NAME) {
    return null;
  }
  for (const rule of TASK_POSTCONDITION_RULES) {
    if (input.taskName && rule.taskNames.includes(input.taskName)) {
      return rule.validate(input);
    }
  }
  return null;
}
