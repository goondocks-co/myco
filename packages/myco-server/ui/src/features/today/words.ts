/**
 * Today's words: every sentence the page shows, built from the numbers the
 * server answers. Nothing here names a mechanism or shows an id; a run reads
 * as what it produced, a machine by its name, and the account Myco's own work
 * signs in as reads "Myco".
 */
import { REPOSITORY_CHECKOUT_CAPABILITY, REPOSITORY_DIGESTS_CAPABILITY } from '@goondocks/myco-shared/repository';
import { harnessLabel } from '../../lib/harness';
import { memberLabel } from '../../lib/member-name';
import { HEALTH_ANCHORS, HEALTH_PATH, PROJECT_SETTINGS_ANCHORS, PROJECT_SETTINGS_SUFFIX, projectPath, runPath } from '../../routes/nav';
import type { AttentionItem, AttentionKind, CaptureRow, HeldState, OutcomeKind, TodaySession, TodaySpore, UncapturedReason, UncapturedRootItem, WorkRun } from './wire';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The member every run Myco dispatches signs in as. It is Myco, never a person. */
export const MYCO_MEMBER_ID: typeof import('../../../../src/constants').HARNESS_MEMBER_ID = 'mem_harness';

/** "1 spore", "3 spores". */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

/** A list in prose: "A", "A and B", "A, B and C". */
export function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The time of day on the 24-hour clock: "09:39". */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** A day as its heading reads: "Tuesday, September 29", with the year when it is not this one. */
export function dayHeading(at: number, now: number): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** How long ago, in words a person says: "just now", "4 min ago", "4 h ago", "yesterday", "3 days ago". */
export function ago(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} min ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} h ago`;
  const days = Math.floor(delta / DAY);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** An instant as "at 09:39" today, "yesterday at 23:05", else "on Sep 24". */
export function when(at: number, now: number): string {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (at >= startOfToday.getTime()) return `at ${clockTime(at)}`;
  if (at >= startOfToday.getTime() - DAY) return `yesterday at ${clockTime(at)}`;
  return `on ${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/**
 * When something that started before the period on screen began, as "since"
 * words: "since 09:12" today, "since yesterday 21:40", else "since Sep 24, 21:40".
 */
export function sinceWords(at: number, now: number): string {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (at >= startOfToday.getTime()) return `since ${clockTime(at)}`;
  if (at >= startOfToday.getTime() - DAY) return `since yesterday ${clockTime(at)}`;
  return `since ${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${clockTime(at)}`;
}

/** A day as a short date: "Sep 12", with the year when it is not this one. */
export function shortDay(at: number, now: number): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** An instant with its day when that is not today: "at 09:39", "yesterday at 23:05", "on Sep 24 at 21:40". */
export function whenWithTime(at: number, now: number): string {
  const said = when(at, now);
  return said.startsWith('on ') ? `${said} at ${clockTime(at)}` : said;
}

/** An agent as a person reads it; a session that names none reads "An agent". */
export function agentName(agent: string | null): string {
  if (agent === null || agent === '') return 'An agent';
  return AGENT_NAMES[agent] ?? harnessLabel(agent);
}

/** Agents the harness table does not name. */
const AGENT_NAMES: Readonly<Record<string, string>> = { pi: 'Pi' };

/** Who ran a session: Myco for its own runs, else the member's name, else nobody named; never a member's id. */
export function memberName(session: Pick<TodaySession, 'memberId' | 'memberLabel'>): string | null {
  if (session.memberId === MYCO_MEMBER_ID) return 'Myco';
  if (session.memberId === null) return null;
  return memberLabel({ id: session.memberId, label: session.memberLabel });
}

/** A spore's type in one word, as its chip reads. */
export function sporeTypeWord(type: string): string {
  return SPORE_TYPE_WORDS[type] ?? type.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

const SPORE_TYPE_WORDS: Readonly<Record<string, string>> = {
  gotcha: 'Gotcha',
  bug_fix: 'Fix',
  decision: 'Decision',
  discovery: 'Discovery',
  trade_off: 'Trade-off',
  'cross-cutting': 'Cross-cutting',
  wisdom: 'Wisdom',
  pattern: 'Pattern',
  architecture: 'Architecture',
};

/** A spore's one line: the line written for agents, else the first line of its body. */
export function sporeLine(spore: Pick<TodaySpore, 'agentLine' | 'content'>): string {
  if (spore.agentLine !== null && spore.agentLine.trim() !== '') return spore.agentLine.trim();
  const first = spore.content.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  return first.replace(/^[#>\-*\s]+/, '');
}

/** What a group of Myco's runs produced, as the timeline item's headline. */
export function workHeadline(kind: OutcomeKind, runs: readonly WorkRun[]): string {
  const produced = runs.filter((run) => run.result !== 'failed');
  if (produced.length === 0) return FAILED_HEADLINE[kind](runs.length);
  const spores = produced.reduce((sum, run) => sum + run.outcome.spores, 0);
  const sessions = produced.reduce((sum, run) => sum + run.outcome.sessions, 0);
  switch (kind) {
    case 'learn': return `Myco learned ${count(spores, 'spore')}${sessions > 0 ? ` from ${count(sessions, 'session')}` : ''}`;
    case 'seed': return `Myco learned ${count(spores, 'spore')} from the project’s code and history`;
    case 'title': return `Myco titled ${count(Math.max(sessions, produced.length), 'session')}`;
    case 'map': return 'Myco updated the code map';
  }
}

const FAILED_HEADLINE: Readonly<Record<OutcomeKind, (runs: number) => string>> = {
  learn: () => 'Myco couldn’t learn from recent sessions',
  seed: () => 'Myco couldn’t learn from the project’s code',
  title: (runs) => (runs === 1 ? 'Myco couldn’t title a session' : `Myco couldn’t title ${count(runs, 'session')}`),
  map: () => 'Myco couldn’t update the code map',
};

/** What to do about a run that failed, by what it was for and whether it kept anything. */
export function failureNextStep(kind: OutcomeKind, keptOutput: boolean): string {
  if (keptOutput) return 'What it saved is kept, so there’s nothing to do.';
  return NEXT_STEP[kind];
}

const NEXT_STEP: Readonly<Record<OutcomeKind, string>> = {
  learn: 'Myco tries again with the next sessions. If this keeps happening, open the run to see where it stopped.',
  seed: 'Nothing was saved. Open the run to see where it stopped, then run it again.',
  title: 'The session keeps its first prompt as its name, and Myco tries again later.',
  map: 'Open the run to see where it stopped.',
};

/** The cause of a failure as the rest of a sentence after "Why:", ending in a full stop. */
export function causeSentence(cause: string): string {
  const trimmed = cause.trim().replace(/\s+/g, ' ');
  if (trimmed === '') return 'no cause was recorded.';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Where a piece of work ran, one rule for every page. The server names a
 * machine only to the member it belongs to, so a name is always the viewer's
 * own machine: "on sirkirby-mbp". The viewer's own machine with no name reads
 * "on your machine", never the viewer's own name. Another member's machine
 * reads as theirs: "from Lin". `machine` is the same fact as a noun, for a
 * facts row or a failure note; `own` says it is the viewer's. Null when
 * neither a name nor a member is known;
 * never a machine's id.
 */
export function workPlace(
  machineName: string | null | undefined,
  member: { id: string; label: string | null } | null | undefined,
  viewerId: string | null,
): { line: string; machine: string; own: boolean } | null {
  const named = machineName?.trim() ?? '';
  if (named !== '') return { line: `on ${named}`, machine: named, own: true };
  if (member == null) return null;
  if (viewerId !== null && member.id === viewerId) return { line: 'on your machine', machine: 'Your machine', own: true };
  const who = member.id === MYCO_MEMBER_ID ? 'Myco' : memberLabel(member);
  return who === null ? null : { line: `from ${who}`, machine: `${who}’s machine`, own: false };
}

/**
 * A machine as the capture panel names it. The server names a machine only to
 * the member it belongs to; to anyone else a machine reads as its member's
 * name ("Lin", and Myco's own runtime "Myco"). A second unnamed machine of the
 * same member reads "Lin, another machine". The viewer's own machine with no
 * name reads "Your machine", never the viewer's name. Only a machine with neither a name
 * nor a member that has a name reads "A machine" (numbered when there are more).
 * Never the machine's id.
 */
export function machineNames(rows: readonly Pick<CaptureRow, 'machineId' | 'machineName' | 'member'>[], viewerId: string | null = null): Map<string, string> {
  const named = (row: Pick<CaptureRow, 'machineName'>) => row.machineName !== null && row.machineName.trim() !== '';
  const owner = (row: Pick<CaptureRow, 'member'>) => (row.member === null ? null : row.member.id === viewerId ? 'Your machine' : memberLabel(row.member));
  const anonymous = [...new Set(rows.filter((row) => !named(row) && owner(row) === null).map((row) => row.machineId))];
  const names = new Map<string, string>();
  const perMember = new Map<string, number>();
  for (const row of rows) {
    if (names.has(row.machineId)) continue;
    const who = owner(row);
    if (named(row)) names.set(row.machineId, row.machineName!.trim());
    else if (who !== null) {
      const seen = perMember.get(who) ?? 0;
      perMember.set(who, seen + 1);
      names.set(row.machineId, seen === 0 ? who : who === 'Your machine' ? 'Another of your machines' : `${who}, another machine`);
    } else names.set(row.machineId, anonymous.length === 1 ? 'A machine' : `Machine ${anonymous.indexOf(row.machineId) + 1}`);
  }
  return names;
}

/** The words of one "Needs you" item. `projectName` names a Project by id, or null when the dashboard does not know it. */
export interface NeedsYouWords {
  title: string;
  detail: string;
  action: { label: string; to: string } | null;
}

/** A part of Health, by its anchor. */
const healthAt = (anchor: string): string => `${HEALTH_PATH}#${anchor}`;

export function attentionWords(item: AttentionItem, now: number, projectName: (projectId: string) => string | null): NeedsYouWords {
  const inProject = (projectId: string) => {
    const name = projectName(projectId);
    return name === null ? 'In a project you can’t see here.' : `In ${name}.`;
  };
  switch (item.kind) {
    case 'backup_overdue':
      return {
        title: item.lastBackupAt === null ? 'No backup has completed yet' : `Last backup was ${ago(item.lastBackupAt, now)}`,
        detail: `Backups are set to run ${everyHours(item.intervalHours)}${item.lastBackupAt === null ? '.' : `; none has completed since ${new Date(item.lastBackupAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.`}`,
        action: { label: 'Open backups', to: healthAt(HEALTH_ANCHORS.backups) },
      };
    case 'outcome_failed':
      return {
        title: item.failures === 1 ? `${OUTCOME_NOUN[item.outcome]} failed` : `${count(item.failures, OUTCOME_UPDATE[item.outcome])} failed`,
        detail: `${inProject(item.projectId)} Nothing has succeeded since the first failure ${when(item.since, now)}.`,
        action: { label: 'See the last attempt', to: runPath(item.projectId, item.runId) },
      };
    case 'search_index_behind': {
      const since = item.pendingSince ?? item.failingSince;
      return {
        title: 'Search is falling behind',
        detail: item.pendingBlobs > 0
          ? `${count(item.pendingBlobs, 'item')} ${item.pendingBlobs === 1 ? 'is' : 'are'} waiting to be searchable${since === null ? '' : ` since ${clockOrDay(since, now)}`}. Search still answers; new work takes longer to appear.`
          : `Its updates have failed${since === null ? '' : ` since ${clockOrDay(since, now)}`}. Search still answers; new work takes longer to appear.`,
        action: { label: 'Open Health', to: healthAt(HEALTH_ANCHORS.upkeep) },
      };
    }
    case 'transcripts_stopped':
      return {
        title: `${count(item.transcripts, 'transcript')} couldn’t be read`,
        detail: `${inProject(item.projectId)} Their sessions are missing what the transcript held.`,
        action: { label: 'Open Health', to: healthAt(HEALTH_ANCHORS.status) },
      };
    case 'runs_held_for_capability':
      return {
        title: `${count(item.runs, 'task')} ${item.runs === 1 ? 'is' : 'are'} waiting for a machine`,
        detail: `${HOLD_WORDS[item.capability] ?? 'No machine heard from lately can run them.'} Waiting since ${clockOrDay(item.since, now)}.`,
        action: { label: 'Open Health', to: healthAt(HEALTH_ANCHORS.workers) },
      };
    case 'no_worker':
      return {
        title: 'No machine is running Myco’s work',
        detail: `${count(item.runs, 'task')} ${item.runs === 1 ? 'is' : 'are'} waiting${item.since === null ? '' : ` since ${clockOrDay(item.since, now)}`}. ${item.lastContactAt === null ? 'No machine has checked in yet.' : `A machine last checked in ${ago(item.lastContactAt, now)}.`}`,
        action: { label: 'Open Health', to: healthAt(HEALTH_ANCHORS.workers) },
      };
    case 'access_key_expiring':
      return {
        title: `${item.label === null ? 'An access key' : `Access key “${item.label}”`} expires ${inDays(item.expiresAt, now)}`,
        detail: `${inProject(item.projectId)} Whatever uses it stops working then.`,
        action: { label: 'Open access keys', to: `${projectPath(item.projectId, PROJECT_SETTINGS_SUFFIX)}#${PROJECT_SETTINGS_ANCHORS.accessKeys}` },
      };
    case 'schema_mismatch':
      return {
        title: 'The server and its database disagree',
        detail: item.found === null
          ? 'The database doesn’t say which version it holds, so some pages may fail.'
          : `The database holds version ${item.found}; this server expects ${item.expected}. Some pages may fail until they match.`,
        action: { label: 'Open Health', to: healthAt(HEALTH_ANCHORS.status) },
      };
  }
}

/** How many days a machine keeps what its agents do in a repository it is not capturing yet. */
export const HELD_DAYS = 7;

/** The machine a repository sits on, as the viewer reads it: theirs by its name, anyone else's by its member. */
export function repositoryMachine(item: Pick<UncapturedRootItem, 'machineName' | 'member'>, viewerId: string | null): string {
  if (item.member.id === viewerId) return item.machineName !== null && item.machineName.trim() !== '' ? item.machineName.trim() : 'your machine';
  const who = memberLabel(item.member);
  return who === null ? 'a member’s machine' : `${who}’s machine`;
}

const REASON_WORDS: Readonly<Record<UncapturedReason, (machine: string) => string>> = {
  outside_folders: (machine) => `It’s outside the folders ${machine} captures.`,
  no_remote: () => 'It has no git remote, so Myco can’t tell which project it belongs to.',
  auto_create_off: () => 'No project holds it yet, and only an admin can start a new one.',
  archived: () => 'The project it belongs to is archived.',
  refused: () => 'Myco couldn’t add it to a project.',
};

const HELD_WORDS: Readonly<Record<HeldState, (machine: string) => string>> = {
  held: (machine) => `What agents do there is kept on ${machine} for ${HELD_DAYS} days, and arrives once it’s connected.`,
  full: (machine) => `${capitalized(machine)} has kept all it can; newer work there isn’t being kept.`,
  expired: () => `Work there older than ${HELD_DAYS} days wasn’t kept.`,
};

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** One repository a member's machine is not capturing yet: what it is, why, what its machine keeps meanwhile, and when its machine last met it. */
export interface RepositoryWords {
  title: string;
  detail: string;
  held: string;
  seen: string;
  /** A machine still keeping everything is a warning; one that has stopped keeping anything new is losing work. */
  tone: 'warn' | 'bad';
}

export function repositoryWords(item: UncapturedRootItem, now: number, viewerId: string | null): RepositoryWords {
  const machine = repositoryMachine(item, viewerId);
  return {
    title: `${item.label} isn’t being captured yet`,
    detail: REASON_WORDS[item.reason](machine),
    held: HELD_WORDS[item.held](machine),
    seen: `${count(item.misses, 'session')} on ${machine} so far, most recently ${ago(item.lastSeenAt, now)}.`,
    tone: item.held === 'held' ? 'warn' : 'bad',
  };
}

/** What each attention check reads, for the line naming the checks that could not be read. */
export const ATTENTION_CHECKS: Readonly<Record<AttentionKind, string>> = {
  backup_overdue: 'backups',
  outcome_failed: 'Myco’s work',
  search_index_behind: 'search',
  transcripts_stopped: 'transcripts',
  runs_held_for_capability: 'waiting tasks',
  no_worker: 'machines',
  access_key_expiring: 'access keys',
  schema_mismatch: 'the database',
};

const OUTCOME_NOUN: Readonly<Record<OutcomeKind, string>> = {
  learn: 'Learning from sessions',
  seed: 'Learning from the code',
  title: 'Titling a session',
  map: 'A code map update',
};

const OUTCOME_UPDATE: Readonly<Record<OutcomeKind, string>> = {
  learn: 'learning attempt',
  seed: 'attempt to learn from the code',
  title: 'titling attempt',
  map: 'code map update',
};

const HOLD_WORDS: Readonly<Record<string, string>> = {
  [REPOSITORY_CHECKOUT_CAPABILITY]: 'They need a machine that can read the repository, and none heard from lately can.',
  [REPOSITORY_DIGESTS_CAPABILITY]: 'They need an up-to-date machine; the machines heard from lately are too old to run them.',
};

function everyHours(hours: number): string {
  if (hours % 24 === 0) return hours === 24 ? 'every day' : `every ${hours / 24} days`;
  return hours === 1 ? 'every hour' : `every ${hours} hours`;
}

function clockOrDay(at: number, now: number): string {
  return when(at, now).replace(/^at /, '');
}

function inDays(at: number, now: number): string {
  const days = Math.ceil((at - now) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}
