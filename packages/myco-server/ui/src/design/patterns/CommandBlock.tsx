import { cn } from '../../lib/cn';
import { CopyButton } from '../primitives/CopyButton';
import { focusRing } from '../lib/classes';

export interface CommandBlockProps {
  /** The exact command to run. */
  command: string;
  /** Says where to run it, as in "On the machine you want to connect". */
  caption?: string;
  className?: string;
}

/** A command in the code font with a copy button: the end of every "add a machine" or "invite" flow. */
export function CommandBlock({ command, caption, className }: CommandBlockProps) {
  return (
    <figure className={cn('flex min-w-0 flex-col gap-s2', className)}>
      {caption != null && <figcaption className="t-small text-muted">{caption}</figcaption>}
      <div className="flex items-center gap-s2 rounded-control border border-line-strong bg-page py-s1 pl-s3 pr-s1">
        {/* Focusable so a keyboard can scroll a command wider than its box. */}
        <code tabIndex={0} className={cn('min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-chip py-s1 t-mono text-ink', focusRing)}>{command}</code>
        <CopyButton value={command} label="Copy" />
      </div>
    </figure>
  );
}
