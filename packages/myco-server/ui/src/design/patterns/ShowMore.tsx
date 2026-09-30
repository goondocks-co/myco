import { Button } from '../primitives/Button';

export interface ShowMoreProps {
  /** How many items the list shows now. */
  shown: number;
  /** How many there are in all, when the server says. */
  total?: number;
  /** The plural noun the count names, as in "sessions". */
  noun: string;
  onMore: () => void;
  pending?: boolean;
  /** Whether another page exists; defaults to shown < total. */
  hasMore?: boolean;
}

/** The one paging pattern: a count and "Show more" at the foot of a list. */
export function ShowMore({ shown, total, noun, onMore, pending = false, hasMore }: ShowMoreProps) {
  const more = hasMore ?? (total != null && shown < total);
  const summary = total != null ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}` : `Showing ${shown.toLocaleString()} ${noun}`;
  return (
    <div className="flex items-center justify-between gap-s3 py-s3">
      <span className="t-small text-muted" aria-live="polite">{summary}</span>
      {more && <Button onClick={onMore} pending={pending}>Show more</Button>}
    </div>
  );
}
