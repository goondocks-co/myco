import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agentHasStoredKey, harnessSignInFailureWords, RUNNER_PAYER_LABELS, runnerFallbackSince, runnerFallbackWords, storedKeyFailureWords, type RunnerCredentialChoice } from '@goondocks/myco-shared/runner-fleet';
import { agoWords, clockWords } from '@goondocks/myco-shared/time-words';
import { ActionLink, Button, CommandBlock, Dialog, DialogContent, DialogFooter, ErrorState, Switch } from '../../../design';
import { useAgentPayers, type AgentPayersAnswer } from '../../../hooks/use-fleet';
import { useIsAdmin } from '../../../hooks/use-me';
import { fetchJson, postJson, type RunnerRow } from '../../../lib/api';
import { harnessLabel } from '../../../lib/harness';
import { live } from '../../../lib/live';
import { runnerPath, RUNS_PATH, SETTINGS_SECTIONS } from '../../../routes/nav';
import type { RunHoursAnswer } from '../../runs/RunsPage';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import { refreshFleet } from '../runners/LegacyWorker';
import { taskWords } from '../workers';
import { PAYER_PHRASES, paymentOf } from './payment';
import { RunnerDetails } from './RunnerDetails';

const MODELS_AGENT = `${SETTINGS_SECTIONS.find((section) => section.id === 'models')!.to}#workers`;

/** Whether the machine runs Myco's work: its runner's switch, agent and payer, and last day of runs; else how to make it one. */
export function WorkPart({ runner, storedUsable, read }: {
  runner: RunnerRow | null;
  storedUsable: Readonly<Record<string, boolean>> | undefined;
  read: { settled: boolean; error: unknown; retry: () => void };
}) {
  return (
    <AdminSection id="work" title="Does it do Myco’s work?">
      {read.error != null && <ErrorState error={read.error} onRetry={read.retry}><p>Whether it runs Myco’s work couldn’t be read.</p></ErrorState>}
      <RowCard label="Does it do Myco’s work?">
        {runner !== null && runner.state !== 'removed' ? <RunnerRows runner={runner} storedUsable={storedUsable} />
          : read.settled && read.error == null ? <NotARunner removedAt={runner?.removedAt ?? null} />
          : <p className="px-s4 py-s4 t-small text-muted">{read.error == null ? 'Reading whether it runs Myco’s work…' : 'Unknown until the runners can be read.'}</p>}
      </RowCard>
    </AdminSection>
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

function RunnerRows({ runner, storedUsable }: { runner: RunnerRow; storedUsable: Readonly<Record<string, boolean>> | undefined }) {
  const admin = useIsAdmin();
  const client = useQueryClient();
  const payers = useAgentPayers(admin);
  const toggle = useMutation({
    mutationFn: (on: boolean) => postJson(`/api/runners/${encodeURIComponent(runner.id)}/${on ? 'resume' : 'pause'}`, {}),
    onSuccess: () => refreshFleet(client),
  });
  const on = runner.state === 'enabled';
  const waiting = (payers.data?.agents ?? []).flatMap((entry) => entry.waiting ?? []).filter((notice) => notice.runnerId === runner.id);
  return (
    <>
      <SettingRow
        inline
        setting="runner-enabled"
        label="Runs Myco’s work"
        htmlFor="runner-enabled"
        note={`It takes learning, titles and code maps when it’s online. Turning this off keeps it registered but gives it no new work${runner.busy !== null && !on ? '; the run it holds can finish' : ''}.`}
        status={toggle.isError ? `Not changed: ${toggle.error.message}` : admin ? undefined : 'An admin can turn this on or off.'}
        refused={toggle.isError}
        control={<Switch id="runner-enabled" aria-label="Runs Myco’s work" checked={on} disabled={!admin || toggle.isPending} onCheckedChange={(checked) => toggle.mutate(checked)} />}
      />
      <PaymentRow runner={runner} payers={payers.data} payersRead={{ admin, isError: payers.isError, error: payers.error, retry: () => void payers.refetch() }} storedUsable={storedUsable} />
      {(runner.fallbackNotices?.length ?? 0) + waiting.length > 0 || runner.offers?.some((offer) => harnessSignInFailureWords(offer) !== null) ? (
        <div className="flex flex-col gap-s2 px-s4 py-s4" data-runner-notices="">
          {runner.fallbackNotices?.map(({ agent, reason, slot, since }) => (
            <p key={agent} role={reason === 'out_of_credit' ? 'status' : 'alert'} className={reason === 'out_of_credit' ? 't-small text-ink-2' : 't-small text-bad'}>
              {harnessLabel(agent)} · Since {runnerFallbackSince(since)}. {runnerFallbackWords(reason, slot)}
            </p>
          ))}
          {waiting.map(({ agent, slot, failure }) => <p key={agent} role="alert" className="t-small text-bad">{harnessLabel(agent)} · {storedKeyFailureWords(failure, slot)}</p>)}
          {runner.offers?.map((offer) => { const failure = harnessSignInFailureWords(offer); return failure === null ? null : <p key={offer.id} className="t-small text-bad">{failure}</p>; })}
        </div>
      ) : null}
      <LastDay runner={runner} />
      <div className="px-s4 py-s3"><RunnerDetails runner={runner} /></div>
    </>
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
  const label = !payersRead.admin ? 'Its agent and who pays'
    : payment.state === 'unknown' ? (payers === undefined && !payersRead.isError ? 'Reading which agent it uses…' : 'Which agent it uses is unknown')
    : payment.state === 'no-agent' ? 'No agent on it can do this work now'
    : `With ${harnessLabel(payment.agent)}, paid by ${payment.choice === null ? 'a choice that needs making again' : PAYER_PHRASES[payment.choice]}`;
  const note = !payersRead.admin ? 'Which agent it uses and who pays are shown to an admin.'
    : payment.state !== 'set' ? (payersRead.isError ? 'The server couldn’t say which agent it uses.' : null)
    : sameAsEveryRunner(runner.id, payment.agent, payment.choice, payers);
  const ready = payment.state !== 'set' || payment.ready === null ? null
    : payment.ready ? (runner.connected ? 'It can use it now.' : 'It could use it when last seen.')
    : `It ${runner.connected ? 'can’t use it now' : 'couldn’t use it when last seen'}: ${payment.why}.`;
  return (
    <>
      <SettingRow
        setting="runner-payment"
        label={<span data-runner-payment="">{label}</span>}
        note={note === null && ready === null ? undefined : [note, ready].filter(Boolean).join(' ')}
        status={others.length === 0 ? undefined : `Also signed in on it${runner.connected ? '' : ' when last seen'}: ${listWords(others)}.`}
        details={payersRead.isError ? <ErrorState error={payersRead.error} onRetry={payersRead.retry} /> : undefined}
        control={payersRead.admin ? (
          <div className="flex flex-wrap items-center justify-end gap-s2">
            <ActionLink to={MODELS_AGENT}>Change for all runners</ActionLink>
            <Button size="sm" onClick={() => setApart(true)}>Set this machine apart</Button>
          </div>
        ) : <span />}
      />
      <SetApartDialog runner={runner} open={apart} onClose={() => setApart(false)} storedUsable={storedUsable} />
    </>
  );
}

/** "Claude Code", "Codex and Cursor", "Codex, Cursor and OpenCode". */
const listWords = (names: readonly string[]): string => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** Whether this runner pays the way every other runner offering the agent does, from the payers the server read. */
function sameAsEveryRunner(runnerId: string, agent: string, choice: RunnerCredentialChoice | null, payers: AgentPayersAnswer | undefined): string {
  const others = payers?.agents.find((entry) => entry.agent === agent)?.runners.filter((entry) => entry.id !== runnerId) ?? [];
  if (others.length === 0) return `It is the only runner with ${harnessLabel(agent)}, so Settings › Models sets this for it.`;
  if (others.every((entry) => entry.choice === choice)) return 'The same as every runner, from Settings › Models.';
  const theirs = new Set(others.map((entry) => entry.choice));
  const [one] = theirs;
  return theirs.size === 1 && one != null ? `Set apart for this machine: the other runners pay with ${PAYER_PHRASES[one]}.` : 'Set apart for this machine: the runners pay differently.';
}

/** Who pays for each agent on this machine alone: the three choices, one agent at a time. */
function SetApartDialog({ runner, open, onClose, storedUsable }: { runner: RunnerRow; open: boolean; onClose: () => void; storedUsable: Readonly<Record<string, boolean>> | undefined }) {
  const agents = [...new Set([...(runner.offers?.map((offer) => offer.id) ?? []), ...Object.keys(runner.credentialChoices ?? {})])];
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent title={`Set ${runner.name} apart`} description="Who pays for each agent on this machine alone. Changing it for all runners on Settings › Models sets this machine back to the same as every runner.">
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
  const counts = hours.isPending ? 'Counting its runs…'
    : hours.isError ? 'Its runs couldn’t be counted.'
    : total === 0 ? 'No runs finished on it in the last 24 hours.'
    : `${total.toLocaleString()} ${total === 1 ? 'run' : 'runs'}: ${sum('worked')} worked, ${sum('unchanged')} changed nothing, ${sum('failed')} failed${sum('interrupted') > 0 ? `, ${sum('interrupted')} interrupted` : ''}.`;
  const last = finished === undefined ? '' : ` Last finished ${Date.now() - finished.at < 86_400_000 ? clockWords(finished.at) : agoWords(finished.at)}, ${taskWords(finished.task)}${finished.projectName === null ? '' : ` for ${finished.projectName}`}.`;
  return (
    <SettingRow
      setting="runner-last-day"
      label="Last 24 hours"
      note={<span data-runner-last-day="">{`${counts}${last}`}</span>}
      status={hours.data?.counted === false ? 'Myco is still counting earlier runs, so this may read low.' : undefined}
      details={hours.isError ? <ErrorState error={hours.error} onRetry={() => void hours.refetch()} /> : undefined}
      control={<div className="flex flex-wrap items-center justify-end gap-s3">
        <ActionLink to={`${RUNS_PATH}?runner=${encodeURIComponent(runner.id)}`}>See its runs</ActionLink>
        <ActionLink to={runnerPath(runner.id)}>Its check-ins</ActionLink>
      </div>}
    />
  );
}
