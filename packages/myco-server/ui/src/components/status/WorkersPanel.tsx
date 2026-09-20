import { Panel } from '../ui/panel';
import { StatusDot, type StatusTone } from '../ui/status-dot';
import { harnessLabel } from '../../lib/harness';
import type { WorkerRow, WorkerStatus } from '../../lib/api';

/**
 * Who is attached, what each one reported, and why the last poll took no work.
 *
 * Every line here is either a lease the Deployment holds or something the
 * worker said about itself. A worker's harness list is its own local probe, so
 * this panel says "reported" and states that provider access was not tested —
 * a logged-in harness is not a promise that a provider will accept a request.
 * Nothing infers that a queue cannot move from one worker's refusal, and
 * nothing here reads as "no workers" when the server could not be asked.
 */

/** Seconds matter for a 2-second poll, so this says them; `formatRelative` starts at "just now". */
function sinceWords(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/** A lease runs in seconds and renews on a 30s heartbeat, so it is counted in seconds until a couple of minutes out. */
function untilWords(at: number, now: number): string {
  const delta = at - now;
  if (delta <= 0) return 'now';
  return delta < 120_000 ? `${Math.round(delta / 1000)}s` : `${Math.floor(delta / 60_000)}m`;
}

/** Why the last claim took nothing, in the words an owner reads. Each describes THAT poll, not the whole queue. */
const REASON_WORDS: Record<NonNullable<WorkerRow['lastReason']>, string> = {
  claimed: 'took a run',
  no_work: 'nothing it could take',
  no_harness: 'no matching harness',
  at_limit: 'a limit was already held',
  lost_race: 'another worker took it first',
};

function offersWords(offers: WorkerRow['offers']): string {
  const authenticated = offers.filter((o) => o.authenticated).map((o) => harnessLabel(o.id));
  const rest = offers.filter((o) => !o.authenticated).map((o) => harnessLabel(o.id));
  if (offers.length === 0) return 'Reported no harnesses.';
  const reported = authenticated.length === 0
    ? `Reported none logged in${rest.length === 0 ? '' : `; reported present: ${rest.join(', ')}`}.`
    : `Reported authenticated: ${authenticated.join(', ')}.${rest.length === 0 ? '' : ` Reported not logged in: ${rest.join(', ')}.`}`;
  return `${reported} Provider access has not been tested by this check.`;
}

/** The one line that names a worker's state, and the tone that goes with it. */
function stateOf(worker: WorkerRow, now: number): { tone: StatusTone; line: string } {
  const name = worker.machineId ?? worker.credentialId;
  if (worker.busy !== null) {
    const task = worker.busy.task ?? 'a run';
    return { tone: 'sage', line: `${name} · Running ${task} for ${worker.busy.projectId} · Lease expires in ${untilWords(worker.busy.leaseExpiresAt, now)}` };
  }
  if (worker.lastSeenAt === 0) return { tone: 'outline', line: `${name} · No contact recorded` };
  if (!worker.recent) return { tone: 'outline', line: `${name} · Not seen recently · Last contact ${sinceWords(worker.lastSeenAt, now)}` };
  if (!worker.eligible) return { tone: 'terracotta', line: `${name} · Credential is no longer valid for new work · Last contact ${sinceWords(worker.lastSeenAt, now)}` };
  const ready = worker.offers.some((o) => o.authenticated);
  return {
    tone: ready ? 'sage' : 'terracotta',
    line: `${name} · ${ready ? 'Polling for work' : 'Polling, but reported no harness logged in'} · Last contact ${sinceWords(worker.lastSeenAt, now)}`,
  };
}

export function WorkersPanel({ workers, now = Date.now() }: { workers: WorkerStatus; now?: number }) {
  if (!workers.available) {
    return (
      <Panel padded title="Workers" tone="terra">
        <div className="flex items-center gap-2 font-sans text-sm text-on-surface">
          <StatusDot tone="terracotta" />
          Worker status unavailable — this server could not read its own database, so nothing here is known.
        </div>
      </Panel>
    );
  }

  const queued = workers.runsQueued;
  const queueLine = queued === 0 ? 'Nothing queued.' : `${queued} queued ${queued === 1 ? 'run' : 'runs'}.`;

  return (
    <Panel padded title="Workers">
      <p className="font-sans text-sm text-on-surface-variant">
        {queueLine} Workers attach from wherever their harnesses are logged in; what each reports below is its own check of its machine.
      </p>
      {workers.fleet.length === 0 ? (
        <p className="mt-2 font-sans text-sm text-on-surface-variant">
          No worker has been heard from. {queued > 0 ? 'Queued runs wait until one attaches.' : ''}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-3" aria-label="Workers">
          {workers.fleet.map((worker) => {
            const state = stateOf(worker, now);
            return (
              <li key={worker.credentialId} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 font-sans text-sm text-on-surface">
                  <StatusDot tone={state.tone} />
                  <span>{state.line}</span>
                </div>
                <p className="pl-5 font-sans text-xs text-on-surface-variant">{offersWords(worker.offers)}</p>
                {worker.busy === null && worker.lastReason !== null && worker.lastSeenAt > 0 && (
                  <p className="pl-5 font-sans text-xs text-on-surface-variant">
                    Last claim: {REASON_WORDS[worker.lastReason]} ({sinceWords(worker.lastSeenAt, now)}). That is what this worker's last poll found, not what every worker can run.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
