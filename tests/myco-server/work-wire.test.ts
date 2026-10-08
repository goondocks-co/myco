/**
 * The shapes Myco's work reads off the wire, as the dashboard declares them, match the server's.
 *
 * The dashboard cannot import the server's declarations of a run, its reads or
 * a dispatch's refusals: they sit in modules whose runtime imports its build
 * does not carry. So it declares them in `features/work/wire.ts`, and this file
 * holds the two to each other. The assertions are types: `npm run
 * typecheck:tests` fails when a shape drifts, and the one runtime expectation
 * keeps the file a test Bun collects. `/api/work` itself is held by
 * `today-wire.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import type * as Ui from '../../packages/myco-server/ui/src/features/work/wire.ts';
import type { RunAttemptRow, RunPageRow, RunStepPage, RunStepRow, listRuns } from '../../packages/myco-server/src/read/runs.ts';
import type { DashboardRunDetail } from '../../packages/myco-server/src/api/agent-runs.ts';
import type { RunAudit } from '../../packages/myco-server/src/core/run-audit.ts';
import type { RunOutcomeCounts, RunReadSession, RunReads } from '../../packages/myco-server/src/read/run-reads.ts';
import type { ReportRow } from '../../packages/myco-server/src/core/runs.ts';
import type { CAPABILITY_OFF } from '../../packages/myco-server/src/core/harness.ts';

/** True only when each type is assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** True when what the server sends carries every field the dashboard reads, typed as it reads it. */
type Reads<Server, Dashboard> = [Server] extends [Dashboard] ? true : false;

/** `GET /api/projects/{p}/runs/{r}`: the answer `handleProjectRun` sends. */
type RunDetailAnswer = DashboardRunDetail & { reports: ReportRow[] } & RunReads & { projectId: string };

const SAME: [
  Same<Ui.RunOutcomeCounts, RunOutcomeCounts>,
  Same<Ui.RunReadSession, RunReadSession>,
  Same<Ui.RunWorker, NonNullable<RunPageRow['worker']>>,
  Same<Ui.CapabilityOffRefusal['error'], typeof CAPABILITY_OFF>,
  Same<Ui.RunAttempt, RunAttemptRow>,
  Same<Ui.RunStep, RunStepRow>,
  Same<Ui.RunStepPage, RunStepPage>,
  Same<Ui.RunAudit, RunAudit>,
] = [true, true, true, true, true, true, true, true];

const READS: [
  Reads<RunPageRow, Ui.RunPageRow>,
  Reads<Awaited<ReturnType<typeof listRuns>>, Ui.RunPage>,
  Reads<RunDetailAnswer, Ui.RunDetailAnswer>,
] = [true, true, true];

describe("Myco's work's wire shapes", () => {
  it('are held to the server declarations by the tests typecheck', () => {
    expect([...SAME, ...READS].every(Boolean)).toBe(true);
  });
});
