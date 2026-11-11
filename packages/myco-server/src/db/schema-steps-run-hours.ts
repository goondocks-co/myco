import { changing, reaching, type SchemaStep } from './schema-step.js';
import { NEXT_RUN_HOURS } from './schema-vNEXT-run-hours.js';
import { FACT_FILTERS, runHourSchemaStatements } from './runs/run-hours.js';

/**
 * Finished runs are counted once: each finished run writes one fact in the statement that finishes it, a catch-up
 * writes the facts of the runs that finished before, page by page, and each fact inserted adds to its hour's counters.
 * Facts are read across Projects by when the run ended and by each value the Runs page narrows by.
 */
export const RUN_HOURS_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_RUN_HOURS,
    statements: runHourSchemaStatements(),
    reaches: [
      ...reaching(['agent_runs'], 'A finished run writes its fact in the statement that finishes it.'),
      ...changing(['projection_catchup'], 'The counts start building from every run that finished before, and their readiness moves the runs mark.'),
    ],
    deploymentIndexes: [
      { index: 'idx_run_finished_at', read: 'finished runs across Projects page by when they ended, and expired facts are dropped in that order' },
      ...FACT_FILTERS.map(filter => ({ index: `idx_run_finished_${filter}`, read: `finished runs across Projects narrowed by ${filter} page by when they ended` })),
    ],
  },
];
