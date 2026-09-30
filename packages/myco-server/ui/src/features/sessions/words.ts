/**
 * The Sessions pages' words: the filters' options, the table's cells, and what
 * came of a session, in the reader's vocabulary. A run reads as what it did
 * with the session, a member by their name, and no id is ever shown.
 */
import type { FilterDefinition, SelectOption } from '../../design';
import { memberLabel } from '../../lib/member-name';
import { agentName, count, MYCO_MEMBER_ID } from '../today/words';
import type { SessionRun } from './wire';

export { agentName, clockTime, count, memberName, sporeLine, sporeTypeWord } from '../today/words';

const DAY = 86_400_000;

/** The filter keys the table holds in the URL, in the order the bar shows them. */
export const SESSION_FILTER_KEYS = ['agent', 'member', 'state', 'window'] as const;

/** Open means no end was recorded: a runtime that died never ends its session, so this is what the data says, not a liveness claim. */
export const STATE_FILTER: FilterDefinition = {
  key: 'state',
  label: 'State',
  options: [
    { value: 'all', label: 'Open or ended' },
    { value: 'open', label: 'Open' },
    { value: 'ended', label: 'Ended' },
  ],
};

/** How far back the table reaches, by when a session started. */
export const WINDOW_FILTER: FilterDefinition = {
  key: 'window',
  label: 'Started',
  options: [
    { value: 'all', label: 'Any time' },
    { value: 'today', label: 'Today' },
    { value: 'week', label: 'Past 7 days' },
    { value: 'month', label: 'Past 30 days' },
  ],
};

/** The instant a window starts at, on a day boundary so it holds still while the day lasts; undefined for any time. */
export function windowSince(window: string, now: number): number | undefined {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (window === 'today') return today;
  if (window === 'week') return today - 6 * DAY;
  if (window === 'month') return today - 29 * DAY;
  return undefined;
}

/** The agents Myco captures from, in the order the filter offers them. */
export const KNOWN_AGENTS = ['claude-code', 'codex', 'cursor', 'opencode', 'pi', 'antigravity', 'copilot', 'windsurf'] as const;

/**
 * The agent filter: every agent Myco captures from, plus any the listed rows or
 * the URL name that the list does not know, so a picked agent never vanishes.
 */
export function agentFilter(seen: readonly (string | null)[], picked: string): FilterDefinition {
  const ids = new Set<string>(KNOWN_AGENTS);
  for (const agent of [...seen, picked]) if (agent !== null && agent !== '' && agent !== 'all') ids.add(agent);
  const options: SelectOption[] = [...ids].map((id) => ({ value: id, label: agentName(id) }));
  return { key: 'agent', label: 'Agent', options: [{ value: 'all', label: 'Any agent' }, ...options] };
}

/** A member as the filter offers them: the value is the label the server matches, the words are their name. */
export interface MemberChoice {
  id: string;
  label: string | null;
}

/**
 * The member filter. The server matches a member by their label, so only a
 * member whose label names them can be offered: one whose label is only their
 * id would have to show the id. Myco's own account reads "Myco".
 */
export function memberFilter(members: readonly MemberChoice[], picked: string): FilterDefinition {
  const options: SelectOption[] = [];
  const values = new Set<string>();
  for (const member of members) {
    if (member.label === null || member.label.trim() === '') continue;
    const name = member.id === MYCO_MEMBER_ID ? 'Myco' : memberLabel(member);
    if (name === null || values.has(member.label)) continue;
    values.add(member.label);
    options.push({ value: member.label, label: name });
  }
  options.sort((a, b) => a.label.localeCompare(b.label));
  if (picked !== 'all' && !values.has(picked)) options.push({ value: picked, label: picked });
  return { key: 'member', label: 'Member', options: [{ value: 'all', label: 'Any member' }, ...options] };
}

/** How long a session ran, in words: "12 min", "3 h 5 min", "2 days". */
export function spanWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  return `${Math.round(hours / 24)} days`;
}

/** A date and time as a fact reads: "Sep 29, 14:02", with the year when it is not this one. */
export function dateTime(at: number, now: number): string {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${day}, ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
}

/** What a task of Myco's does, by the task's name. */
type TaskKind = 'learn' | 'title' | 'map' | 'seed' | 'other';

const TASK_KINDS: Readonly<Record<string, TaskKind>> = {
  'extract-curate': 'learn',
  'title-summary': 'title',
  'canopy-map': 'map',
  'vault-seed': 'seed',
};

function kindOf(task: string | null): TaskKind {
  return task === null ? 'other' : TASK_KINDS[task] ?? 'other';
}

/** What a run did with this session, in one line: the outcome it came to, or what it was for when it came to none. */
export function runHeadline(run: SessionRun): string {
  const kind = kindOf(run.task);
  const failed = run.status === 'failed';
  if (run.spores > 0) return `Myco learned ${count(run.spores, 'spore')} from it`;
  if (kind === 'title') {
    if (run.titled) return 'Myco titled it';
    if (failed) return 'Myco couldn’t title it';
    return 'Myco was asked to title it';
  }
  if (kind === 'learn' || kind === 'seed') return failed ? 'Myco couldn’t learn from it' : 'Myco learned nothing new from it';
  if (kind === 'map') return 'Myco read it while updating the code map';
  return failed ? 'A task of Myco’s failed on it' : 'A task of Myco’s worked on it';
}

/** What the run is doing now, in a word, while it has not finished; null once it has. */
export function runProgress(status: string): string | null {
  if (status === 'queued') return 'Waiting to start';
  if (status === 'running' || status === 'claimed') return 'Running now';
  return null;
}

/**
 * Whether the Deployment knows the run read the session. A run listed with no
 * read time is known only by its dispatch or by what it wrote from the session:
 * there is no record of its reading, which is not the same as its reading nothing.
 */
export function readWords(run: Pick<SessionRun, 'readAt'>, when: (at: number) => string): string {
  return run.readAt === null ? 'No record of what it read' : `Read it ${when(run.readAt)}`;
}
