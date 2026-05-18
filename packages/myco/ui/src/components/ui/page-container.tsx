import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type PageContainerVariant = 'default' | 'narrow';

export interface PageContainerProps extends HTMLAttributes<HTMLDivElement> {
  variant?: PageContainerVariant;
}

const VARIANT_WIDTH: Record<PageContainerVariant, string> = {
  default: 'max-w-7xl',
  narrow: 'max-w-3xl',
};

export const PageContainer = forwardRef<HTMLDivElement, PageContainerProps>(
  ({ variant = 'default', className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-col gap-6 p-6 mx-auto w-full',
          VARIANT_WIDTH[variant],
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
