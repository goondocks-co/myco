import { pendingDeviceCode } from '../lib/pending-device';
import { ReadState } from '../design';
import { failureWords } from '../features/work/words';
import { type ReactNode } from 'react';
import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { ActionLink, COMPACT_QUERY, EmptyState, ErrorState, LoadingState, PHONE_QUERY, Skeleton, StatusChip } from '../design';
import { ArchivedNotice } from '../features/today/ArchivedNotice';
import { CapturePanel } from '../features/today/CapturePanel';
import { NeedsYouPanel, NeedsYouSummary, type NeedsYouProps } from '../features/today/NeedsYou';
import { Lede, ledeParts, UpkeepLine } from '../features/today/Summary';
import { PageScope } from './scope';
import { hasRunOutput, sporesWritten, type SessionEntry, type TimelineEntry, type WorkEntry } from '../features/today/timeline';
import { FailureNote, KickerProject, KickerSep, NestedLines, TimelineItem, TitleLink, type TimelineTone } from '../features/today/TimelineItem';
import type { WorkAnswer } from '../features/today/wire';
import {
  agentName, clockTime, count, dayHeading, failureNextStep, shortDay, sinceWords, sporeLine, sporeTypeWord, workHeadline, workPlace,
} from '../features/today/words';
import { useNeedsYou } from '../hooks/use-needs-you';
import { useIsAdmin, useMe } from '../hooks/use-me';
import { useMediaQuery } from '../hooks/use-media-query';
import { useProjects } from '../hooks/use-projects';
import { useStatus } from '../hooks/use-status';
import { useNow, useToday } from '../hooks/use-today';
import { freshness } from '../hooks/use-work';
import { isArchived } from '../lib/api';
import { cn } from '../lib/cn';
import { cleanSessionText, sessionHeading, sessionHeadingText } from '../lib/session-text';
import { readPendingLink } from '../lib/pending-link';
import { useRouteProject } from './route-project';
import { CODE_MAP_SUFFIX, HEALTH_ANCHORS, HEALTH_PATH, projectPath, runPath } from './nav';

/** How many of a run's spores, or of the sessions it titled, an item lists before "and N more". */
const NESTED_SHOWN = 3;

/**
 * `/` is where sign-in lands. A pending GitHub link resumes there first, ahead
 * of the shell, so an account no member is linked to yet still reaches `/link`;
 * every other path, and `/` without one, renders what it holds.
 */
export function ResumePendingLink() {
  const { pathname } = useLocation();
  if (pathname === '/' && readPendingLink() !== null) return <Navigate to="/link" replace />;
  const deviceCode = pendingDeviceCode();
  if (pathname === '/' && deviceCode !== null) return <Navigate to="/device" replace />;
  return <Outlet />;
}

/** Today at `/`, across every project, and at `/p/:projectId`, narrowed to one. */
export function Today() {
  const { projectId, standIn } = useRouteProject();
  const projects = useProjects();
  if (standIn !== null) return standIn;
  // A server with no project yet has no day to show; the Projects page says how to add one.
  if (projectId === null && projects.data?.projects.length === 0) return <Navigate to="/projects" replace />;
  // Across every project the day's reads start beside the projects' read; the page shows once the list has answered.
  return <TodayPage projectId={projectId} waiting={projects.isPending} />;
}

function TodayPage({ projectId, waiting }: { projectId: string | null; waiting: boolean }) {
  const [search] = useSearchParams();
  const location = useLocation();
  const now = useNow();
  const admin = useIsAdmin();
  const compact = useMediaQuery(COMPACT_QUERY);
  const phone = useMediaQuery(PHONE_QUERY);
  const projects = useProjects();
  const today = useToday({ projectId, day: search.get('day'), now });
  const status = useStatus(freshness(true));

  const names = new Map((projects.data?.projects ?? []).map((p) => [p.projectId, p.name]));
  const projectName = (id: string): string | null => names.get(id) ?? null;
  const scoped = projectId !== null;
  const project = projectId === null ? undefined : projects.data?.projects.find((p) => p.projectId === projectId);
  const { window } = today;
  const dayHref = (param: string | null) => (param === null ? location.pathname : `${location.pathname}?day=${param}`);

  const needsYou: NeedsYouProps = useNeedsYou({ now, projectName });

  if (waiting) return <LoadingState label="Loading today" count={4} />;
  return (
    <div className="flex w-full flex-col gap-s5" data-today="">
      {project !== undefined && isArchived(project) && <ArchivedNotice projectId={project.projectId} archivedAt={project.archivedAt} now={now} />}
      {phone && <NeedsYouSummary {...needsYou} />}
      <header className="flex flex-col gap-s2">
        <div className="flex flex-wrap items-center gap-x-s3 gap-y-s2">
          <h1 className="t-display text-ink">{dayHeading(window.start, now)}</h1>
          <PageScope />
        </div>
        {today.counts !== undefined && today.entries !== undefined && today.entries.length > 0
          ? <Lede parts={ledeParts(today.counts, { isToday: window.isToday, scoped, projectName })} />
          : today.isPending ? <Skeleton className="h-s5 w-3/5" /> : null}
        {!window.isToday && <DayLink to={dayHref(null)}>Back to today</DayLink>}
      </header>
      <div className="grid items-start gap-s6 lg:grid-rail">
        {/* The rail comes first in reading order, so Needs you is reached before the day's timeline; the grid places it to the right. */}
        <div className="order-2 flex min-w-0 flex-col gap-s4 lg:col-start-2 lg:row-start-1">
          {!compact && <NeedsYouPanel {...needsYou} />}
          <CapturePanel
            rows={status.data?.capture}
            unavailable={status.data?.unavailable?.includes('capture') ?? false}
            pending={status.isPending}
            error={status.error}
            onRetry={() => void status.refetch()}
            now={now}
          />
        </div>
        <section aria-label="Timeline" className="order-1 flex min-w-0 flex-col gap-s4 lg:col-start-1 lg:row-start-1">
          {compact && !phone && <NeedsYouPanel {...needsYou} />}
          <Timeline
            entries={today.entries}
            pending={today.isPending}
            error={today.error}
            onRetry={today.retry}
            work={today.work}
            scoped={scoped}
            projectName={projectName}
            truncated={today.truncated}
            quiet={window.isToday ? 'Nothing today' : 'Nothing this day'}
            earlier={<DayLink to={dayHref(window.previous)}>{window.isToday ? 'Yesterday’s work' : 'The day before'} →</DayLink>}
            now={now}
          />
          {window.isToday && today.work !== undefined && <UpkeepLine upkeep={today.work.upkeep} now={now} statusHref={admin ? `${HEALTH_PATH}#${HEALTH_ANCHORS.upkeep}` : null} />}
          {today.entries !== undefined && today.entries.length > 0 && (
            <DayLink to={dayHref(window.previous)}>{window.isToday ? 'Yesterday' : dayHeading(new Date(window.start - 1).getTime(), now)} →</DayLink>
          )}
        </section>
      </div>
    </div>
  );
}

function DayLink({ to, children }: { to: string; children: ReactNode }) {
  return <ActionLink to={to}>{children}</ActionLink>;
}

interface TimelineProps {
  entries: TimelineEntry[] | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  work: WorkAnswer | undefined;
  scoped: boolean;
  projectName: (projectId: string) => string | null;
  /** Whether the day held more than was read: then an empty list is not a quiet day. */
  truncated: boolean;
  quiet: string;
  earlier: ReactNode;
  now: number;
}

const TRUNCATED = 'This day held more than the timeline lists; the newest are shown.';

function Timeline({ entries, pending, error, onRetry, work, scoped, projectName, truncated, quiet, earlier, now }: TimelineProps) {
  if (entries === undefined) {
    if (pending) return <LoadingState label="Loading the day" count={4} />;
    return <ErrorState error={error} onRetry={onRetry} />;
  }
  if (error) return <ReadState data={entries} pending={pending} error={error} onRetry={onRetry} label="the day">{(retained) => <Timeline entries={retained} pending={false} error={null} onRetry={onRetry} work={work} scoped={scoped} projectName={projectName} truncated={truncated} quiet="No entries in the last successful read" earlier={earlier} now={now} />}</ReadState>;
  if (entries.length === 0) {
    return truncated ? <p className="t-small text-muted" data-truncated="">{TRUNCATED}</p> : <EmptyState title={quiet} action={earlier} />;
  }
  return (
    <>
      <ol aria-label="What happened" className="flex flex-col">
        {entries.map((entry) => (entry.type === 'session'
          ? <SessionItem key={entry.key} entry={entry} scoped={scoped} projectName={projectName} now={now} />
          : <WorkItem key={entry.key} entry={entry} scoped={scoped} projectName={projectName} work={work} />))}
      </ol>
      {truncated && <p className="t-small text-muted" data-truncated="">{TRUNCATED}</p>}
    </>
  );
}

function ProjectKicker({ scoped, projectId, projectName }: { scoped: boolean; projectId: string; projectName: (projectId: string) => string | null }) {
  if (scoped) return null;
  return (
    <>
      <KickerProject>{projectName(projectId) ?? 'A project'}</KickerProject>
      <KickerSep />
    </>
  );
}

function SessionItem({ entry, scoped, projectName, now }: { entry: SessionEntry; scoped: boolean; projectName: (projectId: string) => string | null; now: number }) {
  const { session } = entry;
  const viewerId = useMe().data?.member?.id ?? null;
  const place = workPlace(session.runtimeLabel, session.memberId === null ? null : { id: session.memberId, label: session.memberLabel }, viewerId);
  const who = place === null ? '' : ` ${place.line}`;
  const heading = sessionHeading(session);
  return (
    <TimelineItem
      time={entry.live ? 'now' : entry.earlier ? shortDay(entry.at, now) : clockTime(entry.at)}
      at={entry.live ? session.lastReceivedAt : entry.at}
      tone={entry.live ? 'live' : 'plain'}
      kicker={(
        <>
          {entry.live && (
            <StatusChip tone="ok">
              <span aria-hidden className="size-s2 rounded-pill bg-ok motion-safe:animate-pulse" />
              Live
            </StatusChip>
          )}
          <ProjectKicker scoped={scoped} projectId={entry.projectId} projectName={projectName} />
          <span>{agentName(session.agent)}<span className="hidden sm:inline">{who}</span></span>
          {entry.earlier && (
            <>
              <KickerSep />
              <span data-started-earlier="">{sinceWords(entry.at, now)}</span>
            </>
          )}
          {session.promptCount > 0 && (
            <span className="hidden items-center gap-s2 sm:inline-flex">
              <KickerSep />
              <span>{count(session.promptCount, 'prompt')}</span>
            </span>
          )}
        </>
      )}
      title={(
        <TitleLink to={`${projectPath(entry.projectId)}/sessions/${encodeURIComponent(session.sessionId)}`}>
          {heading.titled ? heading.title : <UntitledHeading firstPrompt={heading.firstPrompt} />}
        </TitleLink>
      )}
      summary={cleanSessionText(session.summary) ?? undefined}
    />
  );
}

/**
 * An untitled session: the first line the person typed as its heading, marked
 * with a small "Untitled" tag, or "Untitled session" in secondary text when it
 * has no such line.
 */
function UntitledHeading({ firstPrompt }: { firstPrompt: string | null }) {
  if (firstPrompt === null) return <span className="font-normal text-muted">Untitled session</span>;
  return (
    <>
      <StatusChip className="mr-s2 align-text-bottom">Untitled</StatusChip>
      <span className="text-ink">{firstPrompt}</span>
    </>
  );
}

function WorkItem({ entry, scoped, projectName, work }: { entry: WorkEntry; scoped: boolean; projectName: (projectId: string) => string | null; work: WorkAnswer | undefined }) {
  const produced = entry.runs.filter(hasRunOutput);
  const failed = entry.runs.filter((run) => run.result === 'failed');
  const kept = entry.runs.filter((run) => run.result === 'failed_with_output');
  const noted = failed[0] ?? kept[0];
  const tone: TimelineTone = failed.length === entry.runs.length ? 'bad' : entry.kind === 'learn' || entry.kind === 'seed' ? 'learn' : 'plain';
  const single = entry.runs.length === 1 ? entry.runs[0]! : null;
  const runAt = (runId: string) => runPath(entry.projectId, runId);
  const headline = workHeadline(entry.kind, entry.runs);
  const mapLinked = entry.kind === 'map' && produced.length > 0 && failed.length === 0;
  const map = entry.kind === 'map' && single !== null
    ? work?.outcomes.find((o) => o.projectId === entry.projectId && o.kind === 'map' && o.map?.sourceRunId === single.id)?.map ?? null
    : null;

  return (
    <TimelineItem
      time={clockTime(entry.at)}
      at={entry.at}
      tone={tone}
      kicker={(
        // Myco's items lead with the outcome, the project after it; one run of text, so a long headline wraps as a sentence.
        <span className="min-w-0">
          <span className={cn('font-medium', tone === 'bad' ? 'text-ink' : 'text-ink-2')}>
            {mapLinked ? <TitleLink inline to={`${projectPath(entry.projectId)}${CODE_MAP_SUFFIX}`}>{headline}</TitleLink>
              : single !== null ? <TitleLink inline to={runAt(single.id)}>{headline}</TitleLink> : headline}
          </span>
          {map !== null && <span><span aria-hidden className="mx-s2">·</span>now at {map.branch} @ {map.commit.slice(0, 7)}</span>}
          {!scoped && <span><span aria-hidden className="mx-s2">·</span><span className="whitespace-nowrap" data-in-project="">in {projectName(entry.projectId) ?? 'a project'}</span></span>}
        </span>
      )}
    >
      {(entry.kind === 'learn' || entry.kind === 'seed') && (
        <NestedLines
          label="Spores it wrote"
          total={sporesWritten(entry)}
          lines={entry.spores.slice(0, NESTED_SHOWN).map((spore) => ({
            key: spore.id,
            chip: sporeTypeWord(spore.observationType),
            text: sporeLine(spore),
            to: `${projectPath(spore.projectId)}/spores/${encodeURIComponent(spore.id)}`,
          }))}
        />
      )}
      {entry.kind === 'title' && produced.length > 0 && failed.length === 0 && (
        <NestedLines
          label="Sessions it titled"
          total={produced.length}
          lines={entry.titled.slice(0, NESTED_SHOWN).map((session) => ({
            key: session.sessionId,
            text: sessionHeadingText(session),
            to: `${projectPath(session.projectId)}/sessions/${encodeURIComponent(session.sessionId)}`,
          }))}
        />
      )}
      {noted !== undefined && (
        <FailureNote
          tone={failed.length > 0 ? 'bad' : 'quiet'}
          cause={failureWords(noted.failure)}
          next={failureNextStep(entry.kind, failed.length === 0)}
          {...(failed.length > 0 ? { action: { to: runAt(noted.id), label: 'Open the run' } } : {})}
        />
      )}
    </TimelineItem>
  );
}
