/**
 * Prompt composition helpers for the executor.
 *
 * Extracted from `executor.ts` so the section-header constants and the
 * task/phase prompt builders live in one place. `executor.ts` re-exports
 * `composeTaskPrompt` and `composePhasePrompt` for tests that import
 * them from there.
 */

import { PHASE_SUMMARY_MAX_CHARS } from '@myco/constants.js';
import { interpolate } from '@myco/utils/interpolate.js';
import type { PhaseDefinition, PhaseResult } from './types.js';

const PROMPT_SECTION_TASK = '## Task: ';
const PROMPT_SECTION_INSTRUCTION = '## User Instruction';
const PROMPT_SECTION_SEPARATOR = '\n\n';
const PROMPT_SECTION_PRIOR_PHASES = '## Prior Phase Results';
const PROMPT_SECTION_CURRENT_PHASE = '## Current Phase: ';

const UUID_PATTERN = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

// ---------------------------------------------------------------------------
// Task prompts
// ---------------------------------------------------------------------------

export interface TaskPromptInput {
  vaultContext: string;
  taskDisplayName: string;
  taskPrompt: string;
  instruction?: string;
  /** Parameters a dispatch named; each is a `{{name}}` the task prompt may carry, and `session_id` here wins over one found in the instruction. */
  params?: Record<string, string>;
}

/**
 * Build the full task prompt from vault context, task definition, and
 * optional user instruction.
 *
 * Task prompts support:
 * - `{{session_id}}` — the dispatch's `session_id` parameter, else the session ID found in the instruction (if present)
 * - `{{instruction}}` — the raw user instruction text
 * - `{{<param>}}` — any other parameter the dispatch named
 */
export function composeTaskPrompt(input: TaskPromptInput): string {
  const { vaultContext, taskDisplayName, taskPrompt, instruction, params } = input;

  const sessionId = params?.session_id ?? instruction?.match(UUID_PATTERN)?.[1] ?? '';
  const resolvedPrompt = interpolate(taskPrompt, {
    ...(params ?? {}),
    session_id: sessionId,
    instruction: instruction ?? '',
  });

  const parts = [
    vaultContext,
    `${PROMPT_SECTION_TASK}${taskDisplayName}\n${resolvedPrompt}`,
  ];
  if (instruction) {
    parts.push(`${PROMPT_SECTION_INSTRUCTION}\n${instruction}`);
  }
  return parts.join(PROMPT_SECTION_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Phase prompts
// ---------------------------------------------------------------------------

export interface PhasePromptInput {
  vaultContext: string;
  taskDisplayName: string;
  taskOverview: string;
  phase: PhaseDefinition;
  priorPhaseResults: PhaseResult[];
  instruction?: string;
  /** Resolved `maxTurns` after applying myco.yaml + run overrides. */
  effectiveMaxTurns?: number;
  /** Resolved task params after YAML defaults, myco.yaml, and run overrides merge. */
  taskParams?: Record<string, string | number | boolean>;
  /** Current agent run id, for durable state/report payload provenance. */
  runId: string;
}

/**
 * Build the prompt for a single phase in a phased execution.
 *
 * Includes vault context, the task overview, prior phase summaries, and
 * the current phase instructions.
 *
 * Phase prompts support, resolved against the effective phase config:
 * - `{{max_turns}}` — the phase's resolved turn budget (number)
 * - `{{phase_name}}` — the phase's name
 * - `{{phase_tools}}` — comma-separated list of tool names for this phase
 *
 * Authors should prefer these variables over hard-coded numbers or tool
 * lists; users can override `maxTurns` (and other fields) in `myco.yaml`
 * per-task or per-phase.
 */
export function composePhasePrompt(input: PhasePromptInput): string {
  const {
    vaultContext, taskDisplayName, taskOverview, phase,
    priorPhaseResults, instruction, effectiveMaxTurns, taskParams, runId,
  } = input;

  const parts = [
    vaultContext,
    `${PROMPT_SECTION_TASK}${taskDisplayName}\n${taskOverview}`,
  ];
  if (instruction) {
    parts.push(`${PROMPT_SECTION_INSTRUCTION}\n${instruction}`);
  }
  if (priorPhaseResults.length > 0 && !phase.skipPriorContext) {
    const summaries = priorPhaseResults.map((pr) => {
      const truncated = pr.summary.length > PHASE_SUMMARY_MAX_CHARS
        ? pr.summary.slice(0, PHASE_SUMMARY_MAX_CHARS) + '...'
        : pr.summary;
      return `### ${pr.name} (${pr.status})\n${truncated}`;
    });
    parts.push(`${PROMPT_SECTION_PRIOR_PHASES}\n${summaries.join('\n\n')}`);
  }

  const resolvedPhasePrompt = substitutePhaseVariables(phase, effectiveMaxTurns, taskParams, runId);
  parts.push(`${PROMPT_SECTION_CURRENT_PHASE}${phase.name}\n${resolvedPhasePrompt}`);

  return parts.join(PROMPT_SECTION_SEPARATOR);
}

function substitutePhaseVariables(
  phase: PhaseDefinition,
  effectiveMaxTurns: number | undefined,
  taskParams: Record<string, string | number | boolean> | undefined,
  runId: string,
): string {
  const maxTurns = effectiveMaxTurns ?? phase.maxTurns;
  const taskParamVariables = Object.fromEntries(
    Object.entries(taskParams ?? {}).map(([key, value]) => [key, String(value)]),
  );
  return interpolate(phase.prompt, {
    ...taskParamVariables,
    max_turns: maxTurns !== undefined ? String(maxTurns) : 'the configured budget',
    phase_name: phase.name,
    phase_tools: (phase.tools ?? []).join(', '),
    run_id: runId,
  });
}
