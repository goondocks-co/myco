import { admissionForTask } from '../../core/task-catalogue.js';
import { capabilityOnSql, projectAcceptsWorkSql } from '../settings/admission.js';

/** Whether the Project the SQL expression `project` names accepts `task`'s work now: live, with the task's capability on. */
export function taskAcceptedSql(project: string, task: string): string {
  const gate = admissionForTask(task);
  return gate?.kind === 'capability' ? capabilityOnSql(project, `'${gate.capability}'`) : projectAcceptsWorkSql(project);
}
