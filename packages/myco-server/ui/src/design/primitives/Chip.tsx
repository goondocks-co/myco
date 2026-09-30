import { type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

const TONE: Record<Tone, string> = {
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  bad: 'bg-bad-bg text-bad',
  neutral: 'bg-surface-3 text-ink-2',
};

const chipBase = 'inline-flex h-[22px] shrink-0 items-center gap-s1 whitespace-nowrap rounded-chip px-s2 t-meta font-medium';

export interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  children: ReactNode;
}

/** A state in a word: Live, Failed, Queued, "held off". The tone marks the state; the word carries it. */
export function StatusChip({ tone = 'neutral', className, ...props }: StatusChipProps) {
  return <span className={cn(chipBase, TONE[tone], className)} {...props} />;
}

export interface TypeChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** The type in words: Decision, Gotcha, Fix. */
  children: ReactNode;
}

/** A spore's type. Always quiet and neutral: types are not states, so they carry no accent. */
export function TypeChip({ className, ...props }: TypeChipProps) {
  return <span className={cn(chipBase, TONE.neutral, className)} {...props} />;
}

/** A keyboard key, as in "⌘K". */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cn('inline-flex h-[20px] items-center rounded-chip border border-line-strong bg-surface-2 px-s1 t-meta font-medium text-muted', className)} {...props} />;
}
