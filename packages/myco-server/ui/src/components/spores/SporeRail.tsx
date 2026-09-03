import { forwardRef, useEffect, useRef, type RefObject } from 'react';
import { AlertCircle, Sprout } from 'lucide-react';
import { Badge } from '../ui/badge';
import { DESKTOP_BREAKPOINT } from '../ui/master-detail-split';
import { Pagination } from '../ui/pagination';
import { Row } from '../ui/row';
import { Skeleton } from '../ui/skeleton';
import { Surface } from '../ui/surface';
import { useListKeyboardNav } from '../../hooks/use-list-keyboard-nav';
import { useMediaQuery } from '../../hooks/use-media-query';
import { SPORE_PAGE_SIZE, useSpores, type SporeFilters, type SporeRow } from '../../hooks/use-intelligence';
import { formatDateTime, formatRelative } from '../../lib/format';
import { formatLabel, MAX_IMPORTANCE, sporePreview, statusVariant } from './labels';

/** Rows that stand in for the rail while the list is still on its way. */
const SKELETON_ROWS = 5;

const SporeCard = forwardRef<HTMLDivElement, { spore: SporeRow; isSelected: boolean; isCursor: boolean; onOpen: () => void }>(
  function SporeCard({ spore, isSelected, isCursor, onOpen }, ref) {
    return (
      <Row ref={ref} isActive={isSelected} isCursor={isCursor} accent="sage" onClick={onOpen} aria-label={`Spore: ${sporePreview(spore.content)}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">{formatLabel(spore.observationType)}</Badge>
            {spore.status !== 'active' && <Badge variant={statusVariant(spore.status)} className="shrink-0 font-mono text-[10px]">{formatLabel(spore.status)}</Badge>}
            <span className="shrink-0 font-mono text-[10px] text-on-surface-variant" title={`Importance ${spore.importance} of ${MAX_IMPORTANCE}`}>
              {spore.importance}/{MAX_IMPORTANCE}
            </span>
          </div>
          <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-on-surface-variant" title={formatDateTime(spore.createdAt)}>
            {formatRelative(spore.createdAt)}
          </span>
        </div>
        <p className="m-0 mt-1.5 truncate font-sans text-sm leading-snug text-on-surface">{sporePreview(spore.content)}</p>
      </Row>
    );
  },
);

function SkeletonRow() {
  return (
    <div className="border-b border-[var(--ghost-border)] px-4 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-3 w-10" />
      </div>
      <Skeleton className="mt-2 h-3 w-48" />
    </div>
  );
}

export interface SporeRailProps {
  projectId: string;
  selectedId?: string;
  filters: SporeFilters;
  filterInputRef: RefObject<HTMLInputElement | null>;
  onSelect: (sporeId: string, options?: { replace?: boolean }) => void;
  onOffsetChange: (offset: number) => void;
}

/** A project's spores as rows, newest first, with the count the header names for what the filters actually asked, keyboard navigation, and a page control once the match runs past one page. */
export function SporeRail({ projectId, selectedId, filters, filterInputRef, onSelect, onOffsetChange }: SporeRailProps) {
  const spores = useSpores(projectId, filters);
  const rows = spores.data?.spores ?? [];
  const total = spores.data?.total ?? 0;
  const desktop = useMediaQuery(DESKTOP_BREAKPOINT);

  // A type or a text filter is the reader hunting; a status on its own is the shelf they are reading.
  const hunting = (filters.type ?? '') !== '' || (filters.q ?? '') !== '';
  const everyStatus = filters.status === undefined && !hunting;
  const defaultView = filters.status === 'active' && !hunting;
  const countLabel = everyStatus ? 'TOTAL' : defaultView ? 'ACTIVE' : 'MATCHING';

  // The default view holding nothing says whether the project is empty or its spores have all been retired; the count is read only in that case.
  const emptyDefault = defaultView && !spores.isPending && spores.error === null && rows.length === 0;
  const everything = useSpores(projectId, { limit: 1 }, { enabled: emptyDefault });
  const retired = everything.data?.total ?? 0;

  // First arrival on the list with nothing selected opens the top row, once per mount, on a wide screen only, and never while the reader is hunting.
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (didAutoSelect.current || !desktop || hunting || selectedId !== undefined || spores.isPending) return;
    const first = rows[0];
    if (first === undefined) return;
    didAutoSelect.current = true;
    onSelect(first.id, { replace: true });
  }, [desktop, hunting, selectedId, spores.isPending, rows, onSelect]);

  const nav = useListKeyboardNav({ items: rows, getId: (s) => s.id, selectedId, onActivate: onSelect, filterInputRef });

  const header = (
    <div className="border-b border-[var(--ghost-border)] px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="myco-eyebrow-sm">Spores</span>
        <span className="myco-display-sm text-on-surface">Observations</span>
      </div>
      <div className="inline-flex items-center gap-1.5 font-mono text-[11px] text-on-surface-variant" data-testid="spore-rail-counts">
        <span><strong className="font-semibold text-on-surface">{total.toLocaleString()}</strong> {countLabel}</span>
      </div>
    </div>
  );

  if (spores.error) {
    return (
      <div>
        {header}
        <div className="mt-4 flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">The spores could not be read</span>
          <span className="font-sans text-xs text-on-surface-variant">{spores.error.message}</span>
        </div>
      </div>
    );
  }

  return (
    <div>
      {header}
      {spores.isPending ? (
        <div role="status" aria-label="Loading spores">
          {Array.from({ length: SKELETON_ROWS }).map((_, i) => <SkeletonRow key={i} />)}
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-4 flex h-40 flex-col items-center justify-center gap-2 px-4 text-center text-on-surface-variant">
          <Sprout className="h-8 w-8 opacity-30" />
          {everyStatus && (
            <>
              <span className="font-sans text-sm">No spores yet</span>
              <span className="font-sans text-xs">Spores appear here as your sessions produce them.</span>
            </>
          )}
          {defaultView && (
            <>
              <span className="font-sans text-sm">No active spores.</span>
              {retired > 0 && (
                <span className="font-sans text-xs">
                  {retired === 1 ? '1 retired spore is' : `${retired.toLocaleString()} retired spores are`} under All.
                </span>
              )}
            </>
          )}
          {!everyStatus && !defaultView && <span className="font-sans text-sm">No spores match.</span>}
        </div>
      ) : (
        <Surface level="low" className="overflow-hidden">
          <div {...nav.containerProps} role="table" aria-label="Spores" className="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sage/40">
            {rows.map((spore, idx) => (
              <SporeCard
                key={spore.id}
                ref={nav.setRowRef(idx)}
                spore={spore}
                isSelected={selectedId === spore.id}
                isCursor={nav.cursorIndex === idx}
                onOpen={() => onSelect(spore.id)}
              />
            ))}
          </div>
        </Surface>
      )}
      <Pagination total={total} offset={filters.offset ?? 0} limit={filters.limit ?? SPORE_PAGE_SIZE} onPageChange={onOffsetChange} />
    </div>
  );
}
