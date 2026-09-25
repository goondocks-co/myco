import { ATTACH_WORDS } from '../../lib/worker-state';

/** How to attach a worker, with the command set as code. */
export function AttachHint({ className }: { className?: string }) {
  return (
    <span className={className}>
      {ATTACH_WORDS.before} <code className="font-mono text-[0.95em]">{ATTACH_WORDS.command}</code> {ATTACH_WORDS.after}
    </span>
  );
}
