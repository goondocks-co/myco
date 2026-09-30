/**
 * The Sessions pages' wire shapes, as the dashboard declares them, match the server's.
 *
 * The dashboard cannot import the server's declarations of the session list
 * across Projects or of a session's outcome: they sit in modules whose runtime
 * imports its build does not carry. So it declares them in
 * `features/sessions/wire.ts`, and this file holds the two to each other. The
 * assertions are types: `npm run typecheck:tests` fails when a shape drifts,
 * and the one runtime expectation keeps the file a test Bun collects.
 */
import { describe, expect, it } from 'bun:test';
import type * as Ui from '../../packages/myco-server/ui/src/features/sessions/wire.ts';
import type { SessionAcrossRow, listSessionSummariesAcross } from '../../packages/myco-server/src/read/sessions.ts';
import type { OutcomeSpore, SessionOutcome, SessionRun, sessionOutcome } from '../../packages/myco-server/src/read/run-reads.ts';
import type { ResumeCommand } from '../../packages/myco-server/src/core/resume-command.ts';

/** True only when each type is assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** True when what the server sends carries every field the dashboard reads, typed as it reads it. */
type Reads<Server, Dashboard> = [Server] extends [Dashboard] ? true : false;

const SAME: [
  Same<Ui.OutcomeSpore, OutcomeSpore>,
  Same<Ui.SessionRun, SessionRun>,
  Same<Ui.SessionOutcome, SessionOutcome>,
  Same<Ui.SessionOutcome, Awaited<ReturnType<typeof sessionOutcome>>>,
  Same<Ui.ResumeCommand, ResumeCommand>,
] = [true, true, true, true, true];

/** `GET /api/sessions`: the page the read across Projects answers, as the handler sends it. */
type SessionsAnswer = Awaited<ReturnType<typeof listSessionSummariesAcross>>;

const READS: [
  Reads<SessionAcrossRow, Ui.SessionListRow>,
  Reads<SessionsAnswer, Ui.SessionListPage>,
] = [true, true];

describe("the Sessions pages' wire shapes", () => {
  it('are held to the server declarations by the tests typecheck', () => {
    expect([...SAME, ...READS].every(Boolean)).toBe(true);
  });
});
