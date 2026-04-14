import { cn } from '../../lib/cn';

export interface SectionHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export function SectionHeader({ children, className }: SectionHeaderProps) {
  return (
    <div
      className={cn(
        'font-mono text-[10px] uppercase tracking-[0.22em] text-on-surface-variant',
        className,
      )}
    >
      {children}
    </div>
  );
}
