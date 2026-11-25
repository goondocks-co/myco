import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { BUDGET_DEFAULT_USD, type BudgetStatus } from '@goondocks/myco-shared/budget-status';
import { runnerAgentLoginReady, runnerFallbackWords, storedKeyFailureTitle, type FleetRun, type RunnerFleetRecord } from '@goondocks/myco-shared/runner-fleet';
import { agoWords, dayWords } from '@goondocks/myco-shared/time-words';
import { ActionLink, Button, CommandBlock, ErrorState, Input, LoadingState, ShowMore, StatusChip, Switch, type Tone } from '../../../design';
import { RUNNERS_KEY, useAgentPayers, type AgentPayersAnswer, type FleetAnswer } from '../../../hooks/use-fleet';
import { permissionOf, useMe } from '../../../hooks/use-me';
import { isSettingsConflict, settingsRefusalText, useSettingsActions } from '../../../hooks/use-settings';
import { useStatus } from '../../../hooks/use-status';
import { fetchJson } from '../../../lib/api';
import { harnessLabel } from '../../../lib/harness';
import { live } from '../../../lib/live';
import { runnerPath } from '../../../routes/nav';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import { useMemberNames } from '../members';
import { taskWords } from '../workers';
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

/**
 * What counts against the budget in the trailing day, as the server's admission accounting holds it: settled spend
 * and estimates for runs still going or with no reported cost. Each state the read can be in says so.
 */
export function budgetCountWords(read: { isPending: boolean; isError: boolean }, budget: BudgetStatus | undefined): string {
  if (read.isPending) return 'Reading what counts against the budget';
  if (read.isError) return 'Couldn’t read what counts against the budget';
  if (budget === undefined) return 'What counts against the budget is unavailable on this server';
  if (!budget.active) return `The budget is not applied: ${budget.reason ?? 'no reason given'}`;
  if (budget.state === 'building' || budget.automaticUsd === null) return 'Still measuring what counts against the budget';
  return `$${(budget.automaticUsd + (budget.manualUsd ?? 0)).toFixed(2)} counts against it now: what was spent in the last 24 hours, plus estimates for runs still going or not yet priced`;
}

/** A value being typed, with the revision of the setting it started from: a save carries that revision, never a newer one. */
interface Draft { value: string; revision: number | undefined }

const revisionOf = (row: LeafRow | undefined): number | undefined => (row === undefined ? undefined : Number(row.revision));
/** Whether the server could say what a setting is: a row it answered for, in a known state. */
const known = (row: LeafRow | undefined): row is LeafRow => row !== undefined && row.state !== 'unknown';

/**
 * "Should Myco work on its own?": the switch that lets Myco work unasked, and the most it may spend on its own in a
 * day, each saying who changed it and when, with a way back to the default; the budget with what counts against it.
 */
function WorkOnItsOwn({ rows }: { rows: ReadonlyMap<string, LeafRow> }) {
  const me = useMe();
  const permission = permissionOf(me.data, 'settings');
  const viewerId = me.data?.member?.id ?? null;
  const nameOf = useMemberNames();
  const actions = useSettingsActions();
  const status = useStatus();
  const [error, setError] = useState<{ leaf: string; words: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const schedule = rows.get(SCHEDULE_LEAF);
  const budget = rows.get(BUDGET_LEAF);
  const pending = actions.setLeaf.isPending || actions.resetLeaf.isPending;
  const admin = permission.allowed;
  const refused = (leaf: string) => (failure: unknown) => {
    if (isSettingsConflict(failure)) setDraft(null);
    setError({ leaf, words: settingsRefusalText(failure) });
  };
  const save = (leaf: string, value: unknown, revision: number | undefined) => {
    setError(null);
    actions.setLeaf.mutate({ leaf, value, revision }, { onSuccess: () => setDraft(null), onError: refused(leaf) });
  };
  const reset = (leaf: string) => {
    setError(null);
    actions.resetLeaf.mutate({ leaf, revision: revisionOf(rows.get(leaf)) }, { onSuccess: () => setDraft(null), onError: refused(leaf) });
  };
  const amount = typeof budget?.effective === 'number' ? budget.effective : null;
  const edit = (value: string) => setDraft((was) => ({ value, revision: was?.revision ?? revisionOf(budget) }));
  const commitBudget = () => {
    if (draft === null || pending) return;
    const next = Number(draft.value);
    if (draft.value.trim() === '' || !Number.isFinite(next) || next < 1) { setError({ leaf: BUDGET_LEAF, words: 'Enter an amount of at least $1.' }); return; }
    if (next === amount && draft.revision === revisionOf(budget)) { setDraft(null); return; }
    save(BUDGET_LEAF, next, draft.revision);
  };
  const note = (row: LeafRow) => changeNote(row, row.configured ? nameOf(row.updatedBy) : null, viewerId);
  const statusOf = (leaf: string, row: LeafRow | undefined, extra: string | null = null) => (error?.leaf === leaf ? error.words
    : [known(row) ? note(row) : 'Not known right now: the server could not say what this is set to', extra, admin ? null : permission.reason].filter(Boolean).join(' · '));
  const resetButton = (leaf: string, row: LeafRow | undefined, label: string) => (row?.configured === true && admin
    ? <div className="mt-s1"><Button size="sm" variant="ghost" disabled={pending} onClick={() => reset(leaf)}>{label}</Button></div> : null);
  const on = schedule?.effective === true;

  return (
    <AdminSection id="scheduling" title="Should Myco work on its own?">
      <RowCard label="Should Myco work on its own?">
        <SettingRow
          inline
          setting={SCHEDULE_LEAF}
          label="Work on its own"
          htmlFor={known(schedule) ? 'work-on-its-own' : undefined}
          note={!known(schedule) ? 'Whether Myco works on its own is unavailable until the server answers.'
            : on ? 'Myco learns from finished sessions, writes their titles and keeps code maps current, without being asked.'
            : 'Myco does nothing until you start it by hand from Myco’s work.'}
          status={statusOf(SCHEDULE_LEAF, schedule)}
          refused={error?.leaf === SCHEDULE_LEAF}
          details={resetButton(SCHEDULE_LEAF, schedule, 'Use the default (off)')}
          control={known(schedule)
            ? <Switch id="work-on-its-own" aria-label="Work on its own" checked={on} disabled={!admin || pending} onCheckedChange={(checked) => save(SCHEDULE_LEAF, checked, revisionOf(schedule))} />
            : <span className="t-small text-muted">Unavailable</span>}
        />
        <SettingRow
          setting={BUDGET_LEAF}
          label="Daily budget"
          htmlFor={known(budget) ? 'daily-budget' : undefined}
          note="The most Myco spends on its own in a day. When it’s reached, Myco waits until what counts against it drops below the budget. Work you start by hand is never blocked, and its spend counts."
          status={statusOf(BUDGET_LEAF, budget, budgetCountWords(status, status.data?.budget))}
          refused={error?.leaf === BUDGET_LEAF}
          details={resetButton(BUDGET_LEAF, budget, `Use default (${usd(BUDGET_DEFAULT_USD)})`)}
          control={known(budget) ? <div className="flex w-full items-center justify-end gap-s2">
            <span className="t-body text-muted">$</span>
            <Input
              id="daily-budget"
              aria-label="Daily budget in dollars"
              type="number"
              inputMode="decimal"
              className="min-w-0 flex-1"
              min={1}
              step={0.01}
              value={draft?.value ?? (amount === null ? '' : String(amount))}
              readOnly={!admin || pending}
              onChange={(event) => edit(event.target.value)}
              onBlur={commitBudget}
              onKeyDown={(event) => { if (event.key === 'Enter') commitBudget(); }}
            />
          </div> : <span className="t-small text-muted">Unavailable</span>}
        />
      </RowCard>
    </AdminSection>
  );
}

const DISPLAY_TONE: Readonly<Record<string, Tone>> = { Online: 'ok', Busy: 'ok', 'Not ready': 'warn' };

/** A runner's latest run whatever its outcome, in one phrase, or what it is running now. */
export function lastRunWords(runner: Pick<RunnerFleetRecord, 'busy' | 'lastCompleted' | 'lastFailed' | 'lastAttempted'>, now: number): string {
  if (runner.busy !== null) return `Running ${taskWords(runner.busy.task)} now`;
  const runs: Array<{ run: FleetRun; outcome: 'ran' | 'failed' | 'started' }> = [
    ...(runner.lastCompleted === null ? [] : [{ run: runner.lastCompleted, outcome: 'ran' as const }]),
    ...(runner.lastFailed === null ? [] : [{ run: runner.lastFailed, outcome: 'failed' as const }]),
    ...(runner.lastAttempted === null ? [] : [{ run: runner.lastAttempted, outcome: 'started' as const }]),
  ];
  // A run that ended is told by how it ended, not by its start.
  const ended = new Set(runs.filter(({ outcome }) => outcome !== 'started').map(({ run }) => run.runId));
  const latest = runs.filter(({ run, outcome }) => outcome !== 'started' || !ended.has(run.runId))
    .reduce<(typeof runs)[number] | null>((best, next) => (best === null || next.run.at > best.run.at ? next : best), null);
  if (latest === null) return 'Has not run anything yet';
  const task = taskWords(latest.run.task);
  const when = agoWords(latest.run.at, now);
  return latest.outcome === 'ran' ? `Last ran ${task} ${when}` : latest.outcome === 'failed' ? `Last run, ${task}, failed ${when}` : `Last started ${task} ${when}, with no outcome reported`;
}

/**
 * How a runner is set to pay for the agent it uses for learning, and whether it can use that agent now, from the
 * runner's own reported readiness. What the server could not say reads as unknown.
 */
export function payWords(runner: Pick<RunnerFleetRecord, 'id' | 'offers' | 'credentialChoices' | 'storedKeyFailures' | 'fallbackNotices'>, payers: AgentPayersAnswer | undefined, storedUsable: Readonly<Record<string, boolean>> | undefined): string {
  const today = payers?.today.find((entry) => entry.id === runner.id);
  if (today === undefined) return 'Which agent it would use, and how it pays, is unknown right now';
  const agent = today.agent;
  if (agent === null) return 'No agent on it can do this work now';
  const label = harnessLabel(agent);
  const choices = runner.credentialChoices ?? {};
  const choice = Object.hasOwn(choices, agent) ? choices[agent]! : 'own';
  const set = choice === null ? `Who pays for ${label} needs choosing again`
    : choice === 'own' ? `Set to pay for ${label} with its own sign-in`
      : choice === 'stored' ? `Set to pay for ${label} with the stored key`
        : `Set to pay for ${label} with the stored key first, then its own sign-in`;
  const fallback = runner.fallbackNotices?.find((entry) => entry.agent === agent);
  if (fallback !== undefined) return `${set}. ${runnerFallbackWords(fallback.reason, fallback.slot)}`;
  if (runner.offers === null) return `${set}; whether it can use it now is unknown`;
  const offer = runner.offers.find((entry) => entry.id === agent);
  if (offer === undefined) return `${set}; ${label} is not on it now`;
  if (runnerAgentLoginReady(offer, runner.credentialChoices, storedUsable)) return `${set}, and can use it now`;
  const failure = runner.storedKeyFailures?.find((entry) => entry.agent === agent);
  const why = choice !== 'own'
    ? (failure !== undefined ? storedKeyFailureTitle(failure.failure, failure.slot) : 'There is no stored key it can use')
    : offer.installed === false ? `${label} is not installed` : `It is not signed in to ${label}`;
  return `${set}, but can’t use it now. ${why}.`;
}

/** Every page of the active runners, each further page read on request. */
function useRunnerPages() {
  const query = useInfiniteQuery({
    queryKey: [...RUNNERS_KEY, 'pages'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchJson<FleetAnswer>(`/api/runners${pageParam === null ? '' : `?cursor=${encodeURIComponent(pageParam)}`}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
    ...live({ follows: ['fleet', 'runs'] }),
  });
  const runners = useMemo(() => query.data?.pages.flatMap((page) => page.runners) ?? [], [query.data]);
  return { query, runners, storedUsable: query.data?.pages[0]?.storedCredentials, total: query.data?.pages[0]?.totals?.active };
}

/** "Where the work runs": one row per registered runner, every page of them, and how to add another. */
function WhereWorkRuns() {
  const { query, runners: all, storedUsable, total } = useRunnerPages();
  const payers = useAgentPayers();
  const [adding, setAdding] = useState(false);
  const now = Date.now();
  const runners = all.filter((runner) => runner.state !== 'removed');
  const origin = window.location.origin;
  const none = query.isSuccess && !query.hasNextPage && runners.length === 0;
  return (
    <AdminSection id="runners" title="Where the work runs">
      {query.isError && <ErrorState error={query.error} onRetry={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())} />}
      <RowCard label="Where the work runs">
        {query.isPending && <LoadingState label="Reading the runners" count={2} />}
        {runners.map((runner) => (
          <div key={runner.id} className="flex flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-start sm:justify-between sm:gap-s6" data-runner-row={runner.id}>
            <div className="flex min-w-0 flex-col gap-s1">
              <span className="t-body font-medium text-ink break-words">{runner.name}</span>
              <span className="t-small text-muted">{lastRunWords(runner, now)}</span>
              <span className="t-small text-muted" data-runner-pay="">{payWords(runner, payers.data, storedUsable)}</span>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-s2">
              <StatusChip tone={DISPLAY_TONE[runner.display] ?? 'neutral'}>{runner.display}</StatusChip>
              <ActionLink to={runnerPath(runner.id)}>Manage</ActionLink>
            </div>
          </div>
        ))}
        {(query.hasNextPage || query.isFetchingNextPage) && (
          <div className="px-s4 py-s3"><ShowMore shown={all.length} total={total} noun="runners" hasMore={query.hasNextPage} pending={query.isFetchingNextPage} onMore={() => void query.fetchNextPage()} /></div>
        )}
        <div className="flex flex-col gap-s3 px-s4 py-s4">
          <div className="flex flex-col gap-s3 sm:flex-row sm:items-center sm:justify-between sm:gap-s6">
            <p className="max-w-measure t-small text-muted">
              {none ? 'No machine runs Myco’s work yet. ' : ''}
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
