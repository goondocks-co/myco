import { useEffect, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Breadcrumbs, CopyButton, EmptyState, ErrorState, FactRow, FactsPanel, ItemLink, Link, LoadingState, ShowMore, StatusChip, Tabs, TabsContent, TabsList, TabsTrigger, TypeChip,
} from '../../design';
import { PlanLine } from '../knowledge/PlanLine';
import { releaseStateLabel, shortRef } from '../../components/release/release-labels';
import { useSpores } from '../../hooks/use-intelligence';
import { useIsAdmin, useMe } from '../../hooks/use-me';
import { UNTITLED_REASON_TEXT, useAllTurns, useSession, useSessionChildren, type PlanRow, type SessionResponse, type SessionRow } from '../../hooks/use-sessions';
import { useNow } from '../../hooks/use-today';
import { ApiError } from '../../lib/api';
import { memberLabel } from '../../lib/member-name';
import { sessionHeading } from '../../lib/session-text';
import { NotFound } from '../../pages/NotFound';
import { projectPath } from '../../routes/nav';
import { isLive } from '../today/timeline';
import { ago, dayHeading, workPlace } from '../today/words';
import { Conversation, PERSON_ONLY } from './Conversation';
import { RawData, isRawSection } from './RawData';
import { SessionActions } from './SessionActions';
import { WhatCameOfIt } from './WhatCameOfIt';
import { agentName, count, dateTime, memberName, sporeLine, sporeTypeWord, spanWords } from './words';

const TABS = ['conversation', 'spores', 'plans'] as const;
type Tab = (typeof TABS)[number];

/** How many of a session's spores its Spores tab lists; the count says how many there are. */
const SESSION_SPORE_LIMIT = 100;

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

/** While a live session is read again, what arrived since is read too: its turns, and the bodies of turns already read. */
function useFollowLive(projectId: string, session: SessionRow) {
  const client = useQueryClient();
  const heard = session.lastReceivedAt;
  const seen = useRef(heard);
  useEffect(() => {
    if (seen.current === heard) return;
    seen.current = heard;
    void client.invalidateQueries({ queryKey: ['turns', projectId, session.sessionId] });
    void client.invalidateQueries({ queryKey: ['turn', projectId, session.sessionId] });
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
    copy.delete('raw');
    setParams(copy, { replace: true });
  };
  const raw = params.get('raw');
  const live = isLive(session, now);
  const heading = sessionHeading(session);
  const started = session.startedAt ?? session.firstReceivedAt;
  const name = projectName ?? 'A project';
  const sporesHref = `?${new URLSearchParams({ tab: 'spores' })}`;
  const typed = useAllTurns(projectId, session.sessionId, PERSON_ONLY);
  useFollowLive(projectId, session);

  return (
    <article data-session-page="" className="flex w-full flex-col gap-s5">
      <Breadcrumbs items={[{ label: 'Sessions', to: '/sessions' }, { label: name, to: projectPath(projectId, '/sessions') }]} />

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
        </header>

        <div className="flex min-w-0 max-w-measure flex-col gap-s8 lg:col-start-1 lg:row-start-2">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList aria-label="What the session holds">
              <TabsTrigger value="conversation" count={typed.walking || typed.isPending ? undefined : typed.rows.length}>Conversation</TabsTrigger>
              <TabsTrigger value="spores" count={outcome.spores.total}>Spores</TabsTrigger>
              <TabsTrigger value="plans" count={counts.plans}>Plans</TabsTrigger>
            </TabsList>
            <TabsContent value="conversation">
              <Conversation projectId={projectId} sessionId={session.sessionId} />
            </TabsContent>
            <TabsContent value="spores">
              <SessionSpores projectId={projectId} sessionId={session.sessionId} now={now} />
            </TabsContent>
            <TabsContent value="plans">
              <SessionPlans projectId={projectId} sessionId={session.sessionId} now={now} />
            </TabsContent>
          </Tabs>
          <RawData projectId={projectId} sessionId={session.sessionId} open={isRawSection(raw) ? raw : null} now={now} />
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
      <FactRow term="Size">{[count(counts.prompts, 'prompt'), count(counts.toolCalls, 'tool call'), count(counts.responses, 'reply', 'replies')].join(' · ')}</FactRow>
      {release != null && <FactRow term="Release">{releaseStateLabel(release.state)}{release.ref !== null && release.state !== 'not_on_release_line' ? ` · ${shortRef(release.ref)}` : ''}</FactRow>}
      {session.parentSessionId !== null && (
        <FactRow term="Started by">
          <Link to={projectPath(projectId, `/sessions/${encodeURIComponent(session.parentSessionId)}`)}>another session</Link>
          {session.parentReason !== null && ` (${session.parentReason})`}
        </FactRow>
      )}
    </FactsPanel>
  );
}

/** Every spore this session produced, whatever its status: a spore another has since replaced still came out of this one. */
function SessionSpores({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const spores = useSpores(projectId, { session: sessionId, limit: SESSION_SPORE_LIMIT });
  if (spores.isPending) return <LoadingState label="Loading the spores" count={3} />;
  if (spores.error) return <ErrorState error={spores.error} onRetry={() => void spores.refetch()} />;
  const rows = spores.data.spores;
  const total = spores.data.total;
  if (rows.length === 0) return <EmptyState title="No spores were saved from this session yet." />;
  return (
    <div className="flex flex-col gap-s3">
      {total > rows.length && <p className="t-small text-muted">The {rows.length} newest of {count(total, 'spore')}.</p>}
      <ul aria-label="Spores" className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface-1">
        {rows.map((spore) => (
          <li key={spore.id} className="flex flex-col gap-s1 px-s4 py-s3">
            <span className="flex flex-wrap items-center gap-s2 t-meta text-muted">
              <TypeChip>{sporeTypeWord(spore.observationType)}</TypeChip>
              {spore.status !== 'active' && <StatusChip tone={spore.status === 'superseded' ? 'warn' : 'neutral'}>{sporeTypeWord(spore.status)}</StatusChip>}
              <time dateTime={new Date(spore.createdAt).toISOString()}>{dateTime(spore.createdAt, now)}</time>
            </span>
            <ItemLink to={projectPath(projectId, `/spores/${encodeURIComponent(spore.id)}`)} className="w-fit t-body text-ink">
              {sporeLine({ agentLine: spore.agentLine ?? null, content: spore.content })}
            </ItemLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The session's plans, each leading to its own page. */
function SessionPlans({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const plans = useSessionChildren<PlanRow>(projectId, sessionId, 'plans');
  if (plans.isPending) return <LoadingState label="Loading the plans" count={2} />;
  if (plans.error) return <ErrorState error={plans.error} onRetry={plans.retry} />;
  if (plans.rows.length === 0) return <EmptyState title="No plans were captured in this session." />;
  return (
    <div className="flex flex-col gap-s3">
      {plans.rows.map((plan) => <PlanLine key={plan.planKey} projectId={projectId} plan={plan} now={now} />)}
      {plans.hasMore && <ShowMore shown={plans.rows.length} noun="plans" onMore={plans.more} pending={plans.isFetchingMore} hasMore />}
    </div>
  );
}
