import type { BadgeProps } from '../ui/badge';

/** The observation types the harness writes, in the order the type filter offers them. */
export const OBSERVATION_TYPES = [
  'gotcha',
  'bug_fix',
  'decision',
  'discovery',
  'trade_off',
  'cross-cutting',
  'wisdom',
  'pattern',
  'architecture',
] as const;

/** The statuses a spore moves through; `active` is what a reader sees first. */
export const SPORE_STATUSES = ['active', 'superseded', 'consolidated', 'obsolete'] as const;

/** A stored snake_case or kebab-case value as a reader's label. */
export function formatLabel(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The longest one-line preview a row shows. */
export const PREVIEW_CHARS = 140;

/** The first line of an observation, trimmed of its markdown marker and cut to one row's width. */
export function sporePreview(content: string, chars: number = PREVIEW_CHARS): string {
  const line = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const bare = line.replace(/^[#>\-*\s]+/, '');
  return bare.length > chars ? `${bare.slice(0, chars)}…` : bare;
}

/** A retired spore reads quieter than a live one; a superseded one is the state a reader must notice. */
export function statusVariant(status: string): BadgeProps['variant'] {
  if (status === 'active') return 'default';
  if (status === 'superseded') return 'warning';
  if (status === 'consolidated') return 'secondary';
  return 'outline';
}

/** Tags are stored as a JSON array or as a comma list; both read as the same set here. */
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
