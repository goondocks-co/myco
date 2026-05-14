import { cn } from '../../lib/cn';

export interface EmptyDetailHintProps {
  /** Message shown to the user, e.g. "Select a session" */
  message: string;
  className?: string;
}

export function EmptyDetailHint({ message, className }: EmptyDetailHintProps) {
  return (
    <div
      className={cn(
        'flex h-full w-full items-center justify-center text-on-surface-variant',
        className,
      )}
    >
      <span className="font-sans text-sm">{message}</span>
    </div>
  );
}
