import type { ReactNode } from 'react';
import { StatusChip, type Tone } from '../../../design';

export interface ConnectionRowProps {
  /** The row's anchor, where a link to this connection lands. */
  id?: string;
  /** What kind of connection the row is, as `data-connection`. */
  kind: 'github' | 'key' | 'telemetry';
  label: ReactNode;
  /** What it is for, in one line. */
  use: ReactNode;
  /** Whether it works, as a chip. */
  status: { words: string; tone: Tone };
  /** When that was last known, and the facts beside it. */
  note?: ReactNode;
  actions?: ReactNode;
  /** What opens under the row: a setup checklist, or how to use it. */
  children?: ReactNode;
}

/**
 * One thing Myco holds a credential for: what it is, what it is for, whether it works and since when, and its actions.
 * Stacks into one column on a phone.
 */
export function ConnectionRow({ id, kind, label, use, status, note, actions, children }: ConnectionRowProps) {
  return (
    <div id={id} className="flex scroll-mt-s6 flex-col gap-s3 px-s4 py-s4" data-connection={kind}>
      <div className="flex flex-col gap-s3 sm:flex-row sm:items-start sm:justify-between sm:gap-s6">
        <div className="flex min-w-0 flex-col gap-s1">
          <span className="t-body font-medium text-ink">{label}</span>
          <p className="max-w-measure t-small text-muted">{use}</p>
          {note != null && <div className="flex flex-col gap-s1 t-meta text-faint">{note}</div>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-s2">
          <StatusChip tone={status.tone}>{status.words}</StatusChip>
          {actions}
        </div>
      </div>
      {children}
    </div>
  );
}
