import { changing, reaching, retiring, type SchemaStep } from './schema-step.js';
import { NEXT_PLAN_CURATION } from './schema-vNEXT-plan-curation.js';
import { markdownPlanProgressStatements } from './plans/metadata.js';
import { resolvedPlanDocumentStatements } from './search/documents-schema.js';
import { spendTriggers } from './runs/admission.js';

const PLAN_METADATA_TRIGGERS = ['plan_metadata_insert', 'plan_metadata_update', 'plan_metadata_delete'];
const PLAN_DOCUMENT_TRIGGERS = ['insert', 'update', 'delete'].map((event) => `search_documents_plan_${event}`);

/**
 * Plans are curated: each plan carries how it was resolved (a note, when, the plan that superseded it, the evidence the
 * decision cited) and when curation last reviewed it, and stale live plans are read by an index on the instant they
 * last moved. A past plan's search document carries its note. Plan progress is read as Markdown, and the plan metadata
 * catch-up restarts so every existing plan's progress is re-derived. The run accounting triggers are rebuilt so the
 * plan curation task's spend is counted like every other worker task's.
 */
export const VNEXT_PLAN_CURATION_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_PLAN_CURATION,
    statements: [
      'ALTER TABLE plans ADD COLUMN resolution_note TEXT',
      'ALTER TABLE plans ADD COLUMN resolved_at INTEGER',
      'ALTER TABLE plans ADD COLUMN superseded_by TEXT',
      'ALTER TABLE plans ADD COLUMN outcome_refs TEXT CHECK (outcome_refs IS NULL OR json_valid(outcome_refs))',
      'ALTER TABLE plans ADD COLUMN reviewed_at INTEGER',
      'ALTER TABLE plans ADD COLUMN curated_by_run TEXT',
      'CREATE INDEX IF NOT EXISTS idx_plans_curation_due ON plans(project_id,status,MAX(updated_at,COALESCE(reviewed_at,0)),plan_key)',
      ...markdownPlanProgressStatements(),
      ...resolvedPlanDocumentStatements(),
      ...spendTriggers().flatMap((trigger) => [`DROP TRIGGER IF EXISTS ${trigger.name}`, trigger.sql]),
    ],
    retires: [
      ...retiring('trigger', PLAN_METADATA_TRIGGERS, 'Plan progress is read as Markdown: every list marker counts, and fenced examples do not.'),
      ...retiring('trigger', PLAN_DOCUMENT_TRIGGERS, 'A past plan is also found by its resolution note.'),
      ...retiring('trigger', spendTriggers().map((trigger) => trigger.name), 'Run accounting counts the plan curation task among the worker tasks.'),
    ],
    reaches: [
      ...changing(['plans'], 'Each plan carries how it was resolved and when curation last reviewed it; stale live plans are read by the instant they last moved.'),
      ...changing(['projection_catchup'], 'Plan metadata is re-derived for every existing plan with Markdown-aware progress.'),
      ...reaching(['agent_run_attempts', 'agent_runs', 'attempt_spend'], 'Run accounting triggers are rebuilt with the plan curation task among the worker tasks.'),
    ],
  },
];
