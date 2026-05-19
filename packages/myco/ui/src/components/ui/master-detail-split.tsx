import { type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useMediaQuery } from '../../hooks/use-media-query';
import { cn } from '../../lib/cn';

const DESKTOP_BREAKPOINT = '(min-width: 768px)';
const DEFAULT_RAIL_MIN = 240;
const DEFAULT_RAIL_MAX = 360;

export interface MasterDetailSplitProps {
  master: ReactNode;
  detail: ReactNode;
  hasSelection: boolean;
  onCloseMobileDetail?: () => void;
  railMinWidthPx?: number;
  railMaxWidthPx?: number;
  className?: string;
  /** Accessible label for the master/rail landmark. Defaults to "List". */
  masterAriaLabel?: string;
  /** Accessible label for the detail landmark. Defaults to "Details". */
  detailAriaLabel?: string;
}

export function MasterDetailSplit({
  master,
  detail,
  hasSelection,
  onCloseMobileDetail,
  railMinWidthPx = DEFAULT_RAIL_MIN,
  railMaxWidthPx = DEFAULT_RAIL_MAX,
  className,
  masterAriaLabel = 'List',
  detailAriaLabel = 'Details',
}: MasterDetailSplitProps) {
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT);

  if (!isDesktop) {
    if (hasSelection) {
      return (
        <section
          role="region"
          aria-label={detailAriaLabel}
          className={cn('flex h-full w-full flex-col', className)}
        >
          {onCloseMobileDetail && (
            <button
              type="button"
              onClick={onCloseMobileDetail}
              className="sticky top-0 z-10 flex items-center gap-1 border-b border-outline-variant/20 bg-surface-container px-3 py-2 text-sm text-on-surface-variant hover:bg-surface-container-high"
            >
              <ChevronLeft className="h-4 w-4" />
              <span>Back</span>
            </button>
          )}
          <div className="flex-1 overflow-y-auto p-6">{detail}</div>
        </section>
      );
    }
    return (
      <section
        role="region"
        aria-label={masterAriaLabel}
        className={cn('h-full w-full overflow-y-auto', className)}
      >
        {master}
      </section>
    );
  }

  return (
    <div className={cn('flex h-full w-full', className)}>
      <aside
        aria-label={masterAriaLabel}
        className="flex-shrink-0 overflow-y-auto border-r border-outline-variant/20"
        style={{
          minWidth: railMinWidthPx,
          maxWidth: railMaxWidthPx,
          width: `clamp(${railMinWidthPx}px, 30vw, ${railMaxWidthPx}px)`,
        }}
      >
        {master}
      </aside>
      {/* Detail padding lives on the primitive so every consumer gets the
          same gutter between the rail divider and the content body. Without
          it, callers like Agent's RunDetail butted against the divider
          while Sessions' SessionDetail (which used to wrap itself in p-6)
          had breathing room — the resulting spacing mismatch was a real
          Phase 8 review finding. */}
      <section aria-label={detailAriaLabel} className="flex-1 overflow-y-auto p-6">
        {detail}
      </section>
    </div>
  );
}
