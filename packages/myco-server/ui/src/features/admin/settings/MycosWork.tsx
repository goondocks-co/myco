import { useState } from 'react';
import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';
import { BUDGET_DEFAULT_USD, type BudgetStatus } from '@goondocks/myco-shared/budget-status';
import type { RunnerFleetRecord } from '@goondocks/myco-shared/runner-fleet';
import { agoWords, dayWords } from '@goondocks/myco-shared/time-words';
import { ActionLink, Button, CommandBlock, ErrorState, Input, LoadingState, StatusChip, Switch, type Tone } from '../../../design';
import { useAgentPayers, useFleet, type AgentPayersAnswer } from '../../../hooks/use-fleet';
import { permissionOf, useMe } from '../../../hooks/use-me';
import { settingsRefusalText, useSettingsActions } from '../../../hooks/use-settings';
import { useStatus } from '../../../hooks/use-status';
import { harnessLabel } from '../../../lib/harness';
import { runnerPath } from '../../../routes/nav';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import { useMemberNames } from '../members';
import { taskWords } from '../workers';
import { keyLabel } from './KeyDialog';
import type { LeafRow } from './wire';

const SCHEDULE_LEAF = 'agent.scheduled_tasks_enabled';
const BUDGET_LEAF = 'agent.budget.daily_usd';

/** Who last changed a setting and on what day, "you" for the viewer; or that it is the default. */
export function changeNote(row: LeafRow | undefined, name: string | null, viewerId: string | null, now: number = Date.now()): string {
  if (row === undefined || !row.configured) return 'Default';
  const who = row.updatedBy !== null && row.updatedBy === viewerId ? 'you' : name;
  const day = row.updatedAt === null ? '' : ` on ${dayWords(row.updatedAt, now)}`;
  return who === null ? `Changed${day}` : `Changed by ${who}${day}`;
}

const usd = (value: number): string => `$${Number.isInteger(value) ? value : value.toFixed(2)}`;

/** What automatic and hand-started work spent in the last 24 hours, or why that is not known yet. */
function spentWords(budget: BudgetStatus | undefined): string | null {
  if (budget === undefined) return null;
  if (budget.state === 'building' || budget.automaticUsd === null) return 'Measuring what was spent in the last 24 hours';
  return `$${(budget.automaticUsd + (budget.manualUsd ?? 0)).toFixed(2)} spent in the last 24 hours`;
}

/**
 * "Should Myco work on its own?": the switch that lets Myco work unasked, and the most it may spend on its own in a
 * day, each saying who changed it and when, the budget with what was spent in the last 24 hours.
 */
function WorkOnItsOwn({ rows }: { rows: ReadonlyMap<string, LeafRow> }) {
  const me = useMe();
  const permission = permissionOf(me.data, 'settings');
  const viewerId = me.data?.member?.id ?? null;
  const nameOf = useMemberNames();
  const actions = useSettingsActions();
  const status = useStatus();
  const [error, setError] = useState<{ leaf: string; words: string } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const schedule = rows.get(SCHEDULE_LEAF);
  const budget = rows.get(BUDGET_LEAF);
  const on = schedule?.effective === true;
  const pending = actions.setLeaf.isPending || actions.resetLeaf.isPending;
  const locked = !permission.allowed || pending;
  const refused = (leaf: string) => (failure: unknown) => setError({ leaf, words: settingsRefusalText(failure) });
  const save = (leaf: string, value: unknown) => {
    setError(null);
    actions.setLeaf.mutate({ leaf, value, revision: Number(rows.get(leaf)?.revision) }, { onError: refused(leaf), onSuccess: () => setDraft(null) });
  };
  const amount = typeof budget?.effective === 'number' ? budget.effective : null;
  const commitBudget = () => {
    if (draft === null) return;
    const next = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(next) || next < 1) { setError({ leaf: BUDGET_LEAF, words: 'Enter an amount of at least $1.' }); return; }
    if (next === amount) { setDraft(null); return; }
    save(BUDGET_LEAF, next);
  };
  const useDefault = () => {
    setError(null);
    actions.resetLeaf.mutate({ leaf: BUDGET_LEAF, revision: Number(budget?.revision) }, { onError: refused(BUDGET_LEAF), onSuccess: () => setDraft(null) });
  };
  const spent = spentWords(status.data?.budget);
  const note = (row: LeafRow | undefined) => changeNote(row, row?.configured === true ? nameOf(row.updatedBy) : null, viewerId);

  return (
    <AdminSection id="scheduling" title="Should Myco work on its own?">
      <RowCard label="Should Myco work on its own?">
        <SettingRow
          inline
          setting={SCHEDULE_LEAF}
          label="Work on its own"
          htmlFor="work-on-its-own"
          note={on
            ? 'Myco learns from finished sessions, writes their titles and keeps code maps current, without being asked.'
            : 'Myco does nothing until you start it by hand from Myco’s work.'}
          status={error?.leaf === SCHEDULE_LEAF ? error.words : [note(schedule), permission.allowed ? null : permission.reason].filter(Boolean).join(' · ')}
          refused={error?.leaf === SCHEDULE_LEAF}
          control={<Switch id="work-on-its-own" aria-label="Work on its own" checked={on} disabled={locked || schedule === undefined} onCheckedChange={(checked) => save(SCHEDULE_LEAF, checked)} />}
        />
        <SettingRow
          setting={BUDGET_LEAF}
          label="Daily budget"
          htmlFor="daily-budget"
          note="The most Myco spends on its own in a day. When it’s reached, Myco waits until spending from the last 24 hours makes room. Work you start by hand is never blocked, and its spend counts."
          status={error?.leaf === BUDGET_LEAF ? error.words : [note(budget), spent].filter(Boolean).join(' · ')}
          refused={error?.leaf === BUDGET_LEAF}
          control={<div className="flex w-full flex-wrap items-center justify-end gap-s2">
            <span className="t-body text-muted">$</span>
            <Input
              id="daily-budget"
              aria-label="Daily budget in dollars"
              type="number"
              inputMode="decimal"
              className="min-w-0 flex-1"
              min={1}
              step={0.01}
              value={draft ?? (amount === null ? '' : String(amount))}
              readOnly={locked}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitBudget}
              onKeyDown={(event) => { if (event.key === 'Enter') commitBudget(); }}
            />
            {budget?.configured === true && permission.allowed && (
              <Button size="sm" disabled={pending} onClick={useDefault}>{`Use default (${usd(BUDGET_DEFAULT_USD)})`}</Button>
            )}
          </div>}
        />
      </RowCard>
    </AdminSection>
  );
}

const DISPLAY_TONE: Readonly<Record<string, Tone>> = { Online: 'ok', Busy: 'ok', 'Not ready': 'warn' };

/** What a runner last ran and when, or what it is running now. */
function lastRanWords(runner: RunnerFleetRecord, now: number): string {
  if (runner.busy !== null) return `Running ${taskWords(runner.busy.task)} now`;
  if (runner.lastCompleted !== null) return `Last ran ${taskWords(runner.lastCompleted.task)} ${agoWords(runner.lastCompleted.at, now)}`;
  return 'Has not run anything yet';
}

/** How a runner pays for the agent it uses today: its own sign-in, or a key this server stores. */
export function paysWords(runnerId: string, payers: AgentPayersAnswer | undefined): string | null {
  if (payers === undefined) return null;
  const today = payers.today.find((entry) => entry.id === runnerId);
  if (today === undefined) return null;
  if (today.agent === null) return 'not signed in to an agent it can use';
  const choice = payers.agents.find((entry) => entry.agent === today.agent)?.runners.find((runner) => runner.id === runnerId)?.choice ?? null;
  const agent = harnessLabel(today.agent);
  if (choice === 'stored') {
    const slot = HARNESS_CREDENTIALS[today.agent]?.slot ?? null;
    return `pays for ${agent} with the stored ${slot === null ? 'key' : keyLabel(slot)}`;
  }
  return choice === 'own' ? `pays with its own ${agent} sign-in` : `uses ${agent}; who pays needs choosing again`;
}

/** "Where the work runs": one row per registered runner, and how to add another. */
function WhereWorkRuns() {
  const fleet = useFleet();
  const payers = useAgentPayers();
  const [adding, setAdding] = useState(false);
  const now = Date.now();
  const runners = (fleet.data?.runners ?? []).filter((runner) => runner.state !== 'removed');
  const origin = window.location.origin;
  return (
    <AdminSection id="runners" title="Where the work runs">
      {fleet.isError && <ErrorState error={fleet.error} onRetry={() => void fleet.refetch()} />}
      <RowCard label="Where the work runs">
        {fleet.isPending && <LoadingState label="Reading the runners" count={2} />}
        {runners.map((runner) => {
          const pays = paysWords(runner.id, payers.data);
          return (
            <div key={runner.id} className="flex flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-start sm:justify-between sm:gap-s6" data-runner-row={runner.id}>
              <div className="flex min-w-0 flex-col gap-s1">
                <span className="t-body font-medium text-ink break-words">{runner.name}</span>
                <span className="t-small text-muted">{[lastRanWords(runner, now), pays].filter(Boolean).join(' · ')}</span>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-s2">
                <StatusChip tone={DISPLAY_TONE[runner.display] ?? 'neutral'}>{runner.display}</StatusChip>
                <ActionLink to={runnerPath(runner.id)}>Manage</ActionLink>
              </div>
            </div>
          );
        })}
        <div className="flex flex-col gap-s3 px-s4 py-s4">
          <div className="flex flex-col gap-s3 sm:flex-row sm:items-center sm:justify-between sm:gap-s6">
            <p className="max-w-measure t-small text-muted">
              {fleet.isSuccess && runners.length === 0 ? 'No machine runs Myco’s work yet. ' : ''}
              A runner is a machine you’ve chosen to do Myco’s work, with a coding agent signed in on it.
            </p>
            <Button className="shrink-0" onClick={() => setAdding(!adding)} aria-expanded={adding}>Add a runner</Button>
          </div>
          {adding && <div className="flex flex-col gap-s2" data-add-runner="">
            <CommandBlock caption="On the machine you want to use, run this, then approve it from the link it shows:" command={`myco runner register ${origin}`} />
            <CommandBlock caption="Then start it at login:" command="myco runner install" />
          </div>}
        </div>
      </RowCard>
    </AdminSection>
  );
}

/** Myco's work, the page Settings opens on: whether Myco works unasked and within what budget, and where it works. */
export function MycosWork({ rows }: { rows: ReadonlyMap<string, LeafRow> }) {
  return (
    <>
      <WorkOnItsOwn rows={rows} />
      <WhereWorkRuns />
    </>
  );
}
