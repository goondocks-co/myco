/**
 * Today's wire shapes, as the dashboard declares them, match the server's.
 *
 * The dashboard cannot import the server's declarations of `/api/work`,
 * `/api/attention`, `/api/uncaptured`, capture recency and the lists across Projects: they sit in
 * modules whose runtime imports its build does not carry. So it declares them
 * in `features/today/wire.ts`, and this file holds the two to each other. The
 * assertions are types: `npm run typecheck:tests` fails when a shape drifts,
 * and the one runtime expectation keeps the file a test Bun collects.
 */
import { describe, expect, it } from 'bun:test';
import type { SetupProgress } from '../../packages/myco-server/src/api/setup.ts';
import type * as Ui from '../../packages/myco-server/ui/src/features/today/wire.ts';
import type {
  WorkAnswer,
  WorkOutcome,
  WorkRun,
  Upkeep,
  OutcomeKind,
} from '../../packages/myco-server/src/read/work.ts';
import type { RunResult } from '../../packages/myco-server/src/read/run-outcome';
import type { AttentionAnswer, AttentionItem } from '../../packages/myco-server/src/core/attention.ts';
import type { CaptureRow } from '../../packages/myco-server/src/read/capture.ts';
import type { ConnectAnswer, ConnectRefusal, ConnectRefusalCode, ConnectRequest, UncapturedAnswer, UncapturedRootItem } from '../../packages/myco-server/src/api/uncaptured.ts';
import type { HeldState, UncapturedReason } from '../../packages/myco-shared/src/member-protocol.ts';
import type {
  sessions_SessionAcrossRow as SessionAcrossRow,
  sessions_listSessionSummariesAcross as listSessionSummariesAcross,
} from '../../packages/myco-server/src/read/catalog/sessions';
import type { SporeAcrossRow, listSporePageAcross } from '../../packages/myco-server/src/core/spores.ts';

/** True only when each type is assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** True when what the server sends carries every field the dashboard reads, typed as it reads it. */
type Reads<Server, Dashboard> = [Server] extends [Dashboard] ? true : false;

const SAME: [
  Same<Ui.SetupProgress, SetupProgress>,
  Same<Ui.OutcomeKind, OutcomeKind>,
  Same<Ui.RunResult, RunResult>,
  Same<Ui.WorkOutcome, WorkOutcome>,
  Same<Ui.WorkRun, WorkRun>,
  Same<Ui.Upkeep, Upkeep>,
  Same<Ui.WorkAnswer, WorkAnswer>,
  Same<Ui.AttentionItem, AttentionItem>,
  Same<Ui.AttentionAnswer, AttentionAnswer>,
  Same<Ui.CaptureRow, CaptureRow>,
  Same<Ui.UncapturedReason, UncapturedReason>,
  Same<Ui.HeldState, HeldState>,
  Same<Ui.UncapturedRootItem, UncapturedRootItem>,
  Same<Ui.UncapturedAnswer, UncapturedAnswer>,
  Same<Ui.ConnectRequest, ConnectRequest>,
  Same<Ui.ConnectAnswer, ConnectAnswer>,
  Same<Ui.ConnectRefusalCode, ConnectRefusalCode>,
  Same<Ui.ConnectRefusal, ConnectRefusal>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];

/** `GET /api/sessions`: the page the read across Projects answers, as the handler sends it. */
type SessionsAnswer = Awaited<ReturnType<typeof listSessionSummariesAcross>>;
/** `GET /api/spores`: the handler (`api/lists-all.ts`) sends the page with its `rows` renamed `spores`. */
type SporePage = NonNullable<Awaited<ReturnType<typeof listSporePageAcross>>>;
type SporesAnswer = Omit<SporePage, 'rows'> & { spores: SporePage['rows'] };

const READS: [
  Reads<SessionAcrossRow, Ui.TodaySession>,
  Reads<SporeAcrossRow, Ui.TodaySpore>,
  Reads<SessionsAnswer, Ui.TodaySessionPage>,
  Reads<SporesAnswer, Ui.TodaySporePage>,
] = [true, true, true, true];

describe("Today's wire shapes", () => {
  it('are held to the server declarations by the tests typecheck', () => {
    expect([...SAME, ...READS].every(Boolean)).toBe(true);
  });
});
