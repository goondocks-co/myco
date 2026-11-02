import { useEffect, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ANY, Breadcrumbs, COMPACT_QUERY, CountButton, ErrorState, LoadingState, StatusChip, Tabs, TabsContent, TabsList, TabsTrigger, type SelectOption,
} from '../../design';
import { planPagePath } from '../../hooks/use-knowledge';
import { PLAN_COLUMNS, planStatusWord, planTitle, progressWords, SPORE_TYPES, sporeStatusWord, sporeTypePlural } from '../knowledge/words';
import { useSporePages } from '../../hooks/use-intelligence';
import { useMediaQuery } from '../../hooks/use-media-query';
import { useIsAdmin } from '../../hooks/use-me';
import { UNTITLED_REASON_TEXT, useSession, useSessionChildren, type PlanRow, type SessionResponse, type SessionRow, type TurnFilter } from '../../hooks/use-sessions';
import { useNow } from '../../hooks/use-today';
import { ApiError } from '../../lib/api';
import { sessionHeading } from '../../lib/session-text';
import { NotFound } from '../../pages/NotFound';
import { projectPath } from '../../routes/nav';
import { PageScope } from '../../routes/scope';
import { isLive } from '../today/timeline';
import { dayHeading } from '../today/words';
import { SessionAbout } from './About';
import { Conversation, TURN_FILTER_KEY, TURN_ORDER_KEY } from './Conversation';
import { FILE_KIND_KEY, SessionFiles } from './Files';
import { isRawSection } from './RawData';
import { SessionActions } from './SessionActions';
import { EVENT_TYPE_KEY, SessionEventList, useSessionEventFilters, type SessionEventRow } from './SessionEventList';
import { SessionOutcomes } from './Outcomes';
import { ACTIVITY_FILTER_KEYS, SessionActivity } from './Activity';
import { SessionLineageTab } from './Lineage';
import { agentName, sporeLine, sporeTypeWord, spanWords } from './words';

const TABS = ['conversation', 'activity', 'outcomes', 'spores', 'plans', 'files', 'lineage'] as const;
type Tab = (typeof TABS)[number];

/** The URL key that holds the About panel open. */
const ABOUT_KEY = 'about';

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
 * One session as a reading page: its title, summary and counts first, then its
 * tabs, with the conversation as an outline beside one open turn. The facts, what
 * came of the session and the raw data it was captured from sit in a panel.
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

/** While a live session is read again, what arrived since is read too: its turns, the open turn's body, its commits and its files. */
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
    void client.invalidateQueries({ queryKey: ['session-files', projectId, session.sessionId] });
  }, [client, projectId, session.sessionId, heard]);
}

function Reading({ answer, projectId, projectName, now, actions }: { answer: SessionResponse; projectId: string; projectName: string | null; now: number; actions: ReactNode }) {
  const { session, counts, outcome } = answer;
  const [params, setParams] = useSearchParams();
  const compact = useMediaQuery(COMPACT_QUERY);
  const requested = params.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(requested ?? '') ? requested as Tab : 'conversation';
  const setTab = (next: string) => {
    const copy = new URLSearchParams(params);
    if (next === 'conversation') copy.delete('tab'); else copy.set('tab', next);
    // A filter belongs to the list it was set on, never to the tab opened next.
    for (const key of ['raw', 'q', TURN_FILTER_KEY, TURN_ORDER_KEY, FILE_KIND_KEY, EVENT_TYPE_KEY, ...ACTIVITY_FILTER_KEYS]) copy.delete(key);
    setParams(copy, { replace: true });
  };
  /** A count that opens its view: the outline under a filter. */
  const openFilter = (filter: TurnFilter) => {
    const copy = new URLSearchParams(params);
    for (const key of ['tab', 'q', 'raw', ABOUT_KEY, FILE_KIND_KEY, EVENT_TYPE_KEY]) copy.delete(key);
    copy.set(TURN_FILTER_KEY, filter);
    setParams(copy);
  };
  const raw = params.get('raw');
  const rawSection = isRawSection(raw) ? raw : null;
  const aboutOpen = params.get(ABOUT_KEY) !== null || rawSection !== null;
  const setAbout = (open: boolean) => {
    const copy = new URLSearchParams(params);
    copy.delete('raw');
    if (open) copy.set(ABOUT_KEY, '1'); else copy.delete(ABOUT_KEY);
    setParams(copy, { replace: true });
  };
  const live = isLive(session, now);
  const heading = sessionHeading(session);
  const started = session.startedAt ?? session.firstReceivedAt;
  const name = projectName ?? 'A project';
  useFollowLive(projectId, session);
  const content: Record<Tab, ReactNode> = {
    conversation: <Conversation projectId={projectId} sessionId={session.sessionId} agent={session.agent} contexts={answer.turnContexts} turnsTotal={counts.prompts} now={now} />,
    activity: <SessionActivity projectId={projectId} sessionId={session.sessionId} now={now} />,
    outcomes: <SessionOutcomes projectId={projectId} sessionId={session.sessionId} now={now} />,
    spores: <SessionSpores projectId={projectId} sessionId={session.sessionId} now={now} />,
    plans: <SessionPlans projectId={projectId} sessionId={session.sessionId} now={now} />,
    files: <SessionFiles projectId={projectId} sessionId={session.sessionId} />,
    lineage: <SessionLineageTab projectId={projectId} sessionId={session.sessionId} now={now} />,
  };
  // A narrow screen gives an open turn the whole page, with its own way back.
  const turnOnly = compact && tab === 'conversation' && params.get('turn') !== null;
  const panel = <TabsContent key={tab} value={tab}>{content[tab]}</TabsContent>;

  return (
    <article data-session-page="" className="flex w-full flex-col gap-s5">
      {!turnOnly && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-s3">
            <Breadcrumbs items={[{ label: 'Sessions', to: '/sessions' }, { label: name, to: projectPath(projectId, '/sessions') }]} />
            <span className="flex items-center gap-s2">
              {actions}
              <PageScope />
            </span>
          </div>
          <header className="flex min-w-0 max-w-lead flex-col gap-s3">
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
              {session.branch !== null && <><Sep /><span className="t-mono">{session.branch}</span></>}
            </p>
            <Summary session={session} untitled={answer.untitled ?? null} live={live} />
            <div className="flex flex-wrap gap-s2" data-session-counts="">
              <CountButton value={counts.prompts} onClick={() => openFilter('all')}>{counts.prompts === 1 ? 'turn' : 'turns'}</CountButton>
              <CountButton value={counts.userPrompts} onClick={() => openFilter('you')}>{counts.userPrompts === undefined ? 'From you' : 'from you'}</CountButton>
              <CountButton value={counts.toolCalls}>{counts.toolCalls === 1 ? 'tool call' : 'tool calls'}</CountButton>
              <CountButton value={counts.failedTools} tone="bad" onClick={() => openFilter('failed')}>{counts.failedTools === undefined ? 'Failed' : 'failed'}</CountButton>
              <CountButton value={counts.mycoCalls} tone="primary" onClick={() => openFilter('myco')}>{counts.mycoCalls === 1 ? 'Myco call' : 'Myco calls'}</CountButton>
              <CountButton value={answer.filesEdited} onClick={() => setTab('files')}>{answer.filesEdited === undefined ? 'Files edited' : answer.filesEdited === 1 ? 'file edited' : 'files edited'}</CountButton>
              <CountButton onClick={() => setAbout(true)}>About this session</CountButton>
            </div>
          </header>
        </>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        {!turnOnly && (
          <TabsList aria-label="What the session holds">
            <TabsTrigger value="conversation">Conversation</TabsTrigger>
            <TabsTrigger value="activity">Agent activity</TabsTrigger>
            <TabsTrigger value="outcomes">Outcomes</TabsTrigger>
            <TabsTrigger value="spores" count={outcome.spores.total > 0 ? outcome.spores.total : undefined}>Spores</TabsTrigger>
            <TabsTrigger value="plans" count={counts.plans > 0 ? counts.plans : undefined}>Plans</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="lineage">Lineage</TabsTrigger>
          </TabsList>
        )}
        {panel}
      </Tabs>
      {aboutOpen && <SessionAbout open onClose={() => setAbout(false)} answer={answer} projectId={projectId} projectName={name} now={now} live={live} rawSection={rawSection} />}
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
