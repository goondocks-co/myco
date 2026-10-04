import { DEFAULT_DISPATCH_TIMEOUT_SECONDS, RUN_OVERRUN_MARGIN_MS } from './harness.js';
import type { RunRow } from './runs.js';

/** The bound a dispatched run carries, or the dispatcher's default when it carries none. */
export function timeoutSecondsOf(runContext: string | null): number {
  if (runContext === null) return DEFAULT_DISPATCH_TIMEOUT_SECONDS;
  try {
    const parsed: unknown = JSON.parse(runContext);
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as { timeoutSeconds?: unknown }).timeoutSeconds : undefined;
    return typeof value === 'number' && value > 0 ? value : DEFAULT_DISPATCH_TIMEOUT_SECONDS;
  } catch {
    return DEFAULT_DISPATCH_TIMEOUT_SECONDS;
  }
}

/** The instant past which a runtime has outlived its bound and the Deployment's margin. */
export function staleAfter(startedAt: number, runContext: string | null): number {
  return startedAt + timeoutSecondsOf(runContext) * 1000 + RUN_OVERRUN_MARGIN_MS;
}

/** The deadline of the dispatch's current attempt. */
export function runDeadline(run: Pick<RunRow, 'resumedAt' | 'startedAt' | 'runContext'>): number {
  const attemptAt = run.resumedAt ?? run.startedAt;
  return attemptAt === null ? 0 : staleAfter(attemptAt, run.runContext);
}

/** The same deadline evaluated against the row a guarded write changes. */
export function runDeadlineSql(): string {
  const timeout = `CASE WHEN json_valid(run_context) THEN
    CASE WHEN json_type(run_context, '$.timeoutSeconds') IN ('integer', 'real') AND json_extract(run_context, '$.timeoutSeconds') > 0
      THEN json_extract(run_context, '$.timeoutSeconds') ELSE ${DEFAULT_DISPATCH_TIMEOUT_SECONDS} END
    ELSE ${DEFAULT_DISPATCH_TIMEOUT_SECONDS} END`;
  return `(CASE WHEN COALESCE(resumed_at, started_at) IS NULL THEN 0
    ELSE COALESCE(resumed_at, started_at) + (${timeout}) * 1000 + ${RUN_OVERRUN_MARGIN_MS} END)`;
}
