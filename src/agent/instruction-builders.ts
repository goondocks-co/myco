/**
 * Instruction builders for agent tasks.
 *
 * Pre-assembles data from the vault DB into instruction strings that are
 * injected into agent run prompts. This moves deterministic data assembly
 * out of the LLM loop — the agent receives the material it needs without
 * needing to discover it via tool calls.
 *
 * Each builder corresponds to a task that needs pre-assembled context.
 */

import { listCandidates } from '@myco/db/queries/skill-candidates.js';
import { getSpore } from '@myco/db/queries/spores.js';
import { getSession } from '@myco/db/queries/sessions.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Task name that gets special candidate-injection handling. */
export const SKILL_GENERATE_TASK = 'skill-generate';

// ---------------------------------------------------------------------------
// skill-generate
// ---------------------------------------------------------------------------

/**
 * Build the instruction for a skill-generate run.
 *
 * Fetches the first approved candidate and assembles the full source
 * material (spore content, session summaries) into the instruction text.
 * The draft phase receives this as context — no gathering tool calls needed.
 *
 * Used by both the API route handler and the scheduler.
 */
export function buildSkillGenerateInstruction(): string | undefined {
  const candidates = listCandidates({ status: 'approved', limit: 1 });
  if (candidates.length === 0) return undefined;
  const c = candidates[0];

  const parts = [
    `candidate_id: ${c.id}`,
    `topic: ${c.topic}`,
    `confidence: ${c.confidence}`,
    `rationale: ${c.rationale}`,
    '',
    '## Source Material',
  ];

  let sourceIds: Array<{ id: string; type: string }> = [];
  try { sourceIds = JSON.parse(c.source_ids || '[]'); } catch { /* malformed */ }

  for (const src of sourceIds) {
    if (src.type === 'spore') {
      const spore = getSpore(src.id);
      if (spore) {
        parts.push(`\n### Spore: ${src.id} (${spore.observation_type}, importance ${spore.importance})`);
        parts.push(spore.content);
        if (spore.context) parts.push(`Context: ${spore.context}`);
        if (spore.tags) parts.push(`Tags: ${spore.tags}`);
      }
    } else if (src.type === 'session') {
      const session = getSession(src.id);
      if (session) {
        parts.push(`\n### Session: ${src.id}`);
        if (session.title) parts.push(`Title: ${session.title}`);
        if (session.summary) parts.push(session.summary);
      }
    }
  }

  return parts.join('\n');
}
