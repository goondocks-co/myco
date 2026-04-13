import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-[28px] border border-[rgba(255,231,208,0.11)] bg-[linear-gradient(180deg,rgba(36,22,17,0.94),rgba(20,12,9,0.94))] shadow-[0_20px_60px_rgba(0,0,0,0.28)]',
        className,
      )}
      {...props}
    />
  );
}
