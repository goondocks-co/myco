import { RETAINED_TASKS, TASK_WORDS, TASK_TIERS } from '../../packages/myco-server/src/core/task-catalogue';
import { RUN_CLOSE_RULES } from '../../packages/myco-server/src/core/run-postconditions';
import { readWindowFor } from '../../packages/myco-server/src/core/read-window';
import { startableByHand } from '../../packages/myco-server/src/read/task-descriptions';
import type { TaskDescription } from '../../packages/myco-server/ui/src/features/tasks/wire';

/** Task facts read from the server definitions, with no configured model in this fixture. */
export const TASK_DESCRIPTIONS: TaskDescription[] = RETAINED_TASKS.map((task) => ({
  task, name: TASK_WORDS[task]!.name, description: TASK_WORDS[task]!.description,
  triggers: [], tools: [], done: RUN_CLOSE_RULES[task]!.description,
  budget: { timeoutSeconds: 300, readWindow: readWindowFor(task) }, tier: TASK_TIERS[task] ?? null,
  profiles: [], profileNote: null, availabilityNote: null, startable: startableByHand(task),
  promptTemplate: null, standingRules: null, templateVariants: [],
}));
