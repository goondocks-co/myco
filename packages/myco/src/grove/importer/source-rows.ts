/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Database } from '@myco/db/client.js';

export interface SourceSessionRow {
  id: string;
  agent: string;
  user: string | null;
  project_root: string | null;
  branch: string | null;
  started_at: number;
  ended_at: number | null;
  status: string | null;
  prompt_count: number | null;
  tool_count: number | null;
  title: string | null;
  summary: string | null;
  transcript_path: string | null;
  parent_session_id: string | null;
  parent_session_reason: string | null;
  processed: number | null;
  content_hash: string | null;
  created_at: number;
  embedded: number | null;
  machine_id: string | null;
  synced_at: number | null;
  canopy_injections_offered: number | null;
  canopy_injection_total_tokens: number | null;
  canopy_skips_after_injection: number | null;
  canopy_reads_after_injection: number | null;
  canopy_tokens_saved: number | null;
  canopy_redundant_reads: number | null;
  canopy_map_tool_calls: number | null;
}

export interface SourcePromptBatchRow {
  id: number;
  session_id: string;
  parent_prompt_batch_id: number | null;
  kind: string | null;
  prompt_number: number | null;
  user_prompt: string | null;
  response_summary: string | null;
  classification: string | null;
  started_at: number | null;
  ended_at: number | null;
  status: string | null;
  activity_count: number | null;
  processed: number | null;
  content_hash: string | null;
  created_at: number;
  machine_id: string | null;
  synced_at: number | null;
}

export interface SourceActivityRow {
  id: number;
  session_id: string;
  prompt_batch_id: number | null;
  tool_name: string;
  tool_input: string | null;
  tool_output_summary: string | null;
  file_path: string | null;
  files_affected: string | null;
  duration_ms: number | null;
  success: number | null;
  error_message: string | null;
  timestamp: number;
  processed: number | null;
  content_hash: string | null;
  created_at: number;
  canopy_injection_tokens: number | null;
}

export interface SourceAttachmentRow {
  id: string;
  session_id: string | null;
  prompt_batch_id: number | null;
  file_path: string;
  media_type: string | null;
  description: string | null;
  data: Uint8Array | null;
  content_hash: string | null;
  created_at: number;
}

export interface SourcePlanRow {
  id: string;
  logical_key: string;
  status: string | null;
  author: string | null;
  title: string | null;
  content: string | null;
  source_path: string | null;
  tags: string | null;
  session_id: string | null;
  prompt_batch_id: number | null;
  content_hash: string | null;
  processed: number | null;
  created_at: number;
  updated_at: number | null;
  embedded: number | null;
  machine_id: string | null;
  synced_at: number | null;
}

export interface SourceArtifactRow {
  id: string;
  artifact_type: string | null;
  source_path: string;
  title: string;
  content: string | null;
  last_captured_by: string | null;
  tags: string | null;
  created_at: number;
  updated_at: number | null;
  embedded: number | null;
  machine_id: string | null;
  synced_at: number | null;
}

export interface SourceAgentRow {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  system_prompt_hash: string | null;
  config: string | null;
  source: string | null;
  system_prompt: string | null;
  max_turns: number | null;
  timeout_seconds: number | null;
  tool_access: string | null;
  enabled: number | null;
  created_at: number;
  updated_at: number | null;
}

export interface SourceAgentTaskRow {
  id: string;
  agent_id: string;
  source: string | null;
  display_name: string | null;
  description: string | null;
  prompt: string;
  is_default: number | null;
  tool_overrides: string | null;
  model: string | null;
  config: string | null;
  created_at: number;
  updated_at: number | null;
}

export interface SourceAgentStateRow {
  agent_id: string;
  project_id: string | null;
  key: string;
  value: string;
  updated_at: number;
}

export interface SourceSporeRow {
  id: string;
  agent_id: string;
  session_id: string | null;
  prompt_batch_id: number | null;
  observation_type: string;
  status: string | null;
  content: string;
  context: string | null;
  importance: number | null;
  file_path: string | null;
  tags: string | null;
  content_hash: string | null;
  properties: string | null;
  created_at: number;
  updated_at: number | null;
  embedded: number | null;
  machine_id: string | null;
  synced_at: number | null;
}

export interface SourceEntityRow {
  id: string;
  agent_id: string;
  type: string;
  name: string;
  properties: string | null;
  first_seen: number;
  last_seen: number;
  status: string | null;
  machine_id: string | null;
  synced_at: number | null;
}

export interface SourceEntityMentionRow {
  entity_id: string;
  note_id: string;
  note_type: string;
  agent_id: string;
  machine_id: string | null;
  synced_at: number | null;
}

export interface SourceResolutionEventRow {
  id: string;
  agent_id: string;
  spore_id: string;
  action: string;
  new_spore_id: string | null;
  reason: string | null;
  session_id: string | null;
  created_at: number;
  machine_id: string | null;
  synced_at: number | null;
}

export interface SourceGraphEdgeRow {
  id: string;
  agent_id: string;
  source_id: string;
  source_type: string;
  target_id: string;
  target_type: string;
  type: string;
  session_id: string | null;
  confidence: number | null;
  properties: string | null;
  created_at: number;
  machine_id: string | null;
  synced_at: number | null;
}

export interface SourceCanopyEntryRow {
  project_id: string;
  machine_id: string | null;
  path: string;
  content_hash: string;
  size_bytes: number;
  token_estimate: number;
  line_count: number;
  language: string | null;
  exports_json: string | null;
  imports_json: string | null;
  top_comment: string | null;
  mechanical_updated_at: number;
  llm_description: string | null;
  llm_updated_at: number | null;
  embedded: number | null;
}

export interface SourceAgentRunRow {
  id: string;
  agent_id: string;
  task: string | null;
  instruction: string | null;
  status: string | null;
  harness: string | null;
  provider: string | null;
  model: string | null;
  session_ref: string | null;
  resumable: number | null;
  resume_status: string | null;
  resume_mode: string | null;
  resumed_at: number | null;
  checkpoints: string | null;
  usage_data: string | null;
  started_at: number | null;
  completed_at: number | null;
  tokens_used: number | null;
  cost_usd: number | null;
  actual_cost_usd: number | null;
  estimated_cost_usd: number | null;
  cost_source: string | null;
  cost_data: string | null;
  actions_taken: string | null;
  error: string | null;
  dry_run: number | null;
  reasoning_level: string | null;
  execution_overrides: string | null;
}

export interface SourceAgentReportRow {
  id: number;
  run_id: string;
  agent_id: string;
  action: string;
  summary: string;
  details: string | null;
  created_at: number;
}

export interface SourceAgentTurnRow {
  id: number;
  run_id: string;
  agent_id: string;
  turn_number: number;
  tool_name: string;
  tool_input: string | null;
  tool_output_summary: string | null;
  started_at: number | null;
  completed_at: number | null;
}

export interface SourceAgentRunWriteIntentRow {
  id: number;
  run_id: string;
  phase_id: string | null;
  tool_name: string;
  tool_input: string;
  synthetic_output: string;
  stub_id: string | null;
  recorded_at: number;
}

export interface SourceCanopyMapRow {
  project_id: string;
  machine_id: string | null;
  content: string;
  inputs_hash: string;
  generated_at: number;
  generated_by_run_id: string | null;
  token_estimate: number;
}

export interface SourceDigestExtractRow {
  id: number;
  agent_id: string;
  tier: number;
  content: string;
  substrate_hash: string | null;
  generated_at: number;
  machine_id: string | null;
  synced_at: number | null;
}

export interface SourceDigestExtractRevisionRow {
  id: number;
  agent_id: string;
  tier: number;
  content: string;
  metadata: string | null;
  run_id: string | null;
  parent_revision_id: number | null;
  created_at: number;
}

export interface SourceCortexInstructionsRow {
  id: string;
  agent_id: string;
  content: string;
  input_hash: string;
  source_run_id: string | null;
  generated_at: number;
  machine_id: string | null;
  synced_at: number | null;
}

export interface SourceSkillCandidateRow {
  id: string;
  agent_id: string;
  machine_id: string | null;
  topic: string;
  rationale: string;
  confidence: number | null;
  status: string | null;
  source_ids: string | null;
  skill_id: string | null;
  supersedes: string | null;
  created_at: number;
  updated_at: number;
  approved_at: number | null;
  evidence_bundle_id: string | null;
  quality_score: number | null;
  quality_failures: string | null;
  coverage_matches: string | null;
  last_reconciled_at: number | null;
  reconciliation_reason: string | null;
  synced_at: number | null;
}

export interface SourceSkillRecordRow {
  id: string;
  agent_id: string;
  machine_id: string | null;
  name: string;
  display_name: string;
  description: string;
  status: string | null;
  embedded: number | null;
  generation: number | null;
  candidate_id: string | null;
  source_ids: string | null;
  path: string;
  usage_count: number | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
  properties: string | null;
  synced_at: number | null;
}

export interface SourceSkillLineageRow {
  id: string;
  skill_id: string;
  generation: number;
  action: string;
  rationale: string;
  source_ids_added: string | null;
  content_snapshot: string;
  created_at: number;
}

export interface SourceSkillUsageRow {
  id: string;
  skill_id: string;
  session_id: string;
  machine_id: string | null;
  detected_at: number;
}

export interface SourceNotificationRow {
  id: string;
  domain: string;
  type: string;
  level: string | null;
  title: string;
  message: string | null;
  mode: string | null;
  status: string | null;
  link: string | null;
  metadata: string | null;
  created_at: number;
}

export interface SourceLogEntryRow {
  id: number;
  timestamp: string;
  level: string;
  component: string;
  kind: string;
  message: string;
  data: string | null;
  session_id: string | null;
}

export function listSourceAgents(db: Database): SourceAgentRow[] {
  return db.prepare(
    `SELECT
       id, name, provider, model, system_prompt_hash, config,
       source, system_prompt, max_turns, timeout_seconds, tool_access,
       enabled, created_at, updated_at
     FROM agents
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceAgentRow[];
}

export function listSourceAgentTasks(db: Database): SourceAgentTaskRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, source, display_name, description,
       prompt, is_default, tool_overrides, model, config,
       created_at, updated_at
     FROM agent_tasks
     ORDER BY agent_id ASC, created_at ASC, id ASC`,
  ).all() as SourceAgentTaskRow[];
}

export function listSourceAgentState(db: Database): SourceAgentStateRow[] {
  return db.prepare(
    `SELECT agent_id, project_id, key, value, updated_at
     FROM agent_state
     ORDER BY agent_id ASC, key ASC`,
  ).all() as SourceAgentStateRow[];
}

export function listSourceSessions(db: Database): SourceSessionRow[] {
  return db.prepare(
    `SELECT
       id, agent, "user" AS user, project_root, branch,
       started_at, ended_at, status, prompt_count, tool_count,
       title, summary, transcript_path, parent_session_id, parent_session_reason,
       processed, content_hash, created_at, embedded, machine_id, synced_at,
       canopy_injections_offered, canopy_injection_total_tokens,
       canopy_skips_after_injection, canopy_reads_after_injection,
       canopy_tokens_saved, canopy_redundant_reads, canopy_map_tool_calls
     FROM sessions
     ORDER BY started_at ASC, created_at ASC, id ASC`,
  ).all() as SourceSessionRow[];
}

export function listSourcePromptBatches(db: Database): SourcePromptBatchRow[] {
  return db.prepare(
    `SELECT
       id, session_id, parent_prompt_batch_id, kind, prompt_number,
       user_prompt, response_summary, classification, started_at, ended_at,
       status, activity_count, processed, content_hash, created_at, machine_id, synced_at
     FROM prompt_batches
     ORDER BY id ASC`,
  ).all() as SourcePromptBatchRow[];
}

export function listSourceActivities(db: Database): SourceActivityRow[] {
  return db.prepare(
    `SELECT
       id, session_id, prompt_batch_id, tool_name, tool_input, tool_output_summary,
       file_path, files_affected, duration_ms, success, error_message, timestamp,
       processed, content_hash, created_at, canopy_injection_tokens
     FROM activities
     ORDER BY id ASC`,
  ).all() as SourceActivityRow[];
}

export function listSourceAttachments(db: Database): SourceAttachmentRow[] {
  return db.prepare(
    `SELECT
       id, session_id, prompt_batch_id, file_path, media_type,
       description, data, content_hash, created_at
     FROM attachments
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceAttachmentRow[];
}

export function listSourcePlans(db: Database): SourcePlanRow[] {
  return db.prepare(
    `SELECT
       id, logical_key, status, author, title, content, source_path, tags,
       session_id, prompt_batch_id, content_hash, processed, created_at,
       updated_at, embedded, machine_id, synced_at
     FROM plans
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourcePlanRow[];
}

export function listSourceArtifacts(db: Database): SourceArtifactRow[] {
  return db.prepare(
    `SELECT
       id, artifact_type, source_path, title, content, last_captured_by,
       tags, created_at, updated_at, embedded, machine_id, synced_at
     FROM artifacts
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceArtifactRow[];
}

export function listSourceSpores(db: Database): SourceSporeRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, session_id, prompt_batch_id, observation_type,
       status, content, context, importance, file_path, tags,
       content_hash, properties, created_at, updated_at, embedded,
       machine_id, synced_at
     FROM spores
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceSporeRow[];
}

export function listSourceEntities(db: Database): SourceEntityRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, type, name, properties, first_seen, last_seen,
       status, machine_id, synced_at
     FROM entities
     ORDER BY first_seen ASC, id ASC`,
  ).all() as SourceEntityRow[];
}

export function listSourceEntityMentions(db: Database): SourceEntityMentionRow[] {
  return db.prepare(
    `SELECT
       entity_id, note_id, note_type, agent_id, machine_id, synced_at
     FROM entity_mentions
     ORDER BY entity_id ASC, note_type ASC, note_id ASC, agent_id ASC`,
  ).all() as SourceEntityMentionRow[];
}

export function listSourceResolutionEvents(db: Database): SourceResolutionEventRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, spore_id, action, new_spore_id, reason,
       session_id, created_at, machine_id, synced_at
     FROM resolution_events
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceResolutionEventRow[];
}

export function listSourceGraphEdges(db: Database): SourceGraphEdgeRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, source_id, source_type, target_id, target_type,
       type, session_id, confidence, properties, created_at, machine_id, synced_at
     FROM graph_edges
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceGraphEdgeRow[];
}

export function listSourceAgentRuns(db: Database): SourceAgentRunRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, task, instruction, status,
       harness, provider, model, session_ref, resumable,
       resume_status, resume_mode, resumed_at, checkpoints, usage_data,
       started_at, completed_at, tokens_used, cost_usd, actual_cost_usd,
       estimated_cost_usd, cost_source, cost_data, actions_taken, error,
       dry_run, reasoning_level, execution_overrides
     FROM agent_runs
     ORDER BY started_at ASC, id ASC`,
  ).all() as SourceAgentRunRow[];
}

export function listSourceAgentReports(db: Database): SourceAgentReportRow[] {
  return db.prepare(
    `SELECT
       id, run_id, agent_id, action, summary, details, created_at
     FROM agent_reports
     ORDER BY id ASC`,
  ).all() as SourceAgentReportRow[];
}

export function listSourceAgentTurns(db: Database): SourceAgentTurnRow[] {
  return db.prepare(
    `SELECT
       id, run_id, agent_id, turn_number, tool_name,
       tool_input, tool_output_summary, started_at, completed_at
     FROM agent_turns
     ORDER BY id ASC`,
  ).all() as SourceAgentTurnRow[];
}

export function listSourceAgentRunWriteIntents(db: Database): SourceAgentRunWriteIntentRow[] {
  return db.prepare(
    `SELECT
       id, run_id, phase_id, tool_name, tool_input,
       synthetic_output, stub_id, recorded_at
     FROM agent_run_write_intents
     ORDER BY id ASC`,
  ).all() as SourceAgentRunWriteIntentRow[];
}

export function listSourceSkillCandidates(db: Database): SourceSkillCandidateRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, machine_id, topic, rationale, confidence,
       status, source_ids, skill_id, supersedes, created_at,
       updated_at, approved_at, evidence_bundle_id, quality_score,
       quality_failures, coverage_matches, last_reconciled_at,
       reconciliation_reason, synced_at
     FROM skill_candidates
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceSkillCandidateRow[];
}

export function listSourceSkillRecords(db: Database): SourceSkillRecordRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, machine_id, name, display_name, description,
       status, embedded, generation, candidate_id, source_ids, path,
       usage_count, last_used_at, created_at, updated_at, properties,
       synced_at
     FROM skill_records
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceSkillRecordRow[];
}

export function listSourceSkillLineage(db: Database): SourceSkillLineageRow[] {
  return db.prepare(
    `SELECT
       id, skill_id, generation, action, rationale,
       source_ids_added, content_snapshot, created_at
     FROM skill_lineage
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceSkillLineageRow[];
}

export function listSourceSkillUsage(db: Database): SourceSkillUsageRow[] {
  return db.prepare(
    `SELECT
       id, skill_id, session_id, machine_id, detected_at
     FROM skill_usage
     ORDER BY detected_at ASC, id ASC`,
  ).all() as SourceSkillUsageRow[];
}

export function listSourceCanopyEntries(db: Database): SourceCanopyEntryRow[] {
  return db.prepare(
    `SELECT
       project_id, machine_id, path, content_hash, size_bytes,
       token_estimate, line_count, language, exports_json, imports_json,
       top_comment, mechanical_updated_at, llm_description, llm_updated_at,
       embedded
     FROM canopy_entries
     ORDER BY project_id ASC, path ASC`,
  ).all() as SourceCanopyEntryRow[];
}

export function listSourceCanopyMaps(db: Database): SourceCanopyMapRow[] {
  return db.prepare(
    `SELECT
       project_id, machine_id, content, inputs_hash, generated_at,
       generated_by_run_id, token_estimate
     FROM canopy_maps
     ORDER BY project_id ASC, machine_id ASC`,
  ).all() as SourceCanopyMapRow[];
}

export function listSourceDigestExtracts(db: Database): SourceDigestExtractRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, tier, content, substrate_hash,
       generated_at, machine_id, synced_at
     FROM digest_extracts
     ORDER BY id ASC`,
  ).all() as SourceDigestExtractRow[];
}

export function listSourceDigestExtractRevisions(db: Database): SourceDigestExtractRevisionRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, tier, content, metadata,
       run_id, parent_revision_id, created_at
     FROM digest_extract_revisions
     ORDER BY id ASC`,
  ).all() as SourceDigestExtractRevisionRow[];
}

export function listSourceCortexInstructions(db: Database): SourceCortexInstructionsRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, content, input_hash, source_run_id,
       generated_at, machine_id, synced_at
     FROM cortex_instructions
     ORDER BY generated_at ASC, id ASC`,
  ).all() as SourceCortexInstructionsRow[];
}

export function listSourceNotifications(db: Database): SourceNotificationRow[] {
  return db.prepare(
    `SELECT
       id, domain, type, level, title, message, mode,
       status, link, metadata, created_at
     FROM notifications
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceNotificationRow[];
}

export function listSourceLogEntries(db: Database): SourceLogEntryRow[] {
  return db.prepare(
    `SELECT
       id, timestamp, level, component, kind,
       message, data, session_id
     FROM log_entries
     ORDER BY id ASC`,
  ).all() as SourceLogEntryRow[];
}
