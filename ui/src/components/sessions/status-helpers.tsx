import { cn } from '../../lib/cn';

/* ---------- Types ---------- */

export type StatusColor = 'active' | 'completed' | 'error';

/* ---------- Helpers ---------- */

export function resolveStatusColor(status: string): StatusColor {
  if (status === 'active') return 'active';
  if (status === 'completed') return 'completed';
  return 'error';
}

export const STATUS_DOT_CLASSES: Record<StatusColor, string> = {
  active: 'bg-primary',
  completed: 'bg-secondary',
  error: 'bg-tertiary',
};

export const STATUS_BADGE_CLASSES: Record<StatusColor, string> = {
  active: 'bg-primary/15 text-primary',
  completed: 'bg-surface-container-high text-on-surface-variant',
  error: 'bg-tertiary/15 text-tertiary',
};

/* ---------- Components ---------- */

export function StatusDot({ status }: { status: string }) {
  const color = resolveStatusColor(status);
  return (
    <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', STATUS_DOT_CLASSES[color])} />
  );
}

export function StatusBadge({ status }: { status: string }) {
  const color = resolveStatusColor(status);
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-sans text-xs font-medium', STATUS_BADGE_CLASSES[color])}>
      <StatusDot status={status} />
      {label}
    </span>
  );
}
