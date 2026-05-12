import type { BatchRow } from '@myco/db/queries/batches.js';
import type { GraphEdgeRow } from '@myco/db/queries/graph-edges.js';
import type { SporeRow } from '@myco/db/queries/spores.js';
import type { SessionRow } from '@myco/db/queries/sessions.js';
import type { ReleaseStateAnnotation } from '@myco/release-provenance/annotations.js';

/** Maximum characters from each user prompt returned to the agent by batch tools. */
export const BATCH_USER_PROMPT_CHARS = 400;
/** Maximum characters from each response summary returned to the agent by batch tools. */
export const BATCH_RESPONSE_SUMMARY_CHARS = 1200;
/** Maximum characters from each spore content preview returned by spore listings. */
export const SPORE_CONTENT_PREVIEW_CHARS = 600;
/** Maximum characters from each spore context preview returned by exact spore lookups. */
export const SPORE_CONTEXT_PREVIEW_CHARS = 240;

export function truncateProjectionText(value: string | null, limit: number): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

/**
 * Compact release-state summary for list/search projections. Keeps the
 * payload terse so loop guards and token budgets stay sane; exact reads use
 * the full ReleaseStateAnnotation via vault_release_state instead.
 */
export interface ReleaseStateSummary {
  state: string;
  confidence: string;
}

function summarizeReleaseState(annotation: ReleaseStateAnnotation | undefined): ReleaseStateSummary | undefined {
  return annotation ? { state: annotation.state, confidence: annotation.confidence } : undefined;
}

function releaseField(annotation: ReleaseStateAnnotation | undefined): { release_state?: ReleaseStateSummary } {
  const summary = summarizeReleaseState(annotation);
  return summary ? { release_state: summary } : {};
}

export interface ProjectionOptions {
  release?: ReleaseStateAnnotation;
}

export function projectBatchForAgent(batch: BatchRow, options: ProjectionOptions = {}): Record<string, unknown> {
  return {
    id: batch.id,
    session_id: batch.session_id,
    prompt_number: batch.prompt_number,
    user_prompt: truncateProjectionText(batch.user_prompt, BATCH_USER_PROMPT_CHARS),
    response_summary: truncateProjectionText(batch.response_summary, BATCH_RESPONSE_SUMMARY_CHARS),
    ...(batch.classification ? { classification: batch.classification } : {}),
    ...releaseField(options.release),
  };
}

export function projectBatchForSessionSummary(batch: BatchRow, options: ProjectionOptions = {}): Record<string, unknown> {
  return {
    prompt_number: batch.prompt_number,
    ...(batch.user_prompt ? { user_prompt: truncateProjectionText(batch.user_prompt, BATCH_USER_PROMPT_CHARS) } : {}),
    ...(batch.response_summary ? { response_summary: truncateProjectionText(batch.response_summary, BATCH_RESPONSE_SUMMARY_CHARS) } : {}),
    ...releaseField(options.release),
  };
}

export function projectSessionForAgent(session: SessionRow, options: ProjectionOptions = {}): Record<string, unknown> {
  return {
    id: session.id,
    agent: session.agent,
    status: session.status,
    ...(session.title ? { title: session.title } : {}),
    ...(session.summary ? { summary: session.summary } : {}),
    prompt_count: session.prompt_count,
    ...(session.started_at ? { started_at: session.started_at } : {}),
    ...(session.ended_at ? { ended_at: session.ended_at } : {}),
    ...releaseField(options.release),
  };
}

export interface SporeProjectionOptions extends ProjectionOptions {
  exact: boolean;
}

export function projectSporeForAgent(
  spore: SporeRow,
  options: SporeProjectionOptions,
): Record<string, unknown> {
  const contentField = options.exact
    ? { content: spore.content }
    : { content_preview: truncateProjectionText(spore.content, SPORE_CONTENT_PREVIEW_CHARS) };
  return {
    id: spore.id,
    observation_type: spore.observation_type,
    ...contentField,
    ...(spore.session_id ? { session_id: spore.session_id } : {}),
    ...(spore.importance ? { importance: spore.importance } : {}),
    ...(options.exact && spore.context
      ? { context_preview: truncateProjectionText(spore.context, SPORE_CONTEXT_PREVIEW_CHARS) }
      : {}),
    created_at: spore.created_at,
    ...releaseField(options.release),
  };
}

export function projectEdgeForAgent(edge: GraphEdgeRow): Record<string, unknown> {
  return {
    id: edge.id,
    source_id: edge.source_id,
    source_type: edge.source_type,
    target_id: edge.target_id,
    target_type: edge.target_type,
    type: edge.type,
    confidence: edge.confidence,
    ...(edge.session_id ? { session_id: edge.session_id } : {}),
    created_at: edge.created_at,
  };
}
