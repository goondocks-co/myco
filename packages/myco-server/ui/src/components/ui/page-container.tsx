import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type PageContainerVariant = 'default' | 'narrow';

export interface PageContainerProps extends HTMLAttributes<HTMLDivElement> {
  variant?: PageContainerVariant;
}

// Do not add a max-width here — the sidebar/main flex is the width constraint.
const VARIANT_CLASS: Record<PageContainerVariant, string> = {
  default: 'w-full',
  narrow: 'mx-auto w-full max-w-3xl',
};

export const PageContainer = forwardRef<HTMLDivElement, PageContainerProps>(
  ({ variant = 'default', className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-col gap-6 p-6',
          VARIANT_CLASS[variant],
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);
PageContainer.displayName = 'PageContainer';
