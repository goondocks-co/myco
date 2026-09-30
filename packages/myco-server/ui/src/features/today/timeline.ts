/**
 * Today's timeline: the day's sessions and Myco's work, merged newest first.
 *
 * A session sits at its start, a live one at the top. Each of Myco's runs sits
 * at the instant its outcome landed; a learning run carries the spores it wrote,
 * and a project's title runs within an hour of each other fold into one item. The
 * lede's counts are read off the same entries the list renders, so the
 * sentence and the list can never disagree.
 */
import type { OutcomeKind, TodaySession, TodaySpore, WorkRun } from './wire';

/** How recently a session with no end must have sent something to count as live. */
export const LIVE_WITHIN_MS = 30 * 60_000;
/** How close together a project's title runs must land to read as one item. */
export const TITLE_FOLD_MS = 60 * 60_000;

export interface SessionEntry {
  type: 'session';
  key: string;
  at: number;
  projectId: string;
  live: boolean;
  session: TodaySession;
}

export interface WorkEntry {
  type: 'work';
  key: string;
  at: number;
  projectId: string;
  kind: OutcomeKind;
  runs: WorkRun[];
  /** The spores these runs wrote, among those read. */
  spores: TodaySpore[];
  /** The sessions these runs titled, among the day's sessions. */
  titled: TodaySession[];
}

export type TimelineEntry = SessionEntry | WorkEntry;

export function isLive(session: Pick<TodaySession, 'endedAt' | 'lastReceivedAt'>, now: number): boolean {
  return session.endedAt === null && now - session.lastReceivedAt <= LIVE_WITHIN_MS;
}

/** When a session happened: its start where it has one, else when it first arrived. */
export function sessionAt(session: Pick<TodaySession, 'startedAt' | 'firstReceivedAt'>): number {
  return session.startedAt ?? session.firstReceivedAt;
}

export interface TimelineInput {
  sessions: readonly TodaySession[];
  runs: readonly WorkRun[];
  spores: readonly TodaySpore[];
  window: { start: number; end: number };
  now: number;
}

/** The day's entries, live sessions first, then newest first. */
export function buildTimeline({ sessions, runs, spores, window, now }: TimelineInput): TimelineEntry[] {
  const inWindow = (at: number) => at >= window.start && at < window.end;
  const sessionEntries: SessionEntry[] = sessions
    .filter((session) => inWindow(sessionAt(session)))
    .map((session) => ({
      type: 'session',
      key: `session:${session.projectId}:${session.sessionId}`,
      at: sessionAt(session),
      projectId: session.projectId,
      live: isLive(session, now),
      session,
    }));

  const byAuthor = new Map<string, TodaySpore[]>();
  for (const spore of spores) {
    if (spore.author === null) continue;
    const key = `${spore.projectId}:${spore.author}`;
    byAuthor.set(key, [...(byAuthor.get(key) ?? []), spore]);
  }
  const sessionsById = new Map(sessions.map((session) => [`${session.projectId}:${session.sessionId}`, session]));

  const workEntries: WorkEntry[] = runs
    .filter((run): run is WorkRun & { at: number } => run.at !== null && inWindow(run.at))
    .map((run) => ({
      type: 'work',
      key: `run:${run.projectId}:${run.id}`,
      at: run.at,
      projectId: run.projectId,
      kind: run.kind,
      runs: [run],
      spores: (byAuthor.get(`${run.projectId}:${run.id}`) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt),
      titled: [],
    }));

  const ordered: TimelineEntry[] = [...sessionEntries, ...workEntries].sort((a, b) => {
    const liveA = a.type === 'session' && a.live;
    const liveB = b.type === 'session' && b.live;
    if (liveA !== liveB) return liveA ? -1 : 1;
    return b.at - a.at || a.key.localeCompare(b.key);
  });

  // Title runs of one project within `TITLE_FOLD_MS` of each other fold into the newest of them.
  const merged: TimelineEntry[] = [];
  const failedTitle = (e: WorkEntry) => e.runs[0]!.result === 'failed';
  for (const entry of ordered) {
    if (entry.type === 'work' && entry.kind === 'title') {
      const group = merged.find((m): m is WorkEntry => m.type === 'work' && m.kind === 'title' && m.projectId === entry.projectId
        && failedTitle(m) === failedTitle(entry) && m.runs[m.runs.length - 1]!.at! - entry.at <= TITLE_FOLD_MS);
      if (group !== undefined) {
        group.runs.push(...entry.runs);
        continue;
      }
    }
    merged.push(entry.type === 'work' ? { ...entry, runs: [...entry.runs] } : entry);
  }
  for (const entry of merged) {
    if (entry.type !== 'work' || entry.kind !== 'title') continue;
    entry.titled = entry.runs
      .map((run) => (run.sessionId === null ? undefined : sessionsById.get(`${run.projectId}:${run.sessionId}`)))
      .filter((session): session is TodaySession => session !== undefined);
  }
  return merged;
}

/** The numbers the lede says, read off the entries the timeline renders. */
export interface LedeCounts {
  sessions: number;
  /** The Projects the day's sessions ran in, in the order they first appear. */
  sessionProjects: string[];
  /** The Projects an agent is working in right now. */
  liveProjects: string[];
  /** Spores Myco's runs wrote: learning from sessions and from the code. */
  spores: number;
  sporeProjects: string[];
  /** Myco's items the timeline lists. */
  work: number;
}

export function ledeCounts(entries: readonly TimelineEntry[]): LedeCounts {
  const sessionProjects: string[] = [];
  const liveProjects: string[] = [];
  const sporeProjects: string[] = [];
  const add = (list: string[], id: string) => { if (!list.includes(id)) list.push(id); };
  let sessions = 0;
  let spores = 0;
  let work = 0;
  for (const entry of entries) {
    if (entry.type === 'session') {
      sessions += 1;
      add(sessionProjects, entry.projectId);
      if (entry.live) add(liveProjects, entry.projectId);
      continue;
    }
    work += 1;
    if (entry.kind !== 'learn' && entry.kind !== 'seed') continue;
    const written = sporesWritten(entry);
    if (written === 0) continue;
    spores += written;
    add(sporeProjects, entry.projectId);
  }
  return { sessions, sessionProjects, liveProjects, spores, sporeProjects, work };
}

/** How many spores a work entry's runs wrote. */
export function sporesWritten(entry: WorkEntry): number {
  return entry.runs.reduce((sum, run) => sum + (run.result === 'failed' ? 0 : run.outcome.spores), 0);
}
