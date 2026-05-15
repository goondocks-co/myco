import { cn } from '../../lib/cn';

interface QueueTileProps {
  label: string;
  value: number;
  tone: 'sage' | 'ochre' | 'terracotta' | 'outline';
  pulse?: boolean;
}

const TONE_BG: Record<QueueTileProps['tone'], string> = {
  sage: 'bg-primary/10 text-primary',
  ochre: 'bg-secondary/10 text-secondary',
  terracotta: 'bg-tertiary/10 text-tertiary',
  outline: 'bg-surface-container text-on-surface-variant',
};

export function QueueTile({ label, value, tone, pulse }: QueueTileProps) {
  return (
    <div className={cn('flex flex-col gap-1 rounded-md p-3', TONE_BG[tone])}>
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
        <span className={cn('h-2 w-2 rounded-full bg-current', pulse && 'animate-pulse')} />
        {label}
      </div>
      <div className="font-mono text-2xl tabular-nums">{value}</div>
    </div>
  );
}
