import { changing, reaching, retiring, type SchemaStep } from './schema-step.js';
import { NEXT_S9A } from './schema-vNEXT-s9a.js';
import { planMetadataSchemaStatements } from './plans/metadata.js';
import { projectActivitySchemaStatements } from './activity/schema.js';

/**
 * Plan lists read metadata and the activity feed reads one maintained relation: each plan keeps its preview and progress
 * beside it, the plan list across Projects walks the edit instant, the Project and the plan (and the same under one
 * status), and every session, run, active spore and plan keeps its feed row in the statement that writes it. Both
 * derived tables start building, and a catch-up adds the existing records page by page. No statement here reads an
 * existing table's rows beyond the catch-up seeds' existence checks.
 */
export const VNEXT_S9A_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_S9A,
    statements: [
      ...planMetadataSchemaStatements(),
      'DROP INDEX IF EXISTS idx_plans_updated_deployment',
      'CREATE INDEX IF NOT EXISTS idx_plans_across ON plans(updated_at,project_id,plan_key)',
      'CREATE INDEX IF NOT EXISTS idx_plans_across_status ON plans(status,updated_at,project_id,plan_key)',
      ...projectActivitySchemaStatements(),
    ],
    retires: retiring('index', ['idx_plans_updated_deployment'],
      'The plan list across Projects now orders by the edit instant, the Project and then the plan; idx_plans_across serves that order.'),
    reaches: [
      ...reaching(['plans'], 'Each plan keeps its list metadata and its feed row in the statement that writes it, and the list across Projects walks its own index.'),
      ...reaching(['sessions', 'agent_runs', 'spores', 'session_tombstones'],
        'Each session, run and active spore keeps its feed row in the statement that writes it, and a session\'s tombstone hides it and its plans from the feed.'),
      ...changing(['projection_catchup'], 'Plan metadata and the activity feed start building, so their readers say so until every existing record is added.'),
    ],
    deploymentIndexes: [
      { index: 'idx_plans_across', read: 'the plan list across Projects pages by the edit instant, the Project and the plan' },
      { index: 'idx_plans_across_status', read: 'the plan list across Projects under one status pages by the edit instant, the Project and the plan' },
    ],
  },
];
