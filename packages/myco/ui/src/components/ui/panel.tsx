import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { AccentSurface } from './accent-surface';
import { Eyebrow } from './eyebrow';

export type PanelTone = 'sage' | 'ochre' | 'terra';

export interface PanelProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: PanelTone;
  eyebrow?: ReactNode;
  title?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Pads the body. Set false when embedding a flush list. */
  padded?: boolean;
  children?: ReactNode;
}

export const Panel = forwardRef<HTMLDivElement, PanelProps>(
  ({ tone = 'sage', eyebrow, title, actions, footer, padded = true, className, children, ...props }, ref) => {
    const hasHeader = eyebrow != null || title != null || actions != null;
    return (
      <AccentSurface
        ref={ref}
        accent={tone}
        className={cn('flex flex-col', className)}
        {...props}
      >
        {hasHeader && (
          <header
            className={cn(
              'flex items-start justify-between gap-3',
              padded ? 'px-5 pt-4' : 'px-5 py-4',
            )}
          >
            <div className="flex flex-col gap-1 min-w-0">
              {eyebrow != null && <Eyebrow tone={tone}>{eyebrow}</Eyebrow>}
              {title != null && (
                <h3 className="myco-display-sm text-on-surface m-0">{title}</h3>
              )}
            </div>
            {actions != null && (
              <div className="flex items-center gap-2 shrink-0">{actions}</div>
            )}
          </header>
        )}
        {children != null && (
          <div className={cn(padded ? 'px-5 py-4' : '')}>{children}</div>
        )}
        {footer != null && (
          <footer className="border-t border-[var(--ghost-border)] px-5 py-3">
            {footer}
          </footer>
        )}
      </AccentSurface>
    );
  },
);
Panel.displayName = 'Panel';
