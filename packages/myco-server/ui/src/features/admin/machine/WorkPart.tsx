import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agentHasStoredKey, harnessSignInFailureWords, RUNNER_PAYER_LABELS, runnerFallbackSince, runnerFallbackWords, storedKeyFailureWords, type RunnerCredentialChoice } from '@goondocks/myco-shared/runner-fleet';
import { agoWords, dateTimeWords } from '@goondocks/myco-shared/time-words';
import { ActionLink, Button, CommandBlock, Dialog, DialogContent, DialogFooter, ErrorState, StatusChip, Switch, type Tone } from '../../../design';
import { useAgentPayers, type AgentPayersAnswer } from '../../../hooks/use-fleet';
import { useIsAdmin } from '../../../hooks/use-me';
import { fetchJson, postJson, type RunnerRow, type WorkerRow } from '../../../lib/api';
import { harnessLabel } from '../../../lib/harness';
import { live } from '../../../lib/live';
import { runnerPath, RUNS_PATH, SETTINGS_SECTIONS } from '../../../routes/nav';
import type { RunHoursAnswer } from '../../runs/RunsPage';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import { LegacyWorker, refreshFleet } from '../runners/LegacyWorker';
import { taskWords } from '../workers';
import { PAYER_PHRASES, paymentOf } from './payment';
import { RemoveRunnerRow, RunnerMenu } from './RunnerControls';
import { RunnerDetails } from './RunnerDetails';

const DISPLAY_TONE: Readonly<Record<string, Tone>> = { Online: 'ok', Busy: 'ok', 'Not ready': 'warn' };

const MODELS_AGENT = `${SETTINGS_SECTIONS.find((section) => section.id === 'models')!.to}#workers`;

/**
 * Whether the machine runs Myco's work: one card per runner registration on it, each with its own id and every control
 * targeting that registration alone; any legacy worker on it with the way to move it to a runner; the registrations
 * removed from it; else that it runs none and the one command that makes it a runner.
 */
export function WorkPart({ runners, legacy, storedUsable, read, captureContinues }: {
  runners: readonly RunnerRow[];
  legacy: readonly WorkerRow[];
  storedUsable: Readonly<Record<string, boolean>> | undefined;
  read: { settled: boolean; error: unknown; retry: () => void };
  captureContinues: boolean;
}) {
  const live = runners.filter((runner) => runner.state !== 'removed');
  const removed = runners.filter((runner) => runner.state === 'removed');
  const known = read.settled && read.error == null;
  return (
    <AdminSection id="work" title="Does it do Myco’s work?">
      {read.error != null && <ErrorState error={read.error} onRetry={read.retry}><p>Which runners are on it couldn’t all be read.</p></ErrorState>}
      {live.map((runner) => <RunnerCard key={runner.id} runner={runner} storedUsable={storedUsable} captureContinues={captureContinues} />)}
      {legacy.length > 0 && <LegacyCard workers={legacy} />}
      {live.length === 0 && legacy.length === 0 && (
        <RowCard label="Does it do Myco’s work?">
          {known ? <NotARunner removedAt={removed.length === 0 ? null : Math.max(...removed.map((runner) => runner.removedAt ?? 0))} />
            : <p className="px-s4 py-s4 t-small text-muted">{read.error == null ? 'Reading whether it runs Myco’s work…' : 'Unknown until the runners can be read.'}</p>}
        </RowCard>
      )}
      {removed.length > 0 && (
        <RowCard label="Removed runner registrations">
          {removed.map((runner) => (
            <div key={runner.id} id={`runner-${runner.id}`} className="flex scroll-mt-s6 flex-col gap-s2 px-s4 py-s3 sm:flex-row sm:items-center sm:justify-between" data-removed-runner={runner.id}>
              <span className="t-small text-muted">{`${runner.name} was removed as a runner ${agoWords(runner.removedAt)}.`}</span>
              <ActionLink to={runnerPath(runner.id)}>{`${runner.name}’s check-ins`}</ActionLink>
            </div>
          ))}
        </RowCard>
      )}
    </AdminSection>
  );
}

/** A legacy worker on this machine: what it last did, and the way to move its work to a registered runner. */
function LegacyCard({ workers }: { workers: readonly WorkerRow[] }) {
  return (
    <RowCard label="As a legacy worker">
      <div className="flex flex-col gap-s3 px-s4 py-s4" data-legacy-on-machine="">
        <p className="t-body font-medium text-ink">It runs Myco’s work as a legacy worker, with no registered runner</p>
        {workers.map((worker) => <LegacyWorker key={worker.credentialId} worker={worker} name="Its legacy worker" />)}
        <CommandBlock caption="To move its work to a runner, run this on it, approve it, and once its current work finishes, uninstall the legacy worker:" command={`myco runner register ${window.location.origin}`} />
      </div>
    </RowCard>
  );
}

/** A machine that runs no Myco work: "No", or no longer, and the one command that makes it a runner. */
function NotARunner({ removedAt }: { removedAt: number | null }) {
  return (
    <SettingRow
      stacked
      label={removedAt === null ? 'No' : 'Not any more'}
      note={removedAt === null
        ? 'It only captures. To have it take learning, titles and code maps too, run this on it; it then appears under Where the work runs.'
        : `It was removed as a runner ${agoWords(removedAt)}. To have it take Myco’s work again, run this on it.`}
      control={<CommandBlock command={`myco runner register ${window.location.origin}`} className="w-full" />}
    />
  );
}

/** One runner registration: its name and state, its switch, agent and payer, notices, last day of runs, details and removal. */
function RunnerCard({ runner, storedUsable, captureContinues }: { runner: RunnerRow; storedUsable: Readonly<Record<string, boolean>> | undefined; captureContinues: boolean }) {
  const admin = useIsAdmin();
  const client = useQueryClient();
  const payers = useAgentPayers(admin);
  const toggle = useMutation({
    mutationFn: (on: boolean) => postJson(`/api/runners/${encodeURIComponent(runner.id)}/${on ? 'resume' : 'pause'}`, {}),
    onSuccess: () => refreshFleet(client),
  });
  const on = runner.state === 'enabled';
  const switchId = `runner-enabled-${runner.id}`;
  const waiting = (payers.data?.agents ?? []).flatMap((entry) => entry.waiting ?? []).filter((notice) => notice.runnerId === runner.id);
  // Every stored-key failure the fleet reports for it, whichever agent it uses today, and those the payers read adds.
  const failures = [...(runner.storedKeyFailures ?? []), ...waiting.filter((notice) => !runner.storedKeyFailures?.some((failure) => failure.agent === notice.agent))];
  const signIn = (runner.offers ?? []).map((offer) => harnessSignInFailureWords(offer)).filter((words): words is string => words !== null);
  return (
    <div id={`runner-${runner.id}`} className="scroll-mt-s6" data-runner-card={runner.id}>
      <RowCard label={runner.name}>
        <div className="flex flex-wrap items-center justify-between gap-s2 px-s4 py-s3">
          <div className="flex min-w-0 flex-wrap items-center gap-s2">
            <span className="t-body font-medium text-ink break-words">{runner.name}</span>
            <StatusChip tone={DISPLAY_TONE[runner.display] ?? 'neutral'}>{runner.display}</StatusChip>
          </div>
          {admin && <RunnerMenu runner={runner} />}
        </div>
        <SettingRow
          inline
          setting="runner-enabled"
          label={`${runner.name} runs Myco’s work`}
          htmlFor={switchId}
          note={`It takes learning, titles and code maps when it’s online. Turning this off keeps it registered but gives it no new work${runner.busy !== null && !on ? '; the run it holds can finish' : ''}.`}
          status={toggle.isError ? `Not changed: ${toggle.error.message}` : admin ? undefined : 'An admin can turn this on or off.'}
          refused={toggle.isError}
          control={<Switch id={switchId} aria-label={`${runner.name} runs Myco’s work`} checked={on} disabled={!admin || toggle.isPending} onCheckedChange={(checked) => toggle.mutate(checked)} />}
        />
        <PaymentRow runner={runner} payers={payers.data} payersRead={{ admin, isError: payers.isError, error: payers.error, retry: () => void payers.refetch() }} storedUsable={storedUsable} />
        {(runner.fallbackNotices?.length ?? 0) + failures.length + signIn.length > 0 && (
          <div className="flex flex-col gap-s2 px-s4 py-s4" data-runner-notices="">
            {runner.fallbackNotices?.map(({ agent, reason, slot, since }) => (
              <p key={agent} role={reason === 'out_of_credit' ? 'status' : 'alert'} className={reason === 'out_of_credit' ? 't-small text-ink-2' : 't-small text-bad'}>
                {harnessLabel(agent)} · Since {runnerFallbackSince(since)}. {runnerFallbackWords(reason, slot)}
              </p>
            ))}
            {failures.map(({ agent, slot, failure }) => <p key={agent} role="alert" className="t-small text-bad">{harnessLabel(agent)} · {storedKeyFailureWords(failure, slot)}</p>)}
            {signIn.map((words) => <p key={words} className="t-small text-bad">{words}</p>)}
          </div>
        )}
        <LastDay runner={runner} />
        <div className="px-s4 py-s3"><RunnerDetails runner={runner} /></div>
        {admin && <RemoveRunnerRow runner={runner} captureContinues={captureContinues} />}
      </RowCard>
    </div>
  );
}

/**
 * Which agent it uses and who pays, and whether that is the same as every runner (the choice on Settings › Models) or
 * set apart for this machine; its other signed-in agents in one line.
 */
function PaymentRow({ runner, payers, payersRead, storedUsable }: {
  runner: RunnerRow;
  payers: AgentPayersAnswer | undefined;
  payersRead: { admin: boolean; isError: boolean; error: unknown; retry: () => void };
  storedUsable: Readonly<Record<string, boolean>> | undefined;
}) {
  const [apart, setApart] = useState(false);
  const payment = paymentOf(runner, payers, storedUsable);
  const agent = payment.state === 'set' ? payment.agent : null;
  const others = (runner.offers ?? []).filter((offer) => offer.authenticated && offer.installed !== false && offer.id !== agent).map((offer) => harnessLabel(offer.id));
  const reported = runner.offersObservedAt == null ? 'by the sign-ins it reported' : `by the sign-ins it reported ${agoWords(runner.offersObservedAt)}`;
  const usesKey = payment.state === 'set' && payment.choice !== null && payment.choice !== 'own';
  const label = !payersRead.admin ? 'Its agent and who pays'
    : payment.state === 'unknown' ? (payers === undefined && !payersRead.isError ? 'Reading which agent it would use…' : 'Which agent it would use is unknown')
    : payment.state === 'no-agent' ? 'No agent on it could learn from sessions now'
    : `For learning from sessions: ${harnessLabel(payment.agent)}, paid by ${payment.choice === null ? 'a choice that needs making again' : PAYER_PHRASES[payment.choice]}`;
  const note = !payersRead.admin ? 'Which agent it would use and who pays are shown to an admin.'
    : payment.state !== 'set' ? (payersRead.isError ? 'The server couldn’t say which agent it would use.' : 'This is the server’s choice for learning from sessions; other work may use another agent.')
    : `The server’s choice for learning from sessions; other work may use another agent. ${agreementWords(runner.id, payment.agent, payment.choice, payers)}`;
  const ready = payment.state !== 'set' || payment.ready === null ? null
    : payment.ready ? `It could use it, ${reported}${usesKey ? ' and the stored key as it stands now' : ''}.`
    : `It couldn’t use it, ${reported}${usesKey ? ' and the stored key as it stands now' : ''}: ${payment.why}.`;
  return (
    <>
      <SettingRow
        setting="runner-payment"
        label={<span data-runner-payment="">{label}</span>}
        note={note === null && ready === null ? undefined : [note, ready].filter(Boolean).join(' ')}
        status={others.length === 0 ? undefined : `Also signed in, as it last reported: ${listWords(others)}.`}
        details={payersRead.isError ? <ErrorState error={payersRead.error} onRetry={payersRead.retry} /> : undefined}
        control={payersRead.admin ? (
          <div className="flex flex-wrap items-center justify-end gap-s2">
            <ActionLink to={MODELS_AGENT}>Change for all runners</ActionLink>
            <Button size="sm" onClick={() => setApart(true)}>{`Choose for ${runner.name} only`}</Button>
          </div>
        ) : <span />}
      />
      <SetApartDialog runner={runner} open={apart} onClose={() => setApart(false)} storedUsable={storedUsable} />
    </>
  );
}

/** "Claude Code", "Codex and Cursor", "Codex, Cursor and OpenCode". */
const listWords = (names: readonly string[]): string => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** Whether the other runners offering the agent are set to pay the same way, from the payers the server read; never where that came from. */
function agreementWords(runnerId: string, agent: string, choice: RunnerCredentialChoice | null, payers: AgentPayersAnswer | undefined): string {
  const others = payers?.agents.find((entry) => entry.agent === agent)?.runners.filter((entry) => entry.id !== runnerId) ?? [];
  if (others.length === 0) return `It is the only runner with ${harnessLabel(agent)}.`;
  if (others.every((entry) => entry.choice === choice)) return `Every runner with ${harnessLabel(agent)} is set to pay the same way.`;
  const theirs = new Set(others.map((entry) => entry.choice));
  const [one] = theirs;
  return theirs.size === 1 && one != null ? `The other runners with ${harnessLabel(agent)} pay with ${PAYER_PHRASES[one]}.` : `The runners with ${harnessLabel(agent)} pay in different ways.`;
}

/** Who pays for each agent on this runner alone: the three choices, one agent at a time. */
function SetApartDialog({ runner, open, onClose, storedUsable }: { runner: RunnerRow; open: boolean; onClose: () => void; storedUsable: Readonly<Record<string, boolean>> | undefined }) {
  const agents = [...new Set([...(runner.offers?.map((offer) => offer.id) ?? []), ...Object.keys(runner.credentialChoices ?? {})])];
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent title={`Who pays for ${runner.name}’s agents`} description={`Choose who pays for each agent on ${runner.name} only; each choice saves as you make it. Changing who pays for every runner, on Settings › Models, sets ${runner.name} back to match the rest.`}>
        <div className="flex flex-col">
          {agents.length === 0 && <p className="t-small text-muted">It reported no agents.</p>}
          {agents.map((agent) => <AgentSignIn key={agent} runner={runner} agent={agent} storedAvailable={storedUsable?.[agent] === true} />)}
        </div>
        <DialogFooter><Button variant="primary" onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentSignIn({ runner, agent, storedAvailable }: { runner: RunnerRow; agent: string; storedAvailable: boolean }) {
  const client = useQueryClient();
  const choices = runner.credentialChoices ?? {};
  const choice = Object.hasOwn(choices, agent) ? choices[agent] ?? null : 'own';
  const change = useMutation({
    mutationFn: (next: RunnerCredentialChoice) => postJson(`/api/runners/${encodeURIComponent(runner.id)}/sign-in`, { agent, choice: next }),
    onSuccess: () => refreshFleet(client),
  });
  return <div className="border-t border-line py-s3 t-small first:border-t-0" aria-label={`${harnessLabel(agent)} sign-in`}>
    <p>{harnessLabel(agent)} · {choice === null ? 'Choose who pays for this agent' : `Paid by ${PAYER_PHRASES[choice]}`}</p>
    <div className="mt-s2 flex flex-wrap items-center gap-s2">
      <Button size="sm" variant="secondary" disabled={choice === 'own' || change.isPending} onClick={() => change.mutate('own')}>Use this machine’s sign-in</Button>
      <Button size="sm" variant="secondary" disabled={!storedAvailable || choice === 'stored' || change.isPending} onClick={() => change.mutate('stored')}>Use the server’s stored key</Button>
      {agentHasStoredKey(agent) && <Button size="sm" variant="secondary" disabled={choice === 'stored-first' || change.isPending} onClick={() => change.mutate('stored-first')}>{RUNNER_PAYER_LABELS['stored-first']}</Button>}
      {choice !== 'stored-first' && !storedAvailable && !runner.storedKeyFailures?.some((failure) => failure.agent === agent) && <span className="text-muted">No stored key this agent can use.</span>}
    </div>
    {change.isError && <ErrorState error={change.error} onRetry={() => change.reset()} />}
  </div>;
}

/** Its runs in the last 24 hours, counted by how each ended, and the last one that finished, with a way to see them. */
function LastDay({ runner }: { runner: RunnerRow }) {
  const hours = useQuery({
    queryKey: ['runs', 'hours', 'day', null],
    queryFn: ({ signal }) => fetchJson<RunHoursAnswer>('/api/runs/hours?window=day', signal),
    ...live<RunHoursAnswer>({ follows: ['runs'] }),
  });
  const lane = hours.data?.lanes.find((entry) => entry.runnerId === runner.id);
  const sum = (key: 'worked' | 'unchanged' | 'failed' | 'interrupted') => (lane?.hours ?? []).reduce((total, hour) => total + (hour[key] ?? 0), 0);
  const total = sum('worked') + sum('unchanged') + sum('failed') + sum('interrupted');
  const finished = [runner.lastCompleted, runner.lastFailed].filter((run) => run !== null).sort((a, b) => b.at - a.at)[0];
  const window = hours.data?.window;
  const since = window === undefined ? null : `Since ${dateTimeWords(window.since)}`;
  const counting = hours.data?.counted === false;
  const counts = hours.isPending ? 'Counting its runs…'
    : hours.isError ? 'Its runs couldn’t be counted.'
    : total === 0 ? (counting ? `${since}, none counted yet; earlier runs are still being counted.` : `${since}, no runs finished on it.`)
    : `${since}: ${total.toLocaleString()} ${total === 1 ? 'run' : 'runs'}, ${sum('worked')} worked, ${sum('unchanged')} changed nothing, ${sum('failed')} failed${sum('interrupted') > 0 ? `, ${sum('interrupted')} interrupted` : ''}.`;
  const last = finished === undefined ? '' : ` The last that finished, ${taskWords(finished.task)}${finished.projectName === null ? '' : ` for ${finished.projectName}`}, finished ${agoWords(finished.at)}.`;
  return (
    <SettingRow
      setting="runner-last-day"
      label="Its recent runs"
      note={<span data-runner-last-day="">{`${counts}${last}`}</span>}
      status={counting && total > 0 ? 'Earlier runs are still being counted, so this may read low.' : undefined}
      details={hours.isError ? <ErrorState error={hours.error} onRetry={() => void hours.refetch()} /> : undefined}
      control={<div className="flex flex-wrap items-center justify-end gap-s3">
        <ActionLink to={`${RUNS_PATH}?runner=${encodeURIComponent(runner.id)}`}>See its runs</ActionLink>
        <ActionLink to={runnerPath(runner.id)}>{`${runner.name}’s check-ins`}</ActionLink>
      </div>}
    />
  );
}
