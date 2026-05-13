import { cn } from '../../lib/cn';

export type StatusTone = 'sage' | 'ochre' | 'terracotta' | 'outline';

const TONE_CLASSES: Record<StatusTone, string> = {
  sage: 'bg-primary',
  ochre: 'bg-secondary',
  terracotta: 'bg-tertiary',
  outline: 'bg-outline-variant',
};

export interface StatusDotProps {
  tone: StatusTone;
  pulse?: boolean;
  sizePx?: number;
  className?: string;
}

export function StatusDot({ tone, pulse = false, sizePx = 6, className }: StatusDotProps) {
  return (
    <span
      data-testid="status-dot"
      data-tone={tone}
      data-pulsing={pulse ? 'true' : 'false'}
      className={cn('inline-block rounded-full', TONE_CLASSES[tone], pulse && 'animate-pulse', className)}
      style={{ width: sizePx, height: sizePx }}
      aria-hidden
    />
  );
}
