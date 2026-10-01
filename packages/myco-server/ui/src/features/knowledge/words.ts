/**
 * Knowledge's words: every label the stream, the article, the board and a
 * plan's page show, in the reader's vocabulary. A spore reads by its one line,
 * a status by what it means for the reader, and whoever wrote a spore by name,
 * never by id.
 */
import { OBSERVATION_TYPES } from '@goondocks/myco-shared/member-protocol';
import type { FilterDefinition, SelectOption, Tone } from '../../design';
import { memberLabel } from '../../lib/member-name';
import { count, MYCO_MEMBER_ID, shortDay, sporeTypeWord } from '../today/words';

export { ago, count, dayHeading, shortDay, sporeTypeWord } from '../today/words';

/** The spore types the harness writes, in the order the facets and filters offer them: the one list the Deployment accepts. */
export const SPORE_TYPES = OBSERVATION_TYPES;

/** A spore type in the plural, as a facet row reads: "Decisions", "Fixes". */
export function sporeTypePlural(type: string): string {
  return SPORE_TYPE_PLURALS[type] ?? `${sporeTypeWord(type)}s`;
}

const SPORE_TYPE_PLURALS: Readonly<Record<string, string>> = {
  bug_fix: 'Fixes',
  discovery: 'Discoveries',
  wisdom: 'Wisdom',
  architecture: 'Architecture',
  'cross-cutting': 'Cross-cutting',
};

/** The statuses a spore moves through, as the reader names them. */
export const SPORE_STATUS_WORDS: Readonly<Record<string, string>> = {
  active: 'Current',
  superseded: 'Replaced',
  consolidated: 'Merged',
  obsolete: 'Retired',
};

/** A spore's status in a word. */
export function sporeStatusWord(status: string): string {
  return SPORE_STATUS_WORDS[status] ?? sporeTypeWord(status);
}

/** A status other than current is a state the reader must notice before trusting the spore. */
export function sporeStatusTone(status: string): Tone {
  return status === 'superseded' ? 'warn' : 'neutral';
}

/** The status the stream opens on: what the projects hold true now. */
export const DEFAULT_SPORE_STATUS = 'active';

/** The status filter: current first, every other status one pick away. */
export const SPORE_STATUS_FILTER: FilterDefinition = {
  key: 'status',
  label: 'Status',
  options: [
    { value: 'active', label: 'Current' },
    { value: 'superseded', label: 'Replaced' },
    { value: 'consolidated', label: 'Merged' },
    { value: 'obsolete', label: 'Retired' },
    { value: 'all', label: 'Any status', short: 'Any status' },
  ],
};

/** When a spore was saved: any time, or within a recent period. */
export const SPORE_WINDOW_FILTER: FilterDefinition = {
  key: 'window',
  label: 'Saved',
  options: [
    { value: 'all', label: 'Saved any time', short: 'Any time' },
    { value: 'week', label: 'Saved in the past 7 days', short: 'Past 7 days' },
    { value: 'month', label: 'Saved in the past 30 days', short: 'Past 30 days' },
  ],
};

/** The first instant a window covers, on a day boundary so it holds still while the day lasts; null for any time. */
export function windowSince(window: string, now: number): number | null {
  const days = window === 'week' ? 6 : window === 'month' ? 29 : null;
  if (days === null) return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days);
  return start.getTime();
}

/** The type filter, for a screen too narrow for the facet list: each type the match holds, with its count, and the one picked. */
export function typeFilter(facets: Readonly<Record<string, number>> | undefined, picked: string): FilterDefinition {
  const options: SelectOption[] = typeFacetRows(facets).filter(({ type, n }) => n === undefined || n > 0 || type === picked).map(({ type, n }) => ({ value: type, label: n === undefined ? sporeTypePlural(type) : `${sporeTypePlural(type)} (${n.toLocaleString()})`, short: sporeTypePlural(type) }));
  return { key: 'type', label: 'Type', options: [{ value: 'all', label: 'Every type', short: 'Type' }, ...options] };
}

/** The types the facet list names: the known ones in their order, then any other the server counted, each with its count when known. */
export function typeFacetRows(facets: Readonly<Record<string, number>> | undefined): Array<{ type: string; n: number | undefined }> {
  const known: readonly string[] = SPORE_TYPES;
  const extra = Object.keys(facets ?? {}).filter((type) => !known.includes(type)).sort();
  return [...known, ...extra].map((type) => ({ type, n: facets === undefined ? undefined : facets[type] ?? 0 }));
}

/**
 * A spore's headline: the line written for agents, else its type and the day
 * it was saved, as in "Gotcha saved Sep 29". `lined` says which it is, so a
 * page can set the fallback apart.
 */
export function sporeHeadline(spore: { agentLine: string | null; observationType: string; createdAt: number }, now: number): { text: string; lined: boolean } {
  const line = spore.agentLine?.trim() ?? '';
  if (line !== '') return { text: line, lined: true };
  return { text: `${sporeTypeWord(spore.observationType)} saved ${shortDay(spore.createdAt, now)}`, lined: false };
}

/** The first line of a spore's body, without its Markdown marker: what a spore without its one line shows under its headline. */
export function firstLine(content: string): string {
  const line = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.replace(/^[#>\-*\s]+/, '');
}

/** Tags are stored as a JSON array or as a comma list; both read as the same set. */
export function sporeTags(tags: string | null): string[] {
  if (tags === null || tags.trim() === '') return [];
  if (tags.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(tags);
      if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter((t) => t.length > 0);
    } catch {
      // A malformed array falls through to the comma reading.
    }
  }
  return tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}

/** What wrote a spore, by the kind the server names: one of Myco's runs, a member, Myco 1.4 before an import, or an access key. */
export type SporeAuthor =
  | { kind: 'run'; runId: string }
  | { kind: 'member'; memberId: string }
  | { kind: 'imported' }
  | { kind: 'key' }
  | { kind: 'unknown' };

/** The writer of a spore from its `author` and the `authorKind` the server read it as. */
export function sporeAuthor(spore: { author: string | null; authorKind?: 'run' | 'member' | 'imported' | 'grant' | null }): SporeAuthor {
  const { author, authorKind } = spore;
  if (author === null || author === '' || authorKind == null) return { kind: 'unknown' };
  switch (authorKind) {
    case 'run': return { kind: 'run', runId: author };
    case 'member': return { kind: 'member', memberId: author };
    case 'imported': return { kind: 'imported' };
    case 'grant': return { kind: 'key' };
  }
}

/** How a spore imported from Myco 1.4 reads where its writer is named. */
export const IMPORTED_AUTHOR_WORDS = 'Imported from Myco 1.4';

/** A member who wrote a spore, by name: Myco for its own account, else their label when it names them, else null. */
export function authorName(memberId: string, members: ReadonlyArray<{ id: string; label: string | null }> | undefined): string | null {
  if (memberId === MYCO_MEMBER_ID) return 'Myco';
  const member = members?.find((m) => m.id === memberId);
  return member === undefined ? null : memberLabel(member);
}

/** The plan statuses in the order the board lays out its columns. */
export const PLAN_COLUMNS = ['in_progress', 'active', 'completed', 'abandoned'] as const;
export type PlanStatus = (typeof PLAN_COLUMNS)[number];

/** A plan's status as the reader names it. */
export const PLAN_STATUS_WORDS: Readonly<Record<string, string>> = {
  in_progress: 'In progress',
  active: 'Open',
  completed: 'Done',
  abandoned: 'Abandoned',
};

export function planStatusWord(status: string): string {
  return PLAN_STATUS_WORDS[status] ?? sporeTypeWord(status);
}

/** In progress is the one plan state the reader acts on; the rest are quiet. */
export function planStatusTone(status: string): Tone {
  return status === 'in_progress' ? 'ok' : 'neutral';
}

/** The checked and total items behind a `checked/total` progress, or null for a plan with no task list. */
export function progressParts(progress: string): { checked: number; total: number } | null {
  const match = /^(\d+)\/(\d+)$/.exec(progress);
  if (match === null) return null;
  const total = Number(match[2]);
  return total > 0 ? { checked: Number(match[1]), total } : null;
}

/** A plan's progress in words: "2 of 3 done", or null for a plan with no task list. */
export function progressWords(progress: string): string | null {
  const parts = progressParts(progress);
  return parts === null ? null : `${parts.checked} of ${count(parts.total, 'item')} done`;
}

/** What a list says when a search's cap cut it short. */
export function capNote(cap: number): string {
  return `The ${cap} best matches. Add words or a filter to narrow them.`;
}

/** A plan's heading: its title, or "Untitled plan". */
export function planTitle(plan: { title: string | null }): string {
  const title = plan.title?.trim() ?? '';
  return title === '' ? 'Untitled plan' : title;
}
