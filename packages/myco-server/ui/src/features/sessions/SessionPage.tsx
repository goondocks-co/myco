import { useEffect, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ANY, Breadcrumbs, Button, CopyButton, ErrorState, FactRow, FactsPanel, Link, LoadingState, StatusChip, Tabs, TabsContent, TabsList, TabsTrigger, type SelectOption,
} from '../../design';
import { planPagePath } from '../../hooks/use-knowledge';
import { PLAN_COLUMNS, planStatusWord, planTitle, progressWords, SPORE_TYPES, sporeStatusWord, sporeTypePlural } from '../knowledge/words';
import { releaseStateLabel, shortRef } from '../../components/release/release-labels';
import { useSporePages } from '../../hooks/use-intelligence';
import { useIsAdmin, useMe } from '../../hooks/use-me';
import { SESSION_ANSWER_KIND_PREFIX, UNTITLED_REASON_TEXT, useSession, useSessionChildren, useSessionLineage, type ContextInjectionRow, type PlanRow, type SessionResponse, type SessionRow } from '../../hooks/use-sessions';
import { useNow } from '../../hooks/use-today';
import { ApiError } from '../../lib/api';
import { memberLabel } from '../../lib/member-name';
import { sessionHeading } from '../../lib/session-text';
import { NotFound } from '../../pages/NotFound';
import { projectPath } from '../../routes/nav';
import { PageScope } from '../../routes/scope';
import { isLive } from '../today/timeline';
import { ago, dayHeading, workPlace } from '../today/words';
import { ToolUsageLine } from './Usage';
import { formatElapsed } from '../../lib/format';
import { Conversation } from './Conversation';
import { RawData, isRawSection } from './RawData';
import { SessionActions } from './SessionActions';
import { EVENT_TYPE_KEY, SessionEventList, useSessionEventFilters, type SessionEventRow } from './SessionEventList';
import { SessionOutcomes } from './Outcomes';
import { ACTIVITY_FILTER_KEYS, SessionActivity } from './Activity';
import { WhatCameOfIt } from './WhatCameOfIt';
import { lineageName, SessionLineageTab, sessionPagePath } from './Lineage';
import { agentName, count, dateTime, memberName, sporeLine, sporeTypeWord, spanWords } from './words';

const TABS = ['conversation', 'activity', 'outcomes', 'spores', 'plans', 'lineage'] as const;
type Tab = (typeof TABS)[number];

const SPORE_TYPE_OPTIONS: readonly SelectOption[] = [
  { value: ANY, label: 'Every type' },
  ...SPORE_TYPES.map((type) => ({ value: type, label: sporeTypePlural(type) })),
];

const PLAN_STATUS_OPTIONS: readonly SelectOption[] = [
  { value: ANY, label: 'Every status' },
  ...PLAN_COLUMNS.map((status) => ({ value: status, label: planStatusWord(status) })),
];

export interface SessionPageProps {
  projectId: string;
  sessionId: string;
  /** The project's name, or null while the dashboard does not know it. */
  projectName: string | null;
}

/**
 * One session as a reading page: its title and summary first, the conversation
 * at a readable width, the facts and what came of the session beside it, and
 * the raw data it was captured from folded away at the foot.
 */
export function SessionPage({ projectId, sessionId, projectName }: SessionPageProps) {
  const detail = useSession(projectId, sessionId);
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const now = useNow();
  if (detail.error instanceof ApiError && detail.error.status === 404) return <NotFound />;
  if (detail.data === undefined) {
    if (detail.isPending) return <LoadingState shape="reading" label="Loading the session" />;
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  }
  const listPath = projectPath(projectId, '/sessions');
  return (
    <Reading
      answer={detail.data}
      projectId={projectId}
      projectName={projectName}
      now={now}
      actions={admin ? <SessionActions projectId={projectId} session={detail.data.session} counts={detail.data.counts} onDeleted={() => navigate(listPath, { replace: true })} /> : null}
    />
  );
}

/** While a live session is read again, what arrived since is read too: its turns, the bodies of turns already read, and its commits. */
function useFollowLive(projectId: string, session: SessionRow) {
  const client = useQueryClient();
  const heard = session.lastReceivedAt;
  const seen = useRef(heard);
  useEffect(() => {
    if (seen.current === heard) return;
    seen.current = heard;
    void client.invalidateQueries({ queryKey: ['turns', projectId, session.sessionId] });
    void client.invalidateQueries({ queryKey: ['turn', projectId, session.sessionId] });
    void client.invalidateQueries({ queryKey: ['session-commits', projectId, session.sessionId] });
    void client.invalidateQueries({ queryKey: ['session-activity', projectId, session.sessionId] });
  }, [client, projectId, session.sessionId, heard]);
}

function Reading({ answer, projectId, projectName, now, actions }: { answer: SessionResponse; projectId: string; projectName: string | null; now: number; actions: ReactNode }) {
  const { session, counts, outcome } = answer;
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(requested ?? '') ? requested as Tab : 'conversation';
  const setTab = (next: string) => {
    const copy = new URLSearchParams(params);
    if (next === 'conversation') copy.delete('tab'); else copy.set('tab', next);
    // A filter belongs to the list it was set on, never to the tab opened next.
    for (const key of ['raw', 'q', EVENT_TYPE_KEY, ...ACTIVITY_FILTER_KEYS]) copy.delete(key);
    setParams(copy, { replace: true });
  };
  const raw = params.get('raw');
  const live = isLive(session, now);
  const heading = sessionHeading(session);
  const started = session.startedAt ?? session.firstReceivedAt;
  const name = projectName ?? 'A project';
  const sporesHref = `?${new URLSearchParams({ tab: 'spores' })}`;
  useFollowLive(projectId, session);
  const content: Record<Tab, ReactNode> = {
    conversation: <Conversation projectId={projectId} sessionId={session.sessionId} agent={session.agent} contexts={answer.turnContexts} now={now} />,
    activity: <SessionActivity projectId={projectId} sessionId={session.sessionId} now={now} />,
    outcomes: <SessionOutcomes projectId={projectId} sessionId={session.sessionId} now={now} />,
    spores: <SessionSpores projectId={projectId} sessionId={session.sessionId} now={now} />,
    plans: <SessionPlans projectId={projectId} sessionId={session.sessionId} now={now} />,
    lineage: <SessionLineageTab projectId={projectId} sessionId={session.sessionId} now={now} />,
  };

  return (
    <article data-session-page="" className="flex w-full flex-col gap-s5">
      <div className="flex flex-wrap items-center justify-between gap-s3">
        <Breadcrumbs items={[{ label: 'Sessions', to: '/sessions' }, { label: name, to: projectPath(projectId, '/sessions') }]} />
        <PageScope />
      </div>

      <div className="grid items-start gap-s6 lg:grid-reading lg:grid-rows-lead lg:gap-x-s10">
        <header className="flex min-w-0 max-w-measure flex-col gap-s3 lg:col-start-1 lg:row-start-1">
          <h1 className="t-display text-ink" data-session-title="">
            {heading.titled ? heading.title : (
              <>
                <StatusChip className="mr-s2 align-middle">Untitled</StatusChip>
                <span className={heading.firstPrompt === null ? 'text-muted' : undefined}>{heading.firstPrompt ?? 'Untitled session'}</span>
              </>
            )}
          </h1>
          <p className="flex flex-wrap items-center gap-x-s2 gap-y-s1 t-small text-muted">
            {live && (
              <StatusChip tone="ok">
                <span aria-hidden className="size-s2 rounded-pill bg-ok motion-safe:animate-pulse" />
                Live
              </StatusChip>
            )}
            <span className="font-medium text-ink-2">{name}</span>
            <Sep />
            <span>{agentName(session.agent)}</span>
            <Sep />
            <time dateTime={new Date(started).toISOString()}>{dayHeading(started, now)}</time>
            {session.endedAt !== null && session.startedAt !== null && <><Sep /><span>{spanWords(session.endedAt - session.startedAt)}</span></>}
            <Sep />
            <span>{count(counts.prompts, 'prompt')}</span>
          </p>
          <Summary session={session} untitled={answer.untitled ?? null} live={live} />
          <SessionContext projectId={projectId} sessionId={session.sessionId} />
        </header>

        <div className="flex min-w-0 max-w-measure flex-col gap-s8 lg:col-start-1 lg:row-start-2">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList aria-label="What the session holds">
              <TabsTrigger value="conversation">Conversation</TabsTrigger>
              <TabsTrigger value="activity">Agent activity</TabsTrigger>
              <TabsTrigger value="outcomes">Outcomes</TabsTrigger>
              <TabsTrigger value="spores">Spores</TabsTrigger>
              <TabsTrigger value="plans">Plans</TabsTrigger>
              <TabsTrigger value="lineage">Lineage</TabsTrigger>
            </TabsList>
            {TABS.map((value) => (
              <TabsContent key={value} value={value}>{value === tab ? content[value] : null}</TabsContent>
            ))}
          </Tabs>
          <RawData agent={session.agent} projectId={projectId} sessionId={session.sessionId} open={isRawSection(raw) ? raw : null} now={now} />
        </div>
        {/* After the conversation in reading order; beside it from the desktop width. */}
        <aside aria-label="About this session" className="flex min-w-0 flex-col gap-s4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <Facts answer={answer} projectName={name} projectId={projectId} now={now} live={live} actions={actions} />
          <WhatCameOfIt projectId={projectId} outcome={outcome} open={session.endedAt === null} now={now} sporesHref={sporesHref} />
        </aside>
      </div>
    </article>
  );
}

function Sep() {
  return <span aria-hidden>·</span>;
}


/**
 * What Myco served the session as a whole, read from its session-level context records: the start block, and the
 * context that reached no prompt the conversation shows.
 */
function SessionContext({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const records = useSessionChildren<ContextInjectionRow>(projectId, sessionId, 'context-injections');
  if (records.isPending) return null;
  if (records.error) return <p className="t-small text-muted" data-session-context="">Myco’s session context could not be read.</p>;
  const start = records.rows.some((record) => record.kind === 'cortex');
  const unattached = records.rows.filter((record) => record.kind.startsWith(SESSION_ANSWER_KIND_PREFIX)).length;
  if (!start && unattached === 0) return null;
  return (
    <ul className="flex flex-col gap-s1 t-small text-muted" data-session-context="">
      {start && <li>Myco sent the session start block</li>}
      {unattached > 0 && <li>Myco added context {count(unattached, 'time')}{records.hasMore ? ' or more' : ''} in this session</li>}
    </ul>
  );
}

/** The summary as the page's lead, or why there is none yet. */
function Summary({ session, untitled, live }: { session: SessionRow; untitled: SessionResponse['untitled'] | null; live: boolean }) {
  const summary = session.summary?.trim() ?? '';
  if (summary !== '') return <p className="whitespace-pre-line t-body text-ink-2" data-summary="">{summary}</p>;
  if (untitled != null) return <p className="t-small text-muted" data-summary-missing="">{UNTITLED_REASON_TEXT[untitled]}.</p>;
  return (
    <p className="t-small text-muted" data-summary-missing="">
      {live || session.endedAt === null ? 'Myco writes a summary once the session ends.' : 'No summary yet.'}
    </p>
  );
}

/** The facts a reader checks or copies. The session's id is only ever copied, never shown. */
function Facts({ answer, projectId, projectName, now, live, actions }: { answer: SessionResponse; projectId: string; projectName: string; now: number; live: boolean; actions: ReactNode }) {
  const { session, counts, release } = answer;
  const who = memberName(session);
  // The viewer's own machine, by its name or as "Your machine"; another member's machine is named by the Member row alone.
  const viewerId = useMe().data?.member?.id ?? null;
  const place = workPlace(session.runtimeLabel, session.memberId === null ? null : { id: session.memberId, label: session.memberLabel }, viewerId);
  const machine = place?.own === true ? place.machine : null;
  const endedBy = session.endedBy === null ? null : memberLabel({ id: session.endedBy, label: session.endedByLabel }) ?? 'a member';
  return (
    <FactsPanel
      title="Facts"
      actions={(
        <>
          {answer.resume != null && <CopyButton value={answer.resume.line} label="Copy resume command" variant="secondary" data-resume="" />}
          <CopyButton value={session.sessionId} label="Copy session id" variant="secondary" />
          {actions}
        </>
      )}
    >
      <FactRow term="Project">{projectName}</FactRow>
      <FactRow term="Agent">{agentName(session.agent)}</FactRow>
      {machine !== null && <FactRow term="Machine">{machine}</FactRow>}
      {who !== null && <FactRow term="Member">{who}</FactRow>}
      {session.branch !== null && <FactRow term="Branch" mono>{session.branch}</FactRow>}
      {session.originPath !== null && <FactRow term="Folder" mono>{session.originPath}</FactRow>}
      <FactRow term="Started">{dateTime(session.startedAt ?? session.firstReceivedAt, now)}</FactRow>
      {session.endedAt !== null
        ? <FactRow term="Ended">{dateTime(session.endedAt, now)}{endedBy !== null && ` by ${endedBy}`}</FactRow>
        : <FactRow term={live ? 'Live' : 'Open'}>Last heard {ago(session.lastReceivedAt, now)}</FactRow>}
      <FactRow term={session.endedAt === null ? 'Time observed' : 'Wall time'}>{answer.metrics?.durationMs === null ? 'Not recorded' : formatElapsed(answer.metrics?.durationMs ?? Math.max(0, (session.endedAt ?? session.lastReceivedAt) - (session.startedAt ?? session.firstReceivedAt)))}</FactRow>
      <FactRow term="Tools">{answer.metrics !== undefined && answer.metrics.tools.length > 0 ? <ToolUsageLine tools={answer.metrics.tools} /> : `${count(counts.toolCalls, 'tool call')}${(counts.failedTools ?? 0) > 0 ? ` · ${counts.failedTools} failed` : ''}`}</FactRow>
      <FactRow term="Tokens">{answer.metrics?.tokens == null ? 'Not recorded, including sub-agents' : answer.metrics.tokens.toLocaleString()}</FactRow>
      <FactRow term="Size">{[count(counts.prompts, 'prompt'), count(counts.toolCalls, 'tool call'), count(counts.responses, 'reply', 'replies')].join(' · ')}</FactRow>
      {release != null && <FactRow term="Release">{releaseStateLabel(release.state)}{release.ref !== null && release.state !== 'not_on_release_line' ? ` · ${shortRef(release.ref)}` : ''}</FactRow>}
      <Family projectId={projectId} session={session} />
    </FactsPanel>
  );
}

/** How many children the facts name: exact when the family was read whole, a lower bound when a bound cut it short. */
function childrenWords(children: number, truncated: boolean): string {
  if (!truncated) return count(children, 'session');
  return children === 0 ? 'Not all counted' : `${children}+ ${children === 1 ? 'session' : 'sessions'}`;
}

/**
 * The session's parents, each by name, and how many children it has, which open the lineage. A failed read says so
 * with a retry, beside whatever an earlier read already showed.
 */
function Family({ projectId, session }: { projectId: string; session: SessionRow }) {
  const lineage = useSessionLineage(projectId, session.sessionId);
  if (lineage.isPending) return null;
  const failed = lineage.error !== null && (
    <FactRow term="Family">
      <span data-family-error="">Could not be read</span>{' '}
      <Button size="sm" variant="ghost" className="tap-area" onClick={() => void lineage.refetch()}>Retry</Button>
    </FactRow>
  );
  if (lineage.data === undefined) return failed;
  const byId = new Map(lineage.data.nodes.map((node) => [node.sessionId, node]));
  const parents = lineage.data.edges.filter((edge) => edge.childId === session.sessionId);
  const children = new Set(lineage.data.edges.filter((edge) => edge.parentId === session.sessionId).map((edge) => edge.childId)).size;
  return (
    <>
      {parents.map((edge) => {
        const parent = byId.get(edge.parentId);
        const name = lineageName(parent);
        return (
          <FactRow key={`${edge.kind}:${edge.parentId}`} term="Parent">
            {parent?.captured === true ? <Link to={sessionPagePath(projectId, edge.parentId)} className="tap-area">{name}</Link> : name}
            {edge.kind === 'continuation' && <span className="block text-muted">This session continues it{edge.reason === null ? '' : ` (${edge.reason})`}</span>}
          </FactRow>
        );
      })}
      {(children > 0 || lineage.data.truncated) && (
        <FactRow term="Children">
          <Link to={`?${new URLSearchParams({ tab: 'lineage' })}`} className="tap-area">{childrenWords(children, lineage.data.truncated)}</Link>
        </FactRow>
      )}
      {failed}
    </>
  );
}

/** Every spore this session produced, whatever its status: a spore another has since replaced still came out of this one. */
function SessionSpores({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const filters = useSessionEventFilters();
  const spores = useSporePages(projectId, { session: sessionId, ...(filters.type === null ? {} : { type: filters.type }), q: filters.q });
  const rows = spores.rows.map((spore): SessionEventRow => ({
    key: spore.id,
    at: spore.createdAt,
    kind: sporeTypeWord(spore.observationType),
    title: sporeLine({ agentLine: spore.agentLine ?? null, content: spore.content }),
    detail: sporeStatusWord(spore.status),
    to: projectPath(projectId, `/spores/${encodeURIComponent(spore.id)}`),
  }));
  return (
    <SessionEventList
      filter={{ filters, searchLabel: 'Search spores', placeholder: 'Search what the spores say', typeLabel: 'Type', typeOptions: SPORE_TYPE_OPTIONS }}
      read={{ ...spores, rows }}
      noun="spores"
      emptyTitle="No spores were saved from this session yet."
      loadingLabel="Loading the spores"
      now={now}
    />
  );
}

/** The session's plans, each leading to its own page. */
function SessionPlans({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const filters = useSessionEventFilters();
  const plans = useSessionChildren<PlanRow>(projectId, sessionId, 'plans', { ...(filters.type === null ? {} : { status: filters.type }), q: filters.q });
  const rows = plans.rows.map((plan): SessionEventRow => ({
    key: plan.planKey,
    at: plan.updatedAt,
    kind: planStatusWord(plan.status),
    title: planTitle(plan),
    detail: [progressWords(plan.progress), plan.originPath].filter((part) => part !== null).join(' · ') || undefined,
    to: planPagePath(projectId, { planKey: plan.planKey }),
  }));
  return (
    <SessionEventList
      filter={{ filters, searchLabel: 'Search plans', placeholder: 'Search plan titles', typeLabel: 'Status', typeOptions: PLAN_STATUS_OPTIONS }}
      read={{ ...plans, rows }}
      noun="plans"
      emptyTitle="No plans were captured in this session."
      loadingLabel="Loading the plans"
      now={now}
    />
  );
}
