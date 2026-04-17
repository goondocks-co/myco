/**
 * CLI `agent eval` command — run an evaluation matrix across runtime/reasoning/model
 * variants via the daemon API.
 *
 * POSTs to /api/agent/evaluations (fire-and-forget) then polls
 * GET /api/agent/evaluations/:id until the evaluation completes or times out.
 */

import fs from 'node:fs';
import path from 'node:path';
import { connectToDaemon } from './shared.js';
import { enumerateMatrixCells, type EvaluationMatrixCell } from '../agent/evaluation-matrix.js';
import { runDurationMs } from '../agent/run-accounting.js';
import type { RuntimeId, ReasoningLevel } from '../agent/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-phase overrides applied to every cell in the matrix. A phase entry
 * can pin `reasoningLevel`, `model`, or both — the executor merges these
 * on top of the cell-level runtime/reasoning/model at phase-execute time.
 */
export type PhaseOverrideMap = Record<
  string,
  { reasoningLevel?: ReasoningLevel; model?: string }
>;

interface EvalMatrix {
  runtimes?: RuntimeId[];
  reasoningLevels?: ReasoningLevel[];
  models?: string[];
  dryRun?: boolean;
  notes?: string;
  phases?: PhaseOverrideMap;
}

interface ParsedArgs {
  taskId: string;
  matrix: EvalMatrix;
  notes?: string;
  pollInterval: number;
  timeout: number;
  noWait: boolean;
}

/**
 * One row in the comparison table. Task A persists the reasoning level and
 * full execution-override packet on each `agent_runs` row (and the daemon
 * serializes both into the API response), so the CLI reads per-cell
 * attribution directly from the run row — no client-side zip against the
 * enumerated matrix cells is required. `enumerateMatrixCells` is still
 * used for display metadata (cell count, phase overlay).
 */
interface TableRow {
  runtime: string;
  reasoning: string;
  model: string;
  dryRun: string;
  status: string;
  turns: string;
  tokens: string;
  cost: string;
  duration: string;
  /**
   * Compact summary of `matrix.phases` pins shared across all cells, e.g.
   * `"extract=low, digest=high"`. Rendered only when at least one row has
   * a non-empty value (i.e. the matrix had a `phases` overlay).
   */
  phaseOverrides?: string;
}

interface RunRecord {
  id: string;
  runtime?: string | null;
  model?: string | null;
  reasoning_level?: string | null;
  status?: string | null;
  started_at?: number | null;
  completed_at?: number | null;
  tokens_used?: number | null;
  cost_usd?: number | null;
  dry_run?: number | boolean | null;
  error?: string | null;
  actions_taken?: number | null;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `Usage: myco agent eval [options]

Run an evaluation matrix across runtime/reasoning/model variants.

Options:
  --task <taskId>             Task to evaluate (required)
  --runtimes <r1,r2>          Comma-separated runtimes: claude-sdk, openai-agents
  --reasoning <l1,l2>         Comma-separated reasoning levels: low, default, high
  --models <m1,m2>            Comma-separated model names
  --phase-reasoning <pairs>   Per-phase reasoning pins: "extract:low,digest:high"
  --phase-model <pairs>       Per-phase model pins: "extract:claude-haiku-4-5,digest:claude-opus-4-6"
  --dry-run                   Run in dry-run mode (writes intercepted, not applied)
  --notes "<text>"            Optional notes for this evaluation
  --poll-interval <seconds>   Polling interval (default: 10)
  --timeout <seconds>         Max wait time in seconds (default: 3600)
  --no-wait                   Print evaluation id and exit without polling
  --help, -h                  Show this help message

Examples:
  myco agent eval --task full-intelligence --dry-run --no-wait
  myco agent eval --task full-intelligence --runtimes claude-sdk,openai-agents --dry-run
  myco agent eval --task full-intelligence --reasoning low,high --models claude-opus-4-5
`;

// ---------------------------------------------------------------------------
// Phase arg parser
// ---------------------------------------------------------------------------

const VALID_REASONING: ReadonlySet<ReasoningLevel> = new Set(['low', 'default', 'high']);

/**
 * Parse a comma-separated list of "phase:value" pairs into a phase-keyed
 * object. The value is injected into the entry under `field`.
 *
 * Merges into an existing accumulator so `--phase-reasoning` and
 * `--phase-model` can collide on the same phase and combine their fields.
 *
 * Throws with a human-readable message on a malformed pair (missing colon,
 * empty phase, or — when `field` is `reasoningLevel` — a value outside
 * `'low' | 'default' | 'high'`).
 */
export function parsePhaseArg(
  raw: string,
  field: 'reasoningLevel' | 'model',
  acc: PhaseOverrideMap = {},
): PhaseOverrideMap {
  const pairs = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (pairs.length === 0) {
    throw new Error(`--phase-${field === 'reasoningLevel' ? 'reasoning' : 'model'} produced zero pairs after splitting`);
  }
  for (const pair of pairs) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 1 || colonIdx === pair.length - 1) {
      throw new Error(`Malformed phase pair "${pair}" — expected "<phase>:<value>"`);
    }
    const phase = pair.slice(0, colonIdx).trim();
    const value = pair.slice(colonIdx + 1).trim();
    if (!phase || !value) {
      throw new Error(`Malformed phase pair "${pair}" — expected "<phase>:<value>"`);
    }
    if (field === 'reasoningLevel' && !VALID_REASONING.has(value as ReasoningLevel)) {
      throw new Error(
        `Invalid reasoning level "${value}" for phase "${phase}" — expected low, default, or high`,
      );
    }
    const existing = acc[phase] ?? {};
    acc[phase] = {
      ...existing,
      ...(field === 'reasoningLevel'
        ? { reasoningLevel: value as ReasoningLevel }
        : { model: value }),
    };
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

/**
 * Parse CLI args into a typed structure. Throws with a human-readable message
 * on invalid input.
 */
export function parseArgs(args: string[]): ParsedArgs {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  // Helper to get the value after a flag
  const getFlag = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const val = args[idx + 1];
    if (!val || val.startsWith('--')) return undefined;
    return val;
  };

  const taskId = getFlag('--task');
  if (!taskId) {
    throw new Error('--task <taskId> is required');
  }

  const runtimesRaw = getFlag('--runtimes');
  const reasoningRaw = getFlag('--reasoning');
  const modelsRaw = getFlag('--models');
  const phaseReasoningRaw = getFlag('--phase-reasoning');
  const phaseModelRaw = getFlag('--phase-model');
  const notesRaw = getFlag('--notes');
  const pollIntervalRaw = getFlag('--poll-interval');
  const timeoutRaw = getFlag('--timeout');

  const dryRun = args.includes('--dry-run');
  const noWait = args.includes('--no-wait');

  const matrix: EvalMatrix = {};

  if (runtimesRaw !== undefined) {
    const runtimes = runtimesRaw
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean) as RuntimeId[];
    if (runtimes.length === 0) {
      throw new Error('--runtimes produced zero values after splitting');
    }
    matrix.runtimes = runtimes;
  }

  if (reasoningRaw !== undefined) {
    const reasoningLevels = reasoningRaw
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean) as ReasoningLevel[];
    if (reasoningLevels.length === 0) {
      throw new Error('--reasoning produced zero values after splitting');
    }
    matrix.reasoningLevels = reasoningLevels;
  }

  if (modelsRaw !== undefined) {
    const models = modelsRaw
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    if (models.length === 0) {
      throw new Error('--models produced zero values after splitting');
    }
    matrix.models = models;
  }

  if (dryRun) {
    matrix.dryRun = true;
  }

  if (notesRaw) {
    matrix.notes = notesRaw;
  }

  // `--phase-reasoning` and `--phase-model` can target the same phase; they
  // merge into a single entry with whichever fields were specified.
  let phases: PhaseOverrideMap | undefined;
  if (phaseReasoningRaw !== undefined) {
    phases = parsePhaseArg(phaseReasoningRaw, 'reasoningLevel', phases ?? {});
  }
  if (phaseModelRaw !== undefined) {
    phases = parsePhaseArg(phaseModelRaw, 'model', phases ?? {});
  }
  if (phases && Object.keys(phases).length > 0) {
    matrix.phases = phases;
  }

  const pollInterval = pollIntervalRaw ? parseInt(pollIntervalRaw, 10) : 10;
  if (isNaN(pollInterval) || pollInterval < 1) {
    throw new Error('--poll-interval must be a positive integer');
  }

  const timeout = timeoutRaw ? parseInt(timeoutRaw, 10) : 3600;
  if (isNaN(timeout) || timeout < 1) {
    throw new Error('--timeout must be a positive integer');
  }

  return {
    taskId,
    matrix,
    notes: notesRaw,
    pollInterval,
    timeout,
    noWait,
  };
}

// ---------------------------------------------------------------------------
// Matrix cell enumeration (display only)
// ---------------------------------------------------------------------------

/**
 * Thin re-export of the shared `enumerateMatrixCells` helper. The CLI used
 * to zip enumerated cells against child runs to derive per-cell
 * attribution, but each `agent_runs` row now persists its own runtime /
 * reasoning_level / execution_overrides (Task A + C), so per-row fields
 * come from the run row itself. This helper is retained solely for
 * display metadata (initial cell count, phase overlay rendering).
 */
export function enumerateCells(matrix: EvalMatrix): EvaluationMatrixCell[] {
  return enumerateMatrixCells(matrix);
}

// ---------------------------------------------------------------------------
// Table formatter
// ---------------------------------------------------------------------------

const TABLE_COLUMNS: Array<{ key: keyof TableRow; header: string }> = [
  { key: 'runtime', header: 'runtime' },
  { key: 'reasoning', header: 'reasoning' },
  { key: 'model', header: 'model' },
  { key: 'dryRun', header: 'dry-run' },
  { key: 'status', header: 'status' },
  { key: 'turns', header: 'turns' },
  { key: 'tokens', header: 'tokens' },
  { key: 'cost', header: 'cost' },
  { key: 'duration', header: 'duration' },
];

/**
 * Render `matrix.phases` as a compact summary like `"extract=low,
 * digest=high"`. When a phase entry has both `reasoningLevel` and `model`
 * pinned, only `reasoningLevel` is shown (model pins are usually long and
 * would blow out the table); the JSON report carries the full fidelity.
 *
 * Returns an empty string for missing / empty input so `formatTable` can
 * cheaply detect whether the column should appear at all.
 */
export function formatPhaseOverrides(phases: PhaseOverrideMap | undefined): string {
  if (!phases) return '';
  const entries = Object.entries(phases);
  if (entries.length === 0) return '';
  return entries
    .map(([phase, pin]) => {
      if (pin.reasoningLevel) return `${phase}=${pin.reasoningLevel}`;
      if (pin.model) return `${phase}=${pin.model}`;
      return phase;
    })
    .join(', ');
}

/**
 * Format rows into a plain-ASCII table with per-column width padding.
 * Returns the table as a string (no trailing newline).
 *
 * The "phase overrides" column is shown only when at least one row has a
 * non-empty `phaseOverrides` value; otherwise it's omitted entirely so
 * the common (no-phase-pins) output stays compact.
 */
export function formatTable(rows: TableRow[]): string {
  const includePhaseOverrides = rows.some((r) => (r.phaseOverrides ?? '').length > 0);
  const columns: Array<{ key: keyof TableRow; header: string }> = includePhaseOverrides
    ? [...TABLE_COLUMNS, { key: 'phaseOverrides', header: 'phase overrides' }]
    : TABLE_COLUMNS;

  // Compute column widths = max(header.length, max(cell.length)) for each col
  const widths = columns.map(({ key, header }) => {
    let max = header.length;
    for (const row of rows) {
      const cell = row[key] ?? '';
      if (cell.length > max) max = cell.length;
    }
    return max;
  });

  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');
  const headerLine = columns.map(({ header }, i) => header.padEnd(widths[i])).join(' | ');

  const dataLines = rows.map((row) =>
    columns.map(({ key }, i) => (row[key] ?? '').padEnd(widths[i])).join(' | ')
  );

  return [headerLine, sep, ...dataLines].join('\n');
}

// ---------------------------------------------------------------------------
// Elapsed-time formatter
// ---------------------------------------------------------------------------

function fmtElapsed(seconds: number): string {
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  return `${String(mm).padStart(2, '0')}:${ss}`;
}

// ---------------------------------------------------------------------------
// JSON report writer
// ---------------------------------------------------------------------------

function writeReport(
  vaultDir: string,
  evaluationId: string,
  taskId: string,
  matrix: EvalMatrix,
  status: string,
  createdAt: number | undefined,
  completedAt: number | undefined,
  runs: RunRecord[],
  aggregate: Record<string, unknown>,
): void {
  const reportDir = path.join(vaultDir, 'digest', 'evaluations');
  fs.mkdirSync(reportDir, { recursive: true });

  const reportCells = runs.map((run) => ({
    runId: run.id,
    runtime: run.runtime ?? null,
    reasoningLevel: run.reasoning_level ?? null,
    model: run.model ?? null,
    dryRun: run.dry_run === 1 || run.dry_run === true,
    status: run.status ?? null,
    turns: run.actions_taken ?? null,
    tokens: run.tokens_used ?? null,
    costUsd: run.cost_usd ?? null,
    durationMs: runDurationMs({
      started_at: run.started_at ?? null,
      completed_at: run.completed_at ?? null,
    }),
    error: run.error ?? null,
  }));

  const report = {
    evaluationId,
    taskId,
    matrix,
    status,
    createdAt: createdAt ?? null,
    completedAt: completedAt ?? null,
    cells: reportCells,
    aggregate,
  };

  const reportPath = path.join(reportDir, `${evaluationId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Report written to ${reportPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(args: string[], vaultDir: string): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    console.error(`myco agent eval: ${(err as Error).message}`);
    process.stdout.write(HELP);
    process.exit(1);
  }

  const { taskId, matrix, notes, pollInterval, timeout, noWait } = parsed;

  const client = await connectToDaemon(vaultDir);

  // POST to create evaluation
  const createResult = await client.post('/api/agent/evaluations', {
    taskId,
    matrix,
    ...(notes ? { notes } : {}),
  });

  if (!createResult.ok || !createResult.data?.evaluationId) {
    console.error('Failed to create evaluation');
    if (createResult.data?.error) {
      console.error(`  ${createResult.data.error}`);
    }
    process.exit(1);
  }

  const { evaluationId, cellCount } = createResult.data as {
    evaluationId: string;
    cellCount: number;
  };

  console.log(`Evaluation created: ${evaluationId}`);
  console.log(`  task: ${taskId}`);
  console.log(`  cells: ${cellCount}`);
  if (matrix.dryRun) console.log('  mode: dry-run');

  if (noWait) {
    process.exit(0);
  }

  // Poll until done or timeout. Per-row attribution comes from the run row
  // itself (runtime/reasoning_level/model) — no client-side zip required.
  const startTime = Date.now();
  let lastStatus = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed >= timeout) {
      console.error(`\nEvaluation timed out after ${timeout}s`);
      process.exit(2);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));

    const getResult = await client.get(`/api/agent/evaluations/${evaluationId}`);
    if (!getResult.ok || !getResult.data) {
      console.error('Failed to poll evaluation status');
      continue;
    }

    const { evaluation, runs, aggregate } = getResult.data as {
      evaluation: {
        id: string;
        taskId: string;
        matrix: EvalMatrix;
        notes?: string;
        status: string;
        createdAt?: number;
        completedAt?: number;
      };
      runs: RunRecord[];
      aggregate: {
        total: number;
        completed: number;
        failed: number;
        skipped: number;
        totalTokens: number;
        totalCostUsd: number;
      };
    };

    const { completed, total } = aggregate;
    const elapsedStr = fmtElapsed(elapsed);
    const currentRun = runs.find((r) => r.status === 'running');
    const runningInfo = currentRun
      ? ` — running cell ${completed + 1} (${currentRun.runtime ?? 'default'}/${currentRun.reasoning_level ?? 'default'})`
      : '';

    const statusLine = `[${elapsedStr}] ${completed}/${total} cells complete${runningInfo}`;
    if (statusLine !== lastStatus) {
      console.log(statusLine);
      lastStatus = statusLine;
    }

    const done = evaluation.status === 'completed' || evaluation.status === 'failed';
    if (done) {
      console.log(`\nEvaluation ${evaluation.status}: ${evaluationId}`);

      // Build comparison table from the run rows themselves — each row
      // carries runtime / reasoning_level / model / dry_run populated by
      // the executor, so no zip against enumerated matrix cells is needed.
      const phaseOverridesStr = formatPhaseOverrides(evaluation.matrix.phases);
      const tableRows: TableRow[] = runs.map((run) => {
        const durationMs = runDurationMs({
          started_at: run.started_at ?? null,
          completed_at: run.completed_at ?? null,
        });
        const durationStr = durationMs !== null ? `${(durationMs / 1000).toFixed(1)}s` : '-';
        const costStr = run.cost_usd !== null && run.cost_usd !== undefined
          ? `$${run.cost_usd.toFixed(4)}`
          : '-';
        return {
          runtime: run.runtime ?? '(default)',
          reasoning: run.reasoning_level ?? '(task default)',
          model: run.model ?? '(default)',
          dryRun: (run.dry_run === 1 || run.dry_run === true) ? 'yes' : 'no',
          status: run.status ?? 'unknown',
          turns: String(run.actions_taken ?? '-'),
          tokens: String(run.tokens_used ?? '-'),
          cost: costStr,
          duration: durationStr,
          ...(phaseOverridesStr ? { phaseOverrides: phaseOverridesStr } : {}),
        };
      });

      if (tableRows.length > 0) {
        console.log('\n' + formatTable(tableRows));
      }

      // Summary line
      console.log(
        `\nAggregate: ${aggregate.completed} completed, ${aggregate.failed} failed, ${aggregate.skipped} skipped` +
        ` | tokens: ${aggregate.totalTokens} | cost: $${aggregate.totalCostUsd.toFixed(4)}`
      );

      // Write JSON report
      writeReport(
        vaultDir,
        evaluationId,
        evaluation.taskId,
        evaluation.matrix,
        evaluation.status,
        evaluation.createdAt,
        evaluation.completedAt,
        runs,
        aggregate as Record<string, unknown>,
      );

      process.exit(evaluation.status === 'completed' ? 0 : 1);
    }
  }
}
