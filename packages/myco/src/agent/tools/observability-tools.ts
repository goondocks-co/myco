/**
 * Observability vault tools.
 *
 * 2 tools: vault_report, vault_run_health
 */

import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds } from '@myco/constants.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { countRunToolCallsByOutcome } from '@myco/db/queries/agent-run-events.js';
import {
  findCapHits,
  findCostSpikes,
  findFlagClusters,
  findPostConditionFailures,
  findSilentStreams,
  findUnpairedEvents,
  findZeroUsageRuns,
  resolveRunHealthWindow,
} from '@myco/db/queries/run-health.js';
import { textResult, stampRunIdInPayload, stampSporeCountInPayload, projectScopeFromVaultToolDeps, type VaultToolDeps } from './types.js';
import { rowProjectIdFromRequestContext } from '@myco/grove/request-context.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default lookback window for vault_run_health, in hours. */
const DEFAULT_RUN_HEALTH_WINDOW_HOURS = 24;

/** Default ratio threshold for cost-spike detection (window mean / trailing mean). */
const DEFAULT_COST_SPIKE_RATIO = 2;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createObservabilityTools(deps: VaultToolDeps) {
  const { runId, agentId } = deps;
  const projectId = rowProjectIdFromRequestContext(deps.requestContext);
  const scope = projectScopeFromVaultToolDeps(deps);

  const vaultReport = {
    ...tool(
      'vault_report',
      'Record an observability report for the current run. Use action "skip" when skipping expected operations (e.g., the digest is already current and needs no update) with reasoning in the summary field. When details contains a run_id field, the daemon stamps it to the current run\'s id server-side — you do not need to reproduce the run id exactly.',
      {
        action: z.string().describe('Action name (e.g., extract, consolidate, digest, skip)'),
        summary: z.string().describe('Human-readable summary of what was done'),
        details: z.record(z.string(), z.unknown()).optional().describe('Structured details as key-value pairs'),
      },
      async (args) => {
        const now = epochSeconds();

        // run_id is stamped upstream in normalizeArgs (no DB access there);
        // spores_created needs a query against this run's event log, which
        // only the handler can do, so it is stamped here instead.
        let details = args.details;
        if (details && typeof details === 'object' && !Array.isArray(details) && 'spores_created' in details) {
          const sporesCreated = countRunToolCallsByOutcome(runId, 'vault_create_spore', 'success');
          details = stampSporeCountInPayload(details, sporesCreated) as typeof details;
        }

        const report = insertReport({
          run_id: runId,
          project_id: projectId,
          agent_id: agentId,
          action: args.action,
          summary: args.summary,
          details: details ? JSON.stringify(details) : null,
          created_at: now,
        });

        return textResult(report);
      },
      { annotations: { readOnlyHint: true } },
    ),
    // Same fabricated-run_id class as vault_set_state: skill-evolve's
    // assess report details carry a run_id the postconditions validate.
    // `details` is already an object on the wire — stamp in place.
    normalizeArgs: (args: Record<string, unknown>, ctx: { runId: string }) => {
      const stamped = stampRunIdInPayload(args.details, ctx.runId);
      if (stamped === args.details) return args;
      return { ...args, details: stamped };
    },
  };

  const vaultRunHealth = tool(
    'vault_run_health',
    'Read aggregate harness-health signals over agent_runs, agent_run_events, and agent_run_write_intents for a lookback window. Use this to interpret harness health for a scheduled sentinel report — it never re-derives anomalies from raw rows; every bucket is pre-computed deterministic SQL, so treat the counts and attributions as ground truth and focus on narrating what they mean. The buckets: unpaired_events (pre/post tool-use count mismatches — a process death or swallowed insert, not necessarily a tool error), cap_hits (phases that hit their turn budget), postcondition_failures (phases whose postCondition gate rejected an otherwise-complete result), cost_spikes (task/provider pairs whose mean cost jumped vs the trailing window), flag_clusters (writes the semantic classifier blocked), zero_usage (completed or failed runs with no recorded token/cost telemetry), and silent_streams (info-tier only: schedule-enabled tasks with no preCondition gate that produced zero runs — may be entirely expected).',
    {
      window_hours: z.number().optional().describe(`Lookback window in hours (default ${DEFAULT_RUN_HEALTH_WINDOW_HOURS}).`),
      task: z.string().optional().describe('Restrict cost_spikes and zero_usage attribution to a single task name. Other buckets are unaffected — they are run/event-level, not task-filtered.'),
      cost_spike_ratio: z.number().optional().describe(`Minimum (window mean cost / trailing-window mean cost) ratio to report a cost spike (default ${DEFAULT_COST_SPIKE_RATIO}).`),
    },
    async (args) => {
      const windowHours = args.window_hours ?? DEFAULT_RUN_HEALTH_WINDOW_HOURS;
      const spikeRatio = args.cost_spike_ratio ?? DEFAULT_COST_SPIKE_RATIO;
      const window = resolveRunHealthWindow(windowHours);

      const unpairedEvents = findUnpairedEvents(window, scope, runId);
      const capHits = findCapHits(window, scope);
      const postConditionFailures = findPostConditionFailures(window, scope);
      let costSpikes = findCostSpikes(window, scope, spikeRatio);
      let zeroUsage = findZeroUsageRuns(window, scope);
      const flagClusters = findFlagClusters(window, scope);
      const silentStreams = findSilentStreams(window, scope);

      if (args.task) {
        costSpikes = costSpikes.filter((row) => row.task === args.task);
        zeroUsage = zeroUsage.filter((row) => row.task === args.task);
      }

      return textResult({
        window: {
          window_hours: windowHours,
          started_after: window.startedAfter,
          ended_before: window.endedBefore,
        },
        buckets: {
          unpaired_events: {
            description: 'agent_run_events groups whose pre_tool_use and post_tool_use counts differ within the window. post_tool_use fires even on tool errors (outcome \'error\'), so a count diff signals a process death mid-tool or a swallowed best-effort insert, not necessarily a tool failure. Excludes the calling run itself; an in-flight OTHER run\'s current tool call can still appear transiently until its post_tool_use event lands.',
            entries: unpairedEvents,
          },
          cap_hits: {
            description: 'Phases (from actions_taken.phases[].capHit) that failed because the harness exhausted the phase turn budget, on either the success or failure path.',
            entries: capHits,
          },
          postcondition_failures: {
            description: 'Phases (from actions_taken.phases[].postConditionFailed) whose declared postCondition rejected an otherwise-complete result. Detected via the JSON flag, not error-string matching — the executor\'s wrapped error text does not reliably survive to a matchable column.',
            entries: postConditionFailures,
          },
          cost_spikes: {
            description: `(task, provider) pairs whose mean cost_usd in the window is at least ${spikeRatio}x the mean cost_usd in the equal-length trailing window. Zero-cost rows are excluded from both means (local providers hard-zero costUsd, which would otherwise mask a real spike). A pair with no nonzero-cost trailing baseline is never reported.`,
            entries: costSpikes,
          },
          flag_clusters: {
            description: 'agent_run_write_intents rows whose classifier_verdict is the literal string \'flag\' — writes the semantic-check classifier blocked. Excludes ordinary dry-run-intercepted writes, which record classifier_verdict = NULL and would otherwise dominate an unfiltered count.',
            entries: flagClusters,
          },
          zero_usage: {
            description: 'Completed runs with tokens_used = 0, plus failed runs whose usage telemetry is entirely zero or absent. Info-tier visibility, not an alarm: this flags runs whose failure telemetry was unrecoverable, not a claim that every failed local run qualifies.',
            entries: zeroUsage,
          },
          silent_streams: {
            description: 'Info-tier only, never alarmed: bundled-YAML-default-enabled tasks with no task-level preCondition gate that produced zero runs in the window. Read from the static bundled task definitions, not the effective per-project myco.yaml schedule (that resolution is internal to the scheduler and unreachable from this tool) — a task may be legitimately silent because a project override disabled it.',
            entries: silentStreams,
          },
        },
      });
    },
    { annotations: { readOnlyHint: true } },
  );

  return [vaultReport, vaultRunHealth];
}
