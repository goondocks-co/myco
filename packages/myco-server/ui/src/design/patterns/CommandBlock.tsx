import { cn } from '../../lib/cn';
import { CopyButton } from '../primitives/CopyButton';

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
    <figure className={cn('flex flex-col gap-s2', className)}>
      {caption != null && <figcaption className="t-small text-muted">{caption}</figcaption>}
      <div className="flex items-center gap-s2 rounded-control border border-line-strong bg-page py-s1 pl-s3 pr-s1">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-s1 t-mono text-ink">{command}</code>
        <CopyButton value={command} label="Copy" />
      </div>
    </figure>
  );
}
