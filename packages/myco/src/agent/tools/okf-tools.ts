/**
 * OKF harness tools.
 *
 * 4 tools: okf_read_bundle, okf_list_changes, okf_write_concept, okf_report
 *
 * Used by the `okf-maintain` scheduled task's `gather` (read-only) and
 * `render` phases. All bundle writes go through `OkfBundle` — this module
 * never touches the filesystem or DB directly, mirroring the constrained
 * `myco_okf` MCP surface (packages/myco/src/tools/okf.ts).
 */

import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds } from '@myco/constants.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle } from '@myco/okf/bundle.js';
import { OkfError } from '@myco/okf/errors.js';
import { gather } from '@myco/okf/gather.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { OKF_REPORT_ACTION } from '../instruction-builders.js';
import { OKF_TOOL_NAMES } from '../tool-names.js';
import {
  textResult,
  projectScopeFromVaultToolDeps,
  rowProjectIdFromVaultToolDeps,
  type VaultToolDeps,
} from './types.js';

export { OKF_TOOL_NAMES };

// ---------------------------------------------------------------------------
// Shared dependency construction
// ---------------------------------------------------------------------------

/**
 * Build the `OkfBundle` this factory's tools share, or `null` when the
 * deps required to construct one are absent. `VaultToolDeps` makes
 * `projectRoot`/`vaultDir`/`requestContext` all optional (harness tools are
 * also used outside a Grove-bound run) — every tool below fails closed
 * with a tool-error result rather than guessing a project identity.
 */
function buildBundle(deps: VaultToolDeps): OkfBundle | null {
  if (!deps.projectRoot || !deps.vaultDir || !deps.requestContext) return null;
  const config = loadMergedConfig(deps.vaultDir, { groveId: deps.requestContext.groveId ?? undefined });
  const projectId = rowProjectIdFromVaultToolDeps(deps);
  if (!projectId) return null;
  return new OkfBundle({
    projectRoot: deps.projectRoot,
    vault: new ProjectVault(deps.projectRoot),
    scope: projectScopeFromVaultToolDeps(deps),
    projectId,
    machineId: deps.machineId ?? deps.requestContext.machineId,
    config,
  });
}

const MISSING_DEPS_ERROR = 'okf tools require projectRoot, vaultDir, and requestContext — none available in this run';

function okfErrorResult(err: unknown): { content: Array<{ type: 'text'; text: string }> } {
  if (err instanceof OkfError) {
    return textResult({ error: err.message, code: err.code });
  }
  return textResult({ error: err instanceof Error ? err.message : String(err) });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOkfTools(deps: VaultToolDeps) {
  const { runId } = deps;
  const projectId = rowProjectIdFromVaultToolDeps(deps);

  const okfReadBundle = tool(
    'okf_read_bundle',
    'Read the published OKF bundle. Pass id to read one concept\'s raw markdown (e.g. "concepts/foo"); omit id to get a bundle summary (status + concept list) instead.',
    {
      id: z.string().optional().describe('Concept id (e.g. "concepts/foo") to read its raw markdown. Omit for a bundle summary.'),
    },
    async (args) => {
      const bundle = buildBundle(deps);
      if (!bundle) return textResult({ error: MISSING_DEPS_ERROR });
      try {
        if (args.id) {
          const got = bundle.getConcept(args.id);
          return textResult({ concept: got ? { id: args.id, raw: got.raw } : null });
        }
        return textResult({ status: bundle.status(), concepts: bundle.listConcepts() });
      } catch (err) {
        return okfErrorResult(err);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const okfListChanges = tool(
    'okf_list_changes',
    'Compute a change brief: whether the deterministic bundle inputs (spores, canopy, existing agent concepts) have changed since the last published inputs_hash, and the current concept list. Read-only — never writes.',
    {},
    async () => {
      const bundle = buildBundle(deps);
      if (!bundle) return textResult({ error: MISSING_DEPS_ERROR });
      if (!deps.projectRoot || !deps.requestContext) return textResult({ error: MISSING_DEPS_ERROR });
      try {
        const status = bundle.status();
        const config = loadMergedConfig(deps.vaultDir!, { groveId: deps.requestContext.groveId ?? undefined });
        const scope = projectScopeFromVaultToolDeps(deps);
        const machineId = deps.machineId ?? deps.requestContext.machineId;
        const configured = new Set(config.okf.maintain.include);
        const statuses = config.okf.maintain.include_status;
        const sporeStatus = statuses.length === 1 && statuses[0] === 'active' ? 'active' as const : 'all' as const;
        const gathered = gather(
          {
            projectRoot: deps.projectRoot,
            scope,
            projectId: projectId ?? '',
            machineId,
            config,
            outputRoot: status.outputRoot,
          },
          {
            include: {
              spores: configured.has('spores'),
              canopy: configured.has('canopy'),
              concepts: configured.has('concepts'),
              guides: configured.has('guides'),
            },
            sporeStatus,
            includeUndescribedCanopy: config.okf.maintain.include_undescribed_canopy,
          },
        );
        return textResult({
          inputsChanged: status.inputsHash !== gathered.inputsHash,
          priorInputsHash: status.inputsHash,
          currentInputsHash: gathered.inputsHash,
          sporeCount: gathered.spores.length,
          canopyCount: gathered.canopyEntries.length,
          existingAgentConceptCount: gathered.conceptFiles.length,
          concepts: bundle.listConcepts(),
          warnings: gathered.warnings,
        });
      } catch (err) {
        return okfErrorResult(err);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const okfWriteConcept = tool(
    'okf_write_concept',
    'Create, update, or overwrite an agent-maintained concept under concepts/. Every save immediately publishes and bumps the bundle generation — there is no expected_generation parameter, because harness writes serialize under this run and carry runRef provenance rather than racing another actor (optimistic generation checks are for cross-actor conflicts, e.g. a human editing via the CLI at the same time). Rejects paths outside concepts/ (deterministic projections like spores/ or canopy/ are not editable).',
    {
      id: z.string().describe('Concept id under concepts/ (e.g. "concepts/foo").'),
      markdown: z.string().describe('Full concept markdown, including frontmatter.'),
    },
    async (args) => {
      const bundle = buildBundle(deps);
      if (!bundle) return textResult({ error: MISSING_DEPS_ERROR });
      try {
        const result = await bundle.saveConcept({
          id: args.id,
          markdown: args.markdown,
          provenance: { actor: 'harness', runRef: runId },
        });
        return textResult(result);
      } catch (err) {
        return okfErrorResult(err);
      }
    },
    { annotations: { destructiveHint: true } },
  );

  const okfReport = {
    ...tool(
      'okf_report',
      'Record a pure observability report for this okf-maintain run — a summary of what changed or was maintained. Does NOT publish the bundle; publication happens automatically after the run succeeds, driven by this report row.',
      {
        summary: z.string().describe('Human-readable summary of the maintenance activity this run performed (or decided was unnecessary).'),
        details: z.record(z.string(), z.unknown()).optional().describe('Structured details as key-value pairs.'),
      },
      async (args) => {
        const report = insertReport({
          run_id: runId,
          project_id: projectId,
          agent_id: deps.agentId,
          action: OKF_REPORT_ACTION,
          summary: args.summary,
          details: args.details ? JSON.stringify(args.details) : null,
          created_at: epochSeconds(),
        });
        return textResult(report);
      },
      { annotations: { readOnlyHint: true } },
    ),
  };

  return [okfReadBundle, okfListChanges, okfWriteConcept, okfReport];
}
