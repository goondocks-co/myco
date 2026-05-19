import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type PageContainerVariant = 'default' | 'narrow';

export interface PageContainerProps extends HTMLAttributes<HTMLDivElement> {
  variant?: PageContainerVariant;
}

/*
 * Canonical page chrome for top-to-bottom flowing surfaces (Dashboard,
 * Cortex, Grove, Groves, Skills, MachineDashboard, Team, etc.).
 *
 * `default` fills the available page width — content reflows to use the
 * space exposed when the sidebar collapses, matching Mycelium's reference
 * layout. `narrow` centers at max-w-3xl for the rare focused-task page
 * (Onboarding) where wider reading width would degrade the experience.
 *
 * Width caps and `mx-auto` were tried earlier (Phase 8 Block A) and
 * produced lopsided right-margins whenever the sidebar collapsed. The
 * sidebar/main flex layout is the width constraint; PageContainer
 * contributes side padding and rhythm only.
 */
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
