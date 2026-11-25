import type { FleetRun } from '@goondocks/myco-shared/runner-fleet';
import { isStoredKeyFailure } from '@goondocks/myco-shared/run-diagnostic';
import { agoWords } from '@goondocks/myco-shared/time-words';
import { Link } from 'react-router-dom';
import type { RunnerRow } from '../../../lib/api';
import { harnessLabel } from '../../../lib/harness';
import { runPath } from '../../../routes/nav';
import { REASON_WORDS, taskWords } from '../workers';

function RunFact({ label, run }: { label: string; run: FleetRun | null }) {
  if (run === null) return null;
  return <p><span className="text-ink-2">{label}: </span><Link className="underline underline-offset-2" to={runPath(run.projectId, run.runId)}>{taskWords(run.task)}{run.projectName === null ? '' : ` · ${run.projectName}`}</Link> · {agoWords(run.at)}</p>;
}

/** Everything else the runner reported and the server recorded of it, folded: its runs, agents, models, readiness and id. */
export function RunnerDetails({ runner }: { runner: RunnerRow }) {
  return (
    <details className="t-small text-muted" data-runner-details="">
      <summary className="min-h-tap content-center cursor-pointer text-ink-2">Details</summary>
      <div className="mt-s3 flex flex-col gap-s2 break-words">
        {runner.busy === null && runner.lastAttempted === null && runner.lastCompleted === null && runner.lastFailed === null ? <p>No runs yet.</p> : <>
          <RunFact label="Last completed" run={runner.lastCompleted} />
          <RunFact label="Last failed" run={runner.lastFailed} />
          <RunFact label="Last attempted" run={runner.lastAttempted} />
        </>}
        {runner.busy && <><RunFact label="Current task" run={runner.busy} /><p>Assignment valid until {new Date(runner.busy.leaseExpiresAt).toLocaleString()}.</p></>}
        {runner.offers === null ? <p>Agent sign-in status unavailable.</p> : runner.offers.length === 0 ? <p>No agents reported.</p> : <div>{runner.offers.map((offer) => <p key={offer.id}>{harnessLabel(offer.id)} · {offer.installed === false ? 'Not installed' : offer.authenticated ? 'Signed in' : 'Signed out'}{offer.profile && ` · ${offer.profile.model === 'none' ? 'Default model' : 'Model selection available'} · effort choices: ${offer.profile.efforts.join(', ') || 'none reported'}`}</p>)}<span title="A listed model does not confirm provider access or quota." aria-label="Provider access information">ⓘ</span></div>}
        {runner.models?.map((model) => <p key={model.harness}>{harnessLabel(model.harness)} models: {model.available ? model.source ?? 'source unavailable' : 'listing unavailable'} · listed {agoWords(model.fetchedAt)} · received {agoWords(model.receivedAt)} · {model.fresh ? 'recent listing' : 'stale listing'}</p>)}
        {(runner.capabilities?.length || runner.labels?.length || runner.preference) && <p>{runner.capabilities?.length ? `Capabilities: ${runner.capabilities.join(', ')}. ` : ''}{runner.labels?.length ? `Labels: ${runner.labels.join(', ')}. ` : ''}{runner.preference ? `Preference: ${runner.preference}.` : ''}</p>}
        {runner.lastReason !== null && runner.lastReason in REASON_WORDS && <p>Last check for work: {REASON_WORDS[runner.lastReason as keyof typeof REASON_WORDS]}.</p>}
        {runner.display === 'Not ready' && !isStoredKeyFailure(runner.readiness.code) && <p>Readiness: {runner.readiness.reason}</p>}
        {runner.offers !== null && runner.offersObservedAt != null && <p>Agent status reported {agoWords(runner.offersObservedAt)}.</p>}
        {runner.lastSeenAt !== null && <p>Last checked in {agoWords(runner.lastSeenAt)}.</p>}
        <p>Runner ID: <code>{runner.id}</code></p>
      </div>
    </details>
  );
}
