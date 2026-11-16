import { PROJECT_ID_GRAMMAR } from './project-id.js';
import type { SchemaStep } from './schema-step.js';
import { NEXT_TOOL_DELIVERY } from './schema-vNEXT-tool-delivery.js';

/** Native request keys connect a rendered context record to its transcript-owned prompt. */
export const TOOL_DELIVERY_STEPS: readonly SchemaStep[] = [{
  version: NEXT_TOOL_DELIVERY,
  statements: [
    `CREATE TABLE IF NOT EXISTS tool_prompt_links (
      project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL, prompt_id TEXT NOT NULL,
      PRIMARY KEY(project_id,session_id,tool_call_id))`,
    `CREATE TABLE IF NOT EXISTS context_delivery_anchors (
      project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), session_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('spore_injections','prompt_context_answers','session_injections')),
      record_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
      PRIMARY KEY(project_id,session_id,kind,record_id))`,
    'CREATE INDEX IF NOT EXISTS idx_context_delivery_anchors_tool ON context_delivery_anchors(project_id,session_id,tool_call_id,kind,record_id)',
  ],
}];
