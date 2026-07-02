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
import { findCorePackageRoot } from '@myco/utils/find-package-root.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { extractJson } from '@myco/intelligence/response.js';
import type { PhaseDefinition, OrchestratorPlan, OrchestratorPhaseDirective, RunLogger } from './types.js';
import type { ContextQueryResult } from './context-queries.js';
import { BUNDLED_AGENT_PROMPTS } from './definitions.generated.js';

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

/** Max chars of the underlying parser error we surface into the fallback reasoning. */
const ORCHESTRATOR_PARSE_ERROR_PREVIEW_CHARS = 200;

/**
 * Max chars of `directive.contextNotes` spliced into a phase's prompt.
 * contextNotes is LLM-authored free text (the orchestrator's own plan
 * response) with no upstream size or content bound — without a cap it's an
 * unbounded-size / unbounded-content injection surface once spliced into
 * `phase.prompt`, which then feeds `phasePurpose.promptExcerpt` (the
 * semantic-check classifier's own untrusted-data input). Mirrors the
 * existing phase.prompt truncation idiom (see phase-loop.ts's
 * phasePurpose.promptExcerpt construction).
 */
const CONTEXT_NOTES_MAX_CHARS = 500;
const CONTEXT_NOTES_TRUNCATION_MARKER = '...[truncated]';

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

function isBunVirtualPath(candidate: string): boolean {
  return candidate.startsWith('/$bunfs/') || candidate.startsWith('B:\\~BUN\\');
}

export function resolveOrchestratorPromptTemplate(scriptDir: string): string {
  // Check sibling prompts/ directory first (tsc output or dev mode)
  const adjacentPath = path.join(scriptDir, 'prompts', ORCHESTRATOR_PROMPT_FILE);
  if (fs.existsSync(adjacentPath)) {
    return fs.readFileSync(adjacentPath, 'utf-8');
  }

  // tsup bundles into dist/chunk-XXXX.js — walk up to @goondocks/myco core
  // so we read the prompts that ship in core, not the platform sub-package.
  const root = findCorePackageRoot(scriptDir);
  if (root) {
    const distPath = path.join(root, 'dist', 'src', 'agent', 'prompts', ORCHESTRATOR_PROMPT_FILE);
    if (fs.existsSync(distPath)) {
      return fs.readFileSync(distPath, 'utf-8');
    }
    const srcPath = path.join(root, 'src', 'agent', 'prompts', ORCHESTRATOR_PROMPT_FILE);
    if (fs.existsSync(srcPath)) {
      return fs.readFileSync(srcPath, 'utf-8');
    }
  }

  if (isBunVirtualPath(adjacentPath)) {
    const bundled = BUNDLED_AGENT_PROMPTS[ORCHESTRATOR_PROMPT_FILE];
    if (bundled !== undefined) {
      return bundled;
    }
  }

  // Final fallback
  return fs.readFileSync(adjacentPath, 'utf-8');
}

function loadPromptTemplate(): string {
  if (!cachedPromptTemplate) {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    cachedPromptTemplate = resolveOrchestratorPromptTemplate(scriptDir);
  }
  return cachedPromptTemplate;
}

export function resetOrchestratorPromptTemplateCacheForTests(): void {
  cachedPromptTemplate = undefined;
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
  logger?: import('./types.js').RunLogger,
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
  } catch (err) {
    const detail = errorMessage(err);
    const truncated = detail.length > ORCHESTRATOR_PARSE_ERROR_PREVIEW_CHARS
      ? `${detail.slice(0, ORCHESTRATOR_PARSE_ERROR_PREVIEW_CHARS)}…`
      : detail;
    logger?.warn('agent.orchestrator.parse-failed', 'Orchestrator plan parse failed', {
      error: detail,
      responsePreview: trimmed.slice(0, 200),
    });
    return buildRunAllPlan(phases, `${FALLBACK_REASONING_PARSE_ERROR} (${truncated})`);
  }
}

/**
 * JSON Schema for OrchestratorPlan, fed to whichever harness supports
 * native structured output (see HarnessCapability 'structuredOutput' in
 * harness/types.ts). Mirrors OrchestratorPlan/OrchestratorPhaseDirective
 * in types.ts exactly — if those interfaces change, this schema must
 * change with them (see the schema-shape regression test in
 * tests/agent/orchestrator.test.ts).
 */
export const ORCHESTRATOR_PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    phases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          skip: { type: 'boolean' },
          skipReason: { type: 'string' },
          maxTurns: { type: 'integer' },
          contextNotes: { type: 'string' },
        },
        required: ['name', 'skip'],
        additionalProperties: false,
      },
    },
    reasoning: { type: 'string' },
  },
  required: ['phases', 'reasoning'],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

/**
 * Build an OrchestratorPlan from a harness's already-schema-validated
 * structured output. Skips extractJson()/parse-and-hope entirely — the
 * provider already validated the shape against ORCHESTRATOR_PLAN_JSON_SCHEMA.
 * Still defends against a provider returning a technically-valid-but-
 * wrong-shape value (defensive, not expected in practice given
 * additionalProperties: false) by falling back to buildRunAllPlan() via
 * the same isOrchestratorPlanShape() guard the text path uses.
 *
 * Never throws.
 *
 * @param structuredOutput - Already-parsed value from HarnessExecuteResult.structuredOutput.
 * @param phases            - Phase definitions; used to construct the fallback plan.
 * @param logger             - Optional logger; receives a warning on shape mismatch.
 * @returns A valid OrchestratorPlan.
 */
export function planFromStructuredOutput(
  structuredOutput: unknown,
  phases: PhaseDefinition[],
  logger?: RunLogger,
): OrchestratorPlan {
  if (!isOrchestratorPlanShape(structuredOutput)) {
    logger?.warn(
      'agent.orchestrator.structured-output-shape-mismatch',
      'Structured output did not match OrchestratorPlan shape',
      { received: typeof structuredOutput },
    );
    return buildRunAllPlan(phases, FALLBACK_REASONING_MISSING_PHASES);
  }
  return dropNullDirectiveFields(structuredOutput);
}

/**
 * Defense-in-depth against a harness that forgot to strip OpenAI strict-
 * mode's widened-optional-field nulls (see `stripStrictNulls` in
 * harness/openai.ts, the primary fix). This function is the one place in
 * this dialect-agnostic module allowed to be null-robust — `applyDirectives`
 * itself stays untouched and keeps its `!== undefined` guard, since a
 * conforming harness never emits `null` here in the first place.
 *
 * Drops a `null` value for `skipReason`/`maxTurns`/`contextNotes` (and,
 * defensively, `skip` per directive and the plan's own `reasoning`, though
 * the shape guard already requires those to be present) so a stray `null`
 * can never reach `applyDirectives`'s `!== undefined` check and coerce a
 * turn budget to 0. Operates on the raw (possibly null-bearing) value —
 * the `OrchestratorPlan` type describes the intended shape, not what a
 * misbehaving harness might actually hand back.
 */
function dropNullDirectiveFields(plan: OrchestratorPlan): OrchestratorPlan {
  const raw = plan as unknown as {
    phases: Array<Record<string, unknown>>;
    reasoning: unknown;
  };
  const cleanedPhases = raw.phases.map((directive) => {
    const cleaned: Record<string, unknown> = { ...directive };
    for (const key of ['skip', 'skipReason', 'maxTurns', 'contextNotes']) {
      if (cleaned[key] === null) {
        delete cleaned[key];
      }
    }
    return cleaned as unknown as OrchestratorPhaseDirective;
  });
  const cleanedReasoning = raw.reasoning === null ? undefined : raw.reasoning;

  return {
    ...plan,
    phases: cleanedPhases,
    ...(cleanedReasoning !== undefined ? { reasoning: cleanedReasoning as string } : {}),
  };
}

/**
 * Apply orchestrator directives to a set of phase definitions.
 *
 * For each phase:
 * - If the directive says `skip: true` and the phase is not required, it is
 *   excluded from the result.
 * - If the directive says `skip: true` but the phase IS required, it is kept
 *   and a warning is logged.
 * - If the directive provides `maxTurns`, the phase's turn limit is reduced
 *   (clamped to the YAML value — orchestrators may narrow budgets but never
 *   widen them; see applyNonSkipDirective).
 * - If the directive provides `contextNotes`, they are appended to the phase
 *   prompt under `## Orchestrator Guidance`.
 *
 * Phase order is preserved. Phases with no matching directive pass through
 * unchanged.
 *
 * @param phases     - Original phase definitions.
 * @param directives - Directives from the orchestrator's plan.
 * @param logger     - Optional logger; receives a warning when the orchestrator
 *                     tries to widen a budget (the attempt is then clamped).
 * @returns Modified phase definitions.
 */
export function applyDirectives(
  phases: PhaseDefinition[],
  directives: OrchestratorPhaseDirective[],
  logger?: RunLogger,
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
        result.push(applyNonSkipDirective(phase, directive, logger));
      }
      // Non-required phases with skip: true are simply excluded.
      continue;
    }

    result.push(applyNonSkipDirective(phase, directive, logger));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Apply non-skip directive fields (maxTurns, contextNotes) to a phase.
 *
 * Budget rule (intentional and structural): the orchestrator may narrow a
 * phase's `maxTurns` but may NEVER widen it beyond the YAML value. The
 * YAML budget is the spec — turning it into a suggestion produces
 * unpredictable cost (extract on vault-evolve drifted from 35 turns to
 * 161 turns this way before the clamp landed). When the orchestrator
 * tries to widen, we clamp to the YAML value and log a warning so the
 * attempt is visible to cost-audit tooling.
 *
 * The escape hatch is the YAML itself or a `grove.yaml` `taskOverrides`
 * block — both editable by humans with the budget context the
 * orchestrator lacks.
 */
function applyNonSkipDirective(
  phase: PhaseDefinition,
  directive: OrchestratorPhaseDirective,
  logger?: RunLogger,
): PhaseDefinition {
  let updated = { ...phase };

  if (directive.maxTurns !== undefined) {
    const ceiling = phase.maxTurns;
    const clamped = Math.min(directive.maxTurns, ceiling);
    if (directive.maxTurns > ceiling) {
      logger?.warn(
        'agent.orchestrator.widen-rejected',
        `Orchestrator tried to widen phase "${phase.name}" maxTurns ${ceiling} → ${directive.maxTurns}; clamped to ${ceiling}`,
        {
          phase: phase.name,
          requested: directive.maxTurns,
          ceiling,
        },
      );
    }
    updated = { ...updated, maxTurns: clamped };
  }

  if (directive.contextNotes) {
    const cappedContextNotes = directive.contextNotes.length > CONTEXT_NOTES_MAX_CHARS
      ? `${directive.contextNotes.slice(0, CONTEXT_NOTES_MAX_CHARS)}${CONTEXT_NOTES_TRUNCATION_MARKER}`
      : directive.contextNotes;
    updated = {
      ...updated,
      prompt: `${updated.prompt}\n\n${ORCHESTRATOR_GUIDANCE_HEADER}\n\n${cappedContextNotes}`,
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
