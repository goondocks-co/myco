import { listReports } from '@myco/db/queries/reports.js';
import { countToolCallsByRun } from '@myco/db/queries/turns.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

interface PostconditionInput {
  runId: string;
  taskName?: string;
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

const TASK_POSTCONDITION_RULES: Array<{
  taskNames: string[];
  validate: PostconditionValidator;
}> = [
  {
    taskNames: ['title-summary'],
    validate: validateTitleSummaryRun,
  },
];

export function validateTaskPostconditions(input: PostconditionInput): string | null {
  for (const rule of TASK_POSTCONDITION_RULES) {
    if (input.taskName && rule.taskNames.includes(input.taskName)) {
      return rule.validate(input);
    }
  }
  return null;
}
