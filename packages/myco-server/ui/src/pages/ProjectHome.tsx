import { useEffect, useState } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AccentSurface } from '../components/ui/accent-surface';
import { Eyebrow } from '../components/ui/eyebrow';
import { MetricCard } from '../components/ui/metric-card';
import { PageContainer } from '../components/ui/page-container';
import { PageLoading } from '../components/ui/page-loading';
import { Panel } from '../components/ui/panel';
import { ActivitySparkline } from '../components/ui/sparkline';
import { StatusDot, type StatusTone } from '../components/ui/status-dot';
import { useRuns, useSkills, type RunListRow, type SkillRecord } from '../hooks/use-intelligence';
import { useProjectActions, useProjects } from '../hooks/use-projects';
import { refusalText } from '../hooks/use-access';
import { useActivity, useSessions, type FeedItem, type ProjectStats, type SessionSummaryRow } from '../hooks/use-sessions';
import { isArchived, type ProjectSummary } from '../lib/api';
import { cn } from '../lib/cn';
import { formatCount, formatDateTime, formatRelative, formatTokens } from '../lib/format';
import { forgetProject, rememberProject } from '../lib/project-memory';
import { NotFound } from './NotFound';

const TYPE_LABEL: Record<FeedItem['type'], string> = { session: 'Session', run: 'Run', spore: 'Spore' };
const OPEN_SESSIONS_SHOWN = 6;
const RUNS_SHOWN = 6;
const SKILLS_SHOWN = 6;
/** How long after the last capture the project still counts as capturing. */
const CAPTURE_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

const RUN_TONE: Record<string, StatusTone> = { running: 'ochre', completed: 'sage', failed: 'terracotta' };

export function ProjectHome() {
  const { projectId = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.projects.find((p) => p.projectId === projectId);

  useEffect(() => {
    if (project) rememberProject(project.projectId);
    else if (projects.data) forgetProject();
  }, [project, projects.data]);

  if (!project) return <NotFound />;

  return (
    <PageContainer className="gap-8">
      <Home project={project} />
    </PageContainer>
  );
}

/** One sentence on what is happening now. */
export function describeActivity(openSessions: number, runningRuns: number): string {
  const parts: string[] = [];
  if (openSessions > 0) parts.push(`${openSessions} open ${openSessions === 1 ? 'session' : 'sessions'}`);
  if (runningRuns > 0) parts.push(`${runningRuns} ${runningRuns === 1 ? 'run' : 'runs'} running`);
  return parts.length === 0 ? 'Quiet right now — nothing running.' : parts.join(' · ');
}

/** The capture-health pill: capturing now, captured recently, gone quiet, or nothing yet. */
export function captureHealth(stats: ProjectStats, nowMs: number): { tone: StatusTone; label: string } {
  if (stats.openSessions > 0) return { tone: 'sage', label: 'Capturing now' };
  if (stats.sessions === 0 || stats.lastActivityAt === null) return { tone: 'outline', label: 'No sessions captured yet' };
  const fresh = nowMs - stats.lastActivityAt <= CAPTURE_FRESH_MS;
  return fresh
    ? { tone: 'sage', label: `Last captured ${formatRelative(stats.lastActivityAt, nowMs)}` }
    : { tone: 'ochre', label: `No capture in 7 days · last ${formatRelative(stats.lastActivityAt, nowMs)}` };
}

function Home({ project }: { project: ProjectSummary }) {
  const activity = useActivity(project.projectId);
  const open = useSessions(project.projectId, { state: 'open' });
  const runs = useRuns(project.projectId, null);
  const skills = useSkills(project.projectId);
  const base = `/p/${encodeURIComponent(project.projectId)}`;
  const runningRuns = runs.rows.filter((r) => r.status === 'running').length;
  return (
    <PageLoading isLoading={activity.isPending} error={activity.error} loadingText="Loading project…">
      {activity.data && (
        <>
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <Eyebrow>Project</Eyebrow>
              <h1 className="myco-display-lg m-0 text-on-surface">{project.name}</h1>
              <p className="m-0 font-sans text-sm text-on-surface-variant" data-testid="activity-line">{describeActivity(activity.data.stats.openSessions, runningRuns)}</p>
            </div>
            <CaptureHealthPill stats={activity.data.stats} />
          </header>
          {isArchived(project) && <ArchivedBanner projectId={project.projectId} archivedAt={project.archivedAt} archivedBy={project.archivedBy} />}
          <ScopeRow stats={activity.data.stats} base={base} />
          <OpenSessionsHero base={base} sessions={open.rows.slice(0, OPEN_SESSIONS_SHOWN)} total={activity.data.stats.openSessions} pending={open.isPending} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <AgentRunsPanel base={base} runs={runs.rows} pending={runs.isPending} />
            <div className="flex flex-col gap-6">
              <SkillsPanel base={base} skills={skills.data?.skills ?? []} pending={skills.isPending} />
              <ActivityFeed base={base} items={activity.data.items} />
            </div>
          </div>
        </>
      )}
    </PageLoading>
  );
}

function CaptureHealthPill({ stats }: { stats: ProjectStats }) {
  const health = captureHealth(stats, Date.now());
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container/40 px-2.5 py-1 font-sans text-xs text-on-surface-variant" title="Capture health for this project — when a session last landed" data-testid="capture-health">
      <StatusDot tone={health.tone} pulse={health.tone === 'sage' && stats.openSessions > 0} />
      <span>{health.label}</span>
    </span>
  );
}

/** An archived project says so first: runtimes are refused until it is unarchived, and everything captured stays. */
function ArchivedBanner({ projectId, archivedAt, archivedBy }: { projectId: string; archivedAt: number | null; archivedBy: string | null }) {
  const actions = useProjectActions();
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel tone="terra" eyebrow="Archived" title="Runtimes are refused until you unarchive" data-testid="archived-banner" actions={
      <button type="button" className="rounded-md bg-primary px-3 py-1.5 font-sans text-sm text-on-primary transition-opacity hover:opacity-90" disabled={actions.unarchive.isPending} onClick={() => { setError(null); actions.unarchive.mutate(projectId, { onError: (err) => setError(refusalText(err)) }); }}>Unarchive</button>
    }>
      <p className="font-sans text-sm text-on-surface-variant">Archived {formatRelative(archivedAt)}{archivedBy ? ` by ${archivedBy}` : ''}. Everything captured before stays readable.</p>
      {error !== null && <p className="mt-2 font-sans text-xs text-tertiary">{error}</p>}
    </Panel>
  );
}

/** What the project holds, and what this week did. */
function ScopeRow({ stats, base }: { stats: ProjectStats; base: string }) {
  return (
    <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <AccentSurface accent="sage" className="flex flex-col gap-3 p-5">
        <Eyebrow tone="sage">What it holds</Eyebrow>
        <div className="grid grid-cols-2 gap-2">
          <Link to={`${base}/sessions`} className="contents"><MetricCard label="Sessions" value={stats.sessions.toLocaleString()} sub={`${stats.openSessions.toLocaleString()} open`} tone="sage" /></Link>
          <MetricCard label="Prompts" value={stats.prompts.toLocaleString()} />
          <MetricCard label="Tool calls" value={stats.toolCalls.toLocaleString()} />
          <MetricCard label="Plans" value={stats.plans.toLocaleString()} sub={formatCount(stats.attachments, 'attachment')} />
        </div>
      </AccentSurface>
      <AccentSurface accent="ochre" className="flex flex-col gap-3 p-5">
        <Eyebrow tone="ochre">Lately</Eyebrow>
        <div className="grid grid-cols-2 gap-2">
          <MetricCard label="Last 7 days" value={stats.sessionsLast7d.toLocaleString()} sub="sessions" tone="ochre" />
          <MetricCard label="Last activity" value={formatRelative(stats.lastActivityAt)} sub={stats.lastActivityAt === null ? 'nothing yet' : formatDateTime(stats.lastActivityAt)} mono />
        </div>
      </AccentSurface>
    </section>
  );
}

function OpenSessionsHero({ base, sessions, total, pending }: { base: string; sessions: SessionSummaryRow[]; total: number; pending: boolean }) {
  const navigate = useNavigate();
  const headline = total === 0 ? 'No open sessions' : `${total.toLocaleString()} open ${total === 1 ? 'session' : 'sessions'}`;
  return (
    <Panel tone="sage" eyebrow={`Open sessions · ${total.toLocaleString()}`} title={headline}>
      {pending ? (
        <div className="h-16 animate-pulse rounded-md bg-surface-container-high" aria-label="Loading open sessions" />
      ) : sessions.length === 0 ? (
        <p className="m-0 font-sans text-sm text-on-surface-variant">Sessions appear here while a runtime is capturing one.</p>
      ) : (
        <ul className="m-0 list-none space-y-2 p-0" aria-label="Open sessions">
          {sessions.map((s, i) => (
            <li key={s.sessionId}>
              <button type="button" onClick={() => navigate(`${base}/sessions/${encodeURIComponent(s.sessionId)}`)} className={cn('w-full rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-4 py-3 text-left transition-colors hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40', ['border-l-2 border-l-sage', 'border-l-2 border-l-ochre', 'border-l-2 border-l-terracotta'][i % 3])}>
                <div className="flex items-center gap-2">
                  <StatusDot tone="sage" pulse />
                  <span className="min-w-0 flex-1 truncate font-serif text-sm italic text-on-surface">{s.label}</span>
                  <span className="whitespace-nowrap font-mono text-[10px] text-outline">{formatRelative(s.lastReceivedAt)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[11px] text-on-surface-variant">
                  <span>{s.agent ?? 'unknown agent'}</span>
                  {s.branch !== null && <span>· {s.branch}</span>}
                  <span>· {s.promptCount}p · {s.toolCallCount}t</span>
                  <span className="ml-auto"><ActivitySparkline data={s.activityBuckets} kind="session" widthPx={64} heightPx={14} /></span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex items-center justify-end border-t border-[var(--ghost-border)] pt-3 font-mono text-xs text-outline">
        <Link to={`${base}/sessions`} className="inline-flex items-center gap-1 rounded text-sage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40">View session archive <ArrowRight className="h-3 w-3" /></Link>
      </div>
    </Panel>
  );
}

function AgentRunsPanel({ base, runs, pending }: { base: string; runs: RunListRow[]; pending: boolean }) {
  const navigate = useNavigate();
  const sorted = [...runs].sort((a, b) => (a.status === 'running' ? -1 : b.status === 'running' ? 1 : (b.startedAt ?? 0) - (a.startedAt ?? 0))).slice(0, RUNS_SHOWN);
  return (
    <Panel tone="terra" eyebrow="Agent runs" title="Recent" actions={<Link to={`${base}/runs`} className="inline-flex items-center gap-1 font-sans text-xs text-on-surface-variant hover:text-on-surface">All runs <ArrowRight className="h-3 w-3" /></Link>}>
      {pending ? (
        <div className="h-16 animate-pulse rounded-md bg-surface-container-high" aria-label="Loading runs" />
      ) : sorted.length === 0 ? (
        <p className="m-0 font-sans text-sm text-on-surface-variant">No runs yet. Runs appear here when this project's intelligence tasks execute.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Recent runs">
          {sorted.map((run) => (
            <li key={run.id}>
              <button type="button" onClick={() => navigate(`${base}/runs/${encodeURIComponent(run.id)}`)} className="w-full rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 py-2 text-left transition-colors hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40">
                <div className="flex items-center gap-2">
                  <StatusDot tone={RUN_TONE[run.status] ?? 'outline'} pulse={run.status === 'running'} />
                  <span className="min-w-0 flex-1 truncate font-sans text-sm text-on-surface">{run.task ?? 'untitled task'}</span>
                  {run.dryRun && <span className="rounded bg-ochre/10 px-1.5 font-mono text-[9px] uppercase tracking-wider text-ochre">dry</span>}
                  <span className="whitespace-nowrap font-mono text-[10px] text-outline">{run.status}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-outline">
                  <span>{run.id.slice(0, 8)}</span>
                  {run.startedAt !== null && <span>· {formatRelative(run.startedAt)}</span>}
                  {run.tokensUsed !== null && run.tokensUsed > 0 && <span>· {formatTokens(run.tokensUsed)} tok</span>}
                  {run.model !== null && <span>· {run.model}</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function SkillsPanel({ base, skills, pending }: { base: string; skills: SkillRecord[]; pending: boolean }) {
  const sorted = [...skills].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, SKILLS_SHOWN);
  return (
    <Panel tone="sage" eyebrow="Skills" title="Recently evolved" actions={<Link to={`${base}/skills`} className="inline-flex items-center gap-1 font-sans text-xs text-on-surface-variant hover:text-on-surface">All skills <ArrowRight className="h-3 w-3" /></Link>}>
      {pending ? (
        <div className="h-12 animate-pulse rounded-md bg-surface-container-high" aria-label="Loading skills" />
      ) : sorted.length === 0 ? (
        <p className="m-0 font-sans text-sm text-on-surface-variant">No skills yet. Skills appear here once the skill tasks have run.</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2" aria-label="Recent skills">
          {sorted.map((skill) => (
            <li key={skill.id}>
              <Link to={`${base}/skills/${encodeURIComponent(skill.id)}`} className="block rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 py-2 no-underline transition-colors hover:bg-surface-container">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3 shrink-0 text-sage" />
                  <span className="truncate font-sans text-xs font-medium text-on-surface" title={skill.displayName}>{skill.displayName || skill.name}</span>
                  <span className="ml-auto shrink-0 rounded bg-ochre/10 px-1.5 font-mono text-[9px] uppercase tracking-wider text-ochre">gen {skill.generation}</span>
                </div>
                <div className="mt-1 font-mono text-[10px] text-outline">{formatRelative(skill.updatedAt)}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** What happened last, across sessions, runs and spores, each line linking where it belongs. */
function ActivityFeed({ base, items }: { base: string; items: FeedItem[] }) {
  const linkOf = (item: FeedItem): string | null =>
    item.type === 'session' ? `${base}/sessions/${encodeURIComponent(item.id)}` : item.type === 'run' ? `${base}/runs/${encodeURIComponent(item.id)}` : item.sessionId === null ? null : `${base}/sessions/${encodeURIComponent(item.sessionId)}`;
  return (
    <Panel tone="ochre" eyebrow="Activity" title="What happened last" padded={items.length === 0}>
      {items.length === 0 ? (
        <p className="m-0 font-sans text-sm text-on-surface-variant">Nothing captured yet.</p>
      ) : (
        <ul className="divide-y divide-outline-variant/10" aria-label="Activity">
          {items.map((item) => {
            const to = linkOf(item);
            return (
              <li key={`${item.type}:${item.id}`} className="flex items-center gap-3 px-5 py-2 font-sans text-sm">
                <span className="w-14 shrink-0 font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">{TYPE_LABEL[item.type]}</span>
                {to === null ? <span className="min-w-0 flex-1 truncate text-on-surface">{item.summary}</span> : <Link to={to} className="min-w-0 flex-1 truncate text-on-surface hover:underline">{item.summary}</Link>}
                <span className="shrink-0 font-mono text-[11px] text-on-surface-variant" title={formatDateTime(item.at)}>{formatRelative(item.at)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
