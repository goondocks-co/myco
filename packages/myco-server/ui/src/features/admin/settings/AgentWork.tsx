import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';
import { agentHasStoredKey, isRunnerCredentialChoice, QUEUE_REASON_WORDS, RUNNER_CREDENTIAL_CHOICES, RUNNER_PAYER_LABELS, RUNNER_SIGN_IN_WORDS, runnerFallbackSince, runnerFallbackWords, type RunnerCredentialChoice, type RunnerSignInSource } from '@goondocks/myco-shared/runner-fleet';
import { agoWords } from '@goondocks/myco-shared/time-words';
import { Button, ErrorState, Select } from '../../../design';
import { useAgentPayers, type AgentPayersAnswer } from '../../../hooks/use-fleet';
import { useIsAdmin } from '../../../hooks/use-me';
import { settingsRefusalText, useSecrets, useSettingsActions } from '../../../hooks/use-settings';
import { ApiError, fetchJson, postJson } from '../../../lib/api';
import { harnessLabel } from '../../../lib/harness';
import { refreshFleet } from '../runners/LegacyWorker';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import { keyKindWords } from './Credentials';
import { KeyDialog, keyLabel } from './KeyDialog';
import type { LeafGroup } from './catalogue';
import type { LeafRow } from './wire';

/** The agent choice's value while no agent is chosen. */
const NO_PREFERENCE = '__none__';

/** `GET /api/runners/check`, as the server answers it. */
interface AgentWorkCheck { task: string; observedAt: number; reason: keyof typeof QUEUE_REASON_WORDS | 'budget'; takers: Array<{ agent: string; runners: Array<{ id: string; name: string | null; payer?: RunnerSignInSource }> }> }

const HOLD_WORDS: Readonly<Record<AgentWorkCheck['reason'], string>> = {
  ...QUEUE_REASON_WORDS,
  budget: 'Today’s work budget is used up; automatic work waits until spending over the last day falls below it. Work started by hand still runs.',
};

/** The answer of a check in one sentence: which runner would take the work, or the one thing in the way. */
export function checkWords(check: AgentWorkCheck): string {
  if (check.takers.length === 0) return `Not now. ${HOLD_WORDS[check.reason]}`;
  const names = check.takers.flatMap((taker) => taker.runners.map((runner) => (runner.name ?? 'a legacy worker') + (runner.payer === undefined ? '' : ` using ${RUNNER_SIGN_IN_WORDS[runner.payer]}`)));
  const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} or ${names.at(-1)!}`;
  const agents = [...new Set(check.takers.map((taker) => harnessLabel(taker.agent)))].join(' or ');
  const hold = HOLD_WORDS[check.reason];
  return check.reason === 'ready' ? `Ready: ${who} would take it now, with ${agents}.` : `Not now: ${who} could take it with ${agents}, but ${hold.charAt(0).toLowerCase()}${hold.slice(1)}`;
}

/** Which agent each runner uses today, in one sentence. */
const todayWords = (today: AgentPayersAnswer['today']): string =>
  today.length === 0 ? '' : ` Today: ${today.map((runner) => `${runner.name} uses ${runner.agent === null ? 'no agent it is signed in to' : harnessLabel(runner.agent)}`).join('; ')}.`;

/** The help under the agent choice: what runs next after the chosen agent, or, with none chosen, how a runner picks; then what each uses today. */
function agentNote(preferred: string | null, next: readonly string[], today: AgentPayersAnswer['today']): string {
  const lead = preferred !== null
    ? (next.length === 0 ? 'No other agent is tried.' : `Then ${next.map(harnessLabel).join(', then ')}, where a runner is not signed in to it.`)
    : `No agent chosen: each runner uses ${next.length === 0 ? 'the first agent it is signed in to' : `the first of ${next.map(harnessLabel).join(', then ')} it is signed in to`}.`;
  return `${lead}${todayWords(today)}`;
}

const CHOICE_WORDS: Readonly<Record<RunnerCredentialChoice, string>> = { own: 'its own sign-in', stored: 'the stored key', 'stored-first': RUNNER_PAYER_LABELS['stored-first'] };

/** Why the server refused to change who pays, in plain words. */
function signInRefusal(error: unknown, agent: string): string {
  const code = error instanceof ApiError ? (error.body as { error?: unknown } | null)?.error : undefined;
  if (code === 'credential_unavailable') return `Nothing was saved: no usable key is stored for ${harnessLabel(agent)}.`;
  if (code === 'conflict') return 'Nothing was saved: a runner changed while you chose. Choose again.';
  return settingsRefusalText(error);
}

/**
 * Work that needs an agent, in three steps: which agent runners try first, who pays for it, and whether a run could
 * start now. The agents offered and each runner's payment come from every registered runner, as the server reads them.
 */
export function AgentWork({ group, rows }: { group: LeafGroup; rows: ReadonlyMap<string, LeafRow> }) {
  const admin = useIsAdmin();
  const payers = useAgentPayers();
  const actions = useSettingsActions();
  const [error, setError] = useState<string | null>(null);
  const stored = rows.get('worker.harness')?.effective;
  const preferred = typeof stored === 'string' && stored !== '' ? stored : null;
  const fallback = rows.get('worker.harness_fallback')?.effective;
  const next = (Array.isArray(fallback) ? fallback : []).filter((item): item is string => typeof item === 'string' && item !== preferred);
  const offered = (payers.data?.agents ?? []).map((entry) => entry.agent);
  const today = payers.data?.today ?? [];
  const options = [
    { value: NO_PREFERENCE, label: 'No preference' },
    ...offered.map((id) => ({ value: id, label: harnessLabel(id) })),
    ...(preferred !== null && !offered.includes(preferred) ? [{ value: preferred, label: `${harnessLabel(preferred)} (no runner offers it)` }] : []),
  ];
  // With no agent chosen, who pays is set for the agent runners use today, and the row says so.
  const payingFor = preferred ?? today.find((runner) => runner.agent !== null)?.agent ?? null;

  const save = (value: string) => {
    setError(null);
    actions.setLeaf.mutate({ leaf: 'worker.harness', value: value === NO_PREFERENCE ? null : value }, { onError: (failure) => setError(settingsRefusalText(failure)) });
  };

  return (
    <AdminSection id={group.id} title="Work that needs an agent" description="Learning from sessions, code maps and tidying knowledge. A coding agent on one of your runners does this.">
      {payers.isError && <ErrorState error={payers.error} onRetry={() => void payers.refetch()} />}
      <RowCard label="Work that needs an agent">
        <SettingRow
          setting="worker.harness"
          label="1 · Agent"
          htmlFor="agent-work-agent"
          note={<span data-agent-note="">{agentNote(preferred, next, today)}</span>}
          status={error ?? (payers.isSuccess && offered.length === 0 ? 'No runner offers an agent yet. Add a runner under Myco’s work → Runners.' : undefined)}
          refused={error !== null}
          control={<Select id="agent-work-agent" label="Agent" value={preferred ?? NO_PREFERENCE} disabled={!admin || actions.setLeaf.isPending} options={options} onValueChange={save} />}
        />
        {payingFor !== null && payers.data !== undefined && (
          <PaidBy agent={payingFor} chosen={preferred !== null} entry={payers.data.agents.find((entry) => entry.agent === payingFor)} />
        )}
        <CheckRow />
      </RowCard>
    </AdminSection>
  );
}

/**
 * Who pays for an agent's work: one choice the server sets on every registered runner that offers the agent, all or
 * nothing, with one line per runner on what it uses now. A stored key with none usable saves nothing and offers to add one.
 */
function PaidBy({ agent, chosen, entry }: { agent: string; chosen: boolean; entry: AgentPayersAnswer['agents'][number] | undefined }) {
  const admin = useIsAdmin();
  const client = useQueryClient();
  const secrets = useSecrets();
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [adding, setAdding] = useState(false);
  const slot = HARNESS_CREDENTIALS[agent]?.slot ?? null;
  const runners = entry?.runners ?? [];
  const choices = runners.map((runner) => runner.choice);
  const value = choices.length === 0 ? 'own' : choices.every((choice) => choice === choices[0]) && choices[0] !== null ? choices[0]! : '';
  const set = useMutation({
    mutationFn: (choice: RunnerCredentialChoice) => postJson('/api/runners/sign-in', { agent, choice }),
    onSettled: () => refreshFleet(client),
  });
  const choose = (choice: string) => {
    setError(null);
    setMissing(false);
    if (choice === 'stored' && entry?.storedUsable !== true) { setMissing(true); return; }
    if (!isRunnerCredentialChoice(choice)) return;
    set.mutate(choice, { onError: (failure) => setError(signInRefusal(failure, agent)) });
  };
  const secret = slot === null ? undefined : secrets.data?.secrets.find((row) => row.name === slot);
  const kind = slot === null || secret === undefined ? null : keyKindWords(slot, secret.kind);
  const label = harnessLabel(agent);
  const lead = chosen ? '' : `For ${label}, the agent your runners use today. `;
  const payerNote = value === 'stored'
    ? `${slot === null ? 'A stored key' : `${keyLabel(slot)}${secret?.maskedValue == null ? '' : ` ${secret.maskedValue}`}`}, billed to that account. If it stops working, the work waits; it never falls back to a runner’s own sign-in.`
    : value === 'stored-first' ? 'The runner uses a stored key when it works and its own sign-in while the key is unavailable.'
    : value === 'own' ? `Each runner pays with its own sign-in to ${label}.` : 'Runners differ. Choose one to set it on every runner.';
  return (
    <>
      <SettingRow
        stacked
        setting="paid-by"
        label="2 · Paid by"
        htmlFor="agent-work-payer"
        note={<>
          <span>{`${lead}${payerNote}`}</span>
          {(value === 'stored' || value === 'stored-first') && kind !== null && <span className="mt-s1 block" data-key-kind={secret?.kind}>{kind}</span>}
        </>}
        status={error ?? undefined}
        refused={error !== null}
        details={<>
          {entry?.fallbacks?.map(({ runnerId, slot, reason, since }) => <p key={runnerId}
            role={reason === 'out_of_credit' ? 'status' : 'alert'} className={reason === 'out_of_credit' ? 't-small text-ink-2' : 't-small text-bad'}>
            {runners.find(runner => runner.id === runnerId)?.name} · Since {runnerFallbackSince(since)}. {runnerFallbackWords(reason, slot)}
          </p>)}
          {missing && (
            <div role="alert" className="flex flex-wrap items-center gap-s2 t-small text-bad" data-paid-by-missing="">
              <span>{slot === null ? `${label} can’t use a stored key; nothing was saved.` : `No usable key is stored for ${label}, so nothing was saved.`}</span>
              {slot !== null && admin && <Button size="sm" onClick={() => setAdding(true)}>{secret?.configured === true ? 'Replace the key' : 'Add the key'}</Button>}
            </div>
          )}
          <ul className="flex flex-col gap-s1 t-meta text-faint" aria-label={`What each runner uses for ${label}`}>
            {runners.length === 0 && <li>No runner offers {label} yet.</li>}
            {runners.map((runner) => <li key={runner.id} data-runner-payer={runner.choice ?? 'unset'}>{`${runner.name}: ${runner.choice === null ? 'needs choosing again' : CHOICE_WORDS[runner.choice]}`}</li>)}
          </ul>
        </>}
        control={(
          <Select
            id="agent-work-payer"
            label="Paid by"
            wrap
            className="max-w-measure"
            value={value}
            placeholder="Differs by runner"
            disabled={!admin || set.isPending || runners.length === 0}
            options={RUNNER_CREDENTIAL_CHOICES.filter(choice => choice !== 'stored-first' || agentHasStoredKey(agent))
              .map(choice => ({ value: choice, label: RUNNER_PAYER_LABELS[choice] }))}
            onValueChange={choose}
          />
        )}
      />
      <KeyDialog name={adding && slot !== null ? slot : null} replacing={secret?.configured === true} onClose={() => { setAdding(false); setMissing(false); }} />
    </>
  );
}

/** Asks the server whether a run could start now with these choices, and says the answer in one sentence. Starts nothing. */
function CheckRow() {
  const check = useMutation({ mutationFn: () => fetchJson<AgentWorkCheck>('/api/runners/check') });
  return (
    <SettingRow
      setting="agent-work-check"
      label="3 · Check"
      note="Asks whether learning from sessions could start now with these choices. Nothing runs and nothing is spent."
      status={check.isError ? settingsRefusalText(check.error) : check.data === undefined ? undefined : `${checkWords(check.data)} Checked ${agoWords(check.data.observedAt, Date.now())}.`}
      refused={check.isError}
      control={<Button size="sm" pending={check.isPending} onClick={() => check.mutate()}>Check now</Button>}
    />
  );
}
