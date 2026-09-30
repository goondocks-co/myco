import { cn } from '../../lib/cn';

export type HealthTone = 'ok' | 'warn' | 'bad' | 'faint';

const TONE: Record<HealthTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  faint: 'bg-faint',
};

export interface HealthDotProps {
  tone: HealthTone;
  /** What the dot means, in words. Status is never shown by colour alone. */
  label: string;
  /** Shows the label beside the dot instead of only to assistive technology. */
  showLabel?: boolean;
  /** A soft halo for something live right now. */
  live?: boolean;
  className?: string;
}

/** Recency and health in one dot: ok, warn, bad, or faint for nothing recent. */
export function HealthDot({ tone, label, showLabel = false, live = false, className }: HealthDotProps) {
  const dot = (
    <span
      data-tone={tone}
      data-live={live || undefined}
      className={cn(
        'inline-block size-s2 shrink-0 rounded-pill',
        TONE[tone],
        live && 'shadow-[0_0_0_3px_var(--ok-bg)] motion-safe:animate-pulse',
      )}
      {...(showLabel ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    />
  );
  if (!showLabel) return <span className={cn('inline-flex items-center', className)}>{dot}</span>;
  return (
    <span className={cn('inline-flex items-center gap-s2 t-small text-ink-2', className)}>
      {dot}
      {label}
    </span>
  );
}
