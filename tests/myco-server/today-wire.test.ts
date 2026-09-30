/**
 * Today's wire shapes, as the dashboard declares them, match the server's.
 *
 * The dashboard cannot import the server's declarations of `/api/work`,
 * `/api/attention`, capture recency and the lists across Projects: they sit in
 * modules whose runtime imports its build does not carry. So it declares them
 * in `features/today/wire.ts`, and this file holds the two to each other. The
 * assertions are types: `npm run typecheck:tests` fails when a shape drifts,
 * and the one runtime expectation keeps the file a test Bun collects.
 */
import { describe, expect, it } from 'bun:test';
import type * as Ui from '../../packages/myco-server/ui/src/features/today/wire.ts';
import type { WorkAnswer, WorkOutcome, WorkRun, Upkeep, OutcomeKind, RunResult } from '../../packages/myco-server/src/read/work.ts';
import type { AttentionAnswer, AttentionItem } from '../../packages/myco-server/src/core/attention.ts';
import type { CaptureRow } from '../../packages/myco-server/src/read/capture.ts';
import type { SessionAcrossRow } from '../../packages/myco-server/src/read/sessions.ts';
import type { SporeAcrossRow } from '../../packages/myco-server/src/core/spores.ts';

/** True only when each type is assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** True when what the server sends carries every field the dashboard reads, typed as it reads it. */
type Reads<Server, Dashboard> = [Server] extends [Dashboard] ? true : false;

const SAME: [
  Same<Ui.OutcomeKind, OutcomeKind>,
  Same<Ui.RunResult, RunResult>,
  Same<Ui.WorkOutcome, WorkOutcome>,
  Same<Ui.WorkRun, WorkRun>,
  Same<Ui.Upkeep, Upkeep>,
  Same<Ui.WorkAnswer, WorkAnswer>,
  Same<Ui.AttentionItem, AttentionItem>,
  Same<Ui.AttentionAnswer, AttentionAnswer>,
  Same<Ui.CaptureRow, CaptureRow>,
] = [true, true, true, true, true, true, true, true, true];

const READS: [
  Reads<SessionAcrossRow, Ui.TodaySession>,
  Reads<SporeAcrossRow, Ui.TodaySpore>,
] = [true, true];

describe("Today's wire shapes", () => {
  it('are held to the server declarations by the tests typecheck', () => {
    expect([...SAME, ...READS].every(Boolean)).toBe(true);
  });
});
