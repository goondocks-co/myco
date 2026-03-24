/**
 * Orchestrator planning call.
 *
 * Composes the orchestrator prompt, parses the LLM response into a structured
 * plan, and applies phase directives to PhaseDefinition objects.
 *
 * This module is pure logic — no SDK calls. SDK invocation happens in the
 * executor integration (Task 5).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJson } from '@myco/intelligence/response.js';
import type { PhaseDefinition, OrchestratorPlan, OrchestratorPhaseDirective } from './types.js';
import type { ContextQueryResult } from './context-queries.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max turns for the orchestrator's own LLM call. */
export const DEFAULT_ORCHESTRATOR_MAX_TURNS = 3;

/** Filename of the orchestrator prompt template. */
const ORCHESTRATOR_PROMPT_FILE = 'orchestrator.md';

/** Number of characters to show from a phase's prompt as a preview. */
const PHASE_PROMPT_PREVIEW_CHARS = 100;

/** Section header injected into a phase prompt when contextNotes are present. */
const ORCHESTRATOR_GUIDANCE_HEADER = '## Orchestrator Guidance';

/** Placeholder substituted when no context query results are available. */
const NO_CONTEXT_QUERIES_TEXT = 'No context queries configured.';

/** Fallback reasoning string used when JSON parsing fails. */
const FALLBACK_REASONING_PARSE_ERROR = 'Orchestrator response could not be parsed — running all phases with defaults.';

/** Fallback reasoning string used when the parsed plan has no phases array. */
const FALLBACK_REASONING_MISSING_PHASES = 'Orchestrator plan missing phases array — running all phases with defaults.';

// ---------------------------------------------------------------------------
// Template placeholder names
// ---------------------------------------------------------------------------

const PLACEHOLDER_VAULT_STATE = '{{vault_state}}';
const PLACEHOLDER_PHASE_DEFINITIONS = '{{phase_definitions}}';
const PLACEHOLDER_CONTEXT_RESULTS = '{{context_results}}';

// ---------------------------------------------------------------------------
// Prompt template loading
// ---------------------------------------------------------------------------

/**
 * Load the orchestrator prompt template from disk.
 *
 * Resolves the path relative to this file so it works in both dev and built
 * (tsup) environments. The `prompts/` directory is a sibling of this file.
 */
/** Cached prompt template — loaded once, reused across calls. */
let cachedPromptTemplate: string | undefined;

function loadPromptTemplate(): string {
  if (!cachedPromptTemplate) {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const filePath = path.join(dir, 'prompts', ORCHESTRATOR_PROMPT_FILE);
    cachedPromptTemplate = fs.readFileSync(filePath, 'utf-8');
  }
  return cachedPromptTemplate;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose the orchestrator prompt by substituting runtime data into the
 * template.
 *
 * @param vaultState     - Free-form summary of current vault state.
 * @param phases         - Phase definitions available for this task.
 * @param contextResults - Results from pre-execution context queries.
 * @returns The fully composed prompt string.
 */
export function composeOrchestratorPrompt(
  vaultState: string,
  phases: PhaseDefinition[],
  contextResults: ContextQueryResult[],
): string {
  const template = loadPromptTemplate();

  const phaseList = formatPhaseList(phases);
  const contextSection = formatContextResults(contextResults);

  return template
    .replace(PLACEHOLDER_VAULT_STATE, vaultState)
    .replace(PLACEHOLDER_PHASE_DEFINITIONS, phaseList)
    .replace(PLACEHOLDER_CONTEXT_RESULTS, contextSection);
}

/**
 * Parse the orchestrator's LLM response into a structured plan.
 *
 * Accepts JSON that is either raw or wrapped in a ```json code block.
 * Validates that the parsed value has a `phases` array.
 *
 * On any failure — malformed JSON, missing array, empty input — returns a
 * safe fallback plan that runs all phases with no modifications.
 *
 * Never throws.
 *
 * @param response - Raw LLM response text.
 * @param phases   - Phase definitions; used to construct the fallback plan.
 * @returns A valid OrchestratorPlan.
 */
export function parseOrchestratorPlan(
  response: string,
  phases: PhaseDefinition[],
): OrchestratorPlan {
  const trimmed = response.trim();

  if (!trimmed) {
    return buildRunAllPlan(phases, FALLBACK_REASONING_PARSE_ERROR);
  }

  try {
    const parsed = extractJson(trimmed);

    if (!isOrchestratorPlanShape(parsed)) {
      return buildRunAllPlan(phases, FALLBACK_REASONING_MISSING_PHASES);
    }

    return parsed;
  } catch {
    return buildRunAllPlan(phases, FALLBACK_REASONING_PARSE_ERROR);
  }
}

/**
 * Apply orchestrator directives to a set of phase definitions.
 *
 * For each phase:
 * - If the directive says `skip: true` and the phase is not required, it is
 *   excluded from the result.
 * - If the directive says `skip: true` but the phase IS required, it is kept
 *   and a warning is logged.
 * - If the directive provides `maxTurns`, the phase's turn limit is overridden.
 * - If the directive provides `contextNotes`, they are appended to the phase
 *   prompt under `## Orchestrator Guidance`.
 *
 * Phase order is preserved. Phases with no matching directive pass through
 * unchanged.
 *
 * @param phases     - Original phase definitions.
 * @param directives - Directives from the orchestrator's plan.
 * @returns Modified phase definitions.
 */
export function applyDirectives(
  phases: PhaseDefinition[],
  directives: OrchestratorPhaseDirective[],
): PhaseDefinition[] {
  const directiveMap = new Map<string, OrchestratorPhaseDirective>(
    directives.map((d) => [d.name, d]),
  );

  const result: PhaseDefinition[] = [];

  for (const phase of phases) {
    const directive = directiveMap.get(phase.name);

    if (!directive) {
      result.push(phase);
      continue;
    }

    if (directive.skip) {
      if (phase.required) {
        console.warn(
          `[orchestrator] Cannot skip required phase "${phase.name}" — keeping it. Reason: ${directive.skipReason ?? 'none given'}`,
        );
        result.push(applyNonSkipDirective(phase, directive));
      }
      // Non-required phases with skip: true are simply excluded.
      continue;
    }

    result.push(applyNonSkipDirective(phase, directive));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Apply non-skip directive fields (maxTurns, contextNotes) to a phase.
 */
function applyNonSkipDirective(
  phase: PhaseDefinition,
  directive: OrchestratorPhaseDirective,
): PhaseDefinition {
  let updated = { ...phase };

  if (directive.maxTurns !== undefined) {
    updated = { ...updated, maxTurns: directive.maxTurns };
  }

  if (directive.contextNotes) {
    updated = {
      ...updated,
      prompt: `${updated.prompt}\n\n${ORCHESTRATOR_GUIDANCE_HEADER}\n\n${directive.contextNotes}`,
    };
  }

  return updated;
}

/**
 * Format phases as a bulleted list for the prompt template.
 */
function formatPhaseList(phases: PhaseDefinition[]): string {
  if (phases.length === 0) {
    return '(no phases defined)';
  }

  return phases
    .map((p) => {
      const preview = p.prompt.slice(0, PHASE_PROMPT_PREVIEW_CHARS);
      const ellipsis = p.prompt.length > PHASE_PROMPT_PREVIEW_CHARS ? '...' : '';
      return `- **${p.name}** (maxTurns: ${p.maxTurns}, required: ${p.required}): ${preview}${ellipsis}`;
    })
    .join('\n');
}

/**
 * Format context query results as sections for the prompt template.
 */
function formatContextResults(results: ContextQueryResult[]): string {
  if (results.length === 0) {
    return NO_CONTEXT_QUERIES_TEXT;
  }

  return results
    .map((r) => {
      const dataSection = r.error
        ? `Error: ${r.error}`
        : JSON.stringify(r.data, null, 2);
      return `### ${r.tool}\nPurpose: ${r.purpose}\n\n${dataSection}`;
    })
    .join('\n\n');
}

/**
 * Type guard: check that a parsed value has the OrchestratorPlan shape.
 */
function isOrchestratorPlanShape(value: unknown): value is OrchestratorPlan {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj['phases']);
}

/**
 * Build a fallback "run everything" plan from the available phases.
 */
function buildRunAllPlan(phases: PhaseDefinition[], reasoning: string): OrchestratorPlan {
  return {
    phases: phases.map((p) => ({ name: p.name, skip: false })),
    reasoning,
  };
}
