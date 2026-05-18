import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { AccentSurface, type AccentSurfaceProps } from './accent-surface';
import { Eyebrow } from './eyebrow';

/*
 * Composition primitive used by every re-skinned surface in Phase 7.
 *
 * Visual: AccentSurface (top stripe) + Eyebrow above an italic serif title +
 * optional action slot on the right + body. Body padding follows v7
 * (`padding: 16px 20px` for ID-style cards, no padding for embedded lists).
 *
 *   <Panel accent="sage" eyebrow="GROVE" title="goondocks" actions={…}>
 *     <body…/>
 *   </Panel>
 */
export interface PanelProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  accent?: AccentSurfaceProps['accent'];
  eyebrow?: ReactNode;
  title?: ReactNode;
  actions?: ReactNode;
  /** When false (default) the panel pads its body; pass `padded={false}` to host an embedded list flush to the panel edge. */
  padded?: boolean;
  children?: ReactNode;
}

export const Panel = forwardRef<HTMLDivElement, PanelProps>(
  ({ accent = 'sage', eyebrow, title, actions, padded = true, className, children, ...props }, ref) => {
    const hasHeader = eyebrow != null || title != null || actions != null;
    return (
      <AccentSurface
        ref={ref}
        accent={accent}
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
              {eyebrow != null && <Eyebrow>{eyebrow}</Eyebrow>}
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
      </AccentSurface>
    );
  },
);
Panel.displayName = 'Panel';
