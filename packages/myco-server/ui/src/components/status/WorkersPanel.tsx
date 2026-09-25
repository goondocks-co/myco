import { Panel } from '../ui/panel';
import { StatusDot } from '../ui/status-dot';
import { fleetHeadline, offersWords, REASON_WORDS, workerState } from '../../lib/worker-state';
import { AttachHint } from './AttachHint';
import type { WorkerStatus } from '../../lib/api';

/**
 * Who is attached, what each one reported, and why the last poll took no work.
 *
 * Every line is a lease the Deployment holds or something the worker said about
 * itself, in the wording `lib/worker-state` defines. One worker's refusal is not
 * a verdict on the queue, and a server that could not be asked does not read as
 * no workers.
 */
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

  const headline = fleetHeadline(workers, now);

  return (
    <Panel padded title="Workers" tone={headline.tone === 'terracotta' ? 'terra' : 'sage'}>
      <div className="flex items-center gap-2 font-sans text-sm text-on-surface">
        <StatusDot tone={headline.tone} />
        <span>{headline.line}</span>
      </div>
      <p className="mt-1 font-sans text-sm text-on-surface-variant">
        {headline.attached === 0 && <><AttachHint />{' '}</>}Workers attach from wherever their harnesses are logged in; what each reports below is its own check of its machine.
      </p>
      {workers.fleet.length === 0 ? null : (
        <ul className="mt-2 flex flex-col gap-3" aria-label="Workers">
          {workers.fleet.map((worker) => {
            const state = workerState(worker, now);
            return (
              <li key={worker.credentialId} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 font-sans text-sm text-on-surface">
                  <StatusDot tone={state.tone} />
                  <span>{state.line}</span>
                </div>
                <p className="pl-5 font-sans text-xs text-on-surface-variant">{offersWords(worker)}</p>
                {worker.busy === null && worker.lastReason !== null && worker.lastSeenAt > 0 && (
                  <p className="pl-5 font-sans text-xs text-on-surface-variant">
                    Last claim: {REASON_WORDS[worker.lastReason]}. That is what this worker's last poll found, not what every worker can run.
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
