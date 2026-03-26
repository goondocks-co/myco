import { cn } from '../../lib/cn';

export interface SectionHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export function SectionHeader({ children, className }: SectionHeaderProps) {
  return (
    <div className={cn('font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant', className)}>
      {children}
    </div>
  );
}
