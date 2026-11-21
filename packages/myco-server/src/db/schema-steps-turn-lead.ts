import { NEXT_TURN_LEAD } from './schema-vNEXT-turn-lead.js';
import { changing, type SchemaStep } from './schema-step.js';

/** A turn's lead facts are written when it next settles; turns settled before this step keep none and lead with their speaker. */
export const TURN_LEAD_STEPS: readonly SchemaStep[] = [{
  version: NEXT_TURN_LEAD,
  statements: ['ALTER TABLE session_prompts ADD COLUMN lead_facts TEXT'],
  reaches: changing(['session_prompts'], 'A nullable column; existing turns are not rebuilt and hold none.'),
}];
