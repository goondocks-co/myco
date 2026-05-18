import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { AccentSurface, type AccentSurfaceProps } from './accent-surface';
import { Eyebrow } from './eyebrow';

export type PanelTone = 'sage' | 'ochre' | 'terra';

export interface PanelProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  accent?: AccentSurfaceProps['accent'];
  /** Semantic shorthand: sets accent and tunes the eyebrow swatch. */
  tone?: PanelTone;
  eyebrow?: ReactNode;
  title?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** When false (default true) the panel pads its body; pass `padded={false}` to host an embedded list flush to the panel edge. */
  padded?: boolean;
  children?: ReactNode;
}

const TONE_TO_EYEBROW: Record<PanelTone, 'sage' | 'ochre' | 'default'> = {
  sage: 'sage',
  ochre: 'ochre',
  terra: 'default',
};

export const Panel = forwardRef<HTMLDivElement, PanelProps>(
  ({ accent, tone, eyebrow, title, actions, footer, padded = true, className, children, ...props }, ref) => {
    const resolvedAccent = tone ?? accent ?? 'sage';
    const eyebrowTone = tone ? TONE_TO_EYEBROW[tone] : undefined;
    const hasHeader = eyebrow != null || title != null || actions != null;
    return (
      <AccentSurface
        ref={ref}
        accent={resolvedAccent}
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
              {eyebrow != null && <Eyebrow tone={eyebrowTone}>{eyebrow}</Eyebrow>}
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
          <footer
            className={cn(
              'border-t border-[var(--ghost-border)]',
              padded ? 'px-5 py-3' : 'px-5 py-3',
            )}
          >
            {footer}
          </footer>
        )}
      </AccentSurface>
    );
  },
);
Panel.displayName = 'Panel';
