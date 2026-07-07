import { useMemo, useState } from 'react';
import { AlertCircle, FileText } from 'lucide-react';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { useOkfDocuments, type OkfPageSummary } from '../../hooks/use-okf';
import { formatTimeAgo } from '../../lib/format';
import { OkfDocumentView } from './OkfDocumentView';
import { cn } from '../../lib/cn';

/* ---------- Helpers ---------- */

function pageTitle(page: OkfPageSummary): string {
  return page.title && page.title.trim() !== '' ? page.title : page.path;
}

interface PageGroup {
  type: string;
  pages: OkfPageSummary[];
}

/**
 * Group pages by `type` (headings sorted), pages within a group sorted by
 * title then path — mirrors `generateDirectoryIndexes`'s grouping model
 * (packages/myco/src/okf/indexes.ts), the canonical "section" the OKF
 * bundle itself organizes around.
 */
function groupPagesByType(pages: OkfPageSummary[]): PageGroup[] {
  const groups = new Map<string, OkfPageSummary[]>();
  for (const page of pages) {
    const bucket = groups.get(page.type);
    if (bucket) bucket.push(page);
    else groups.set(page.type, [page]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([type, groupPages]) => ({
      type,
      pages: [...groupPages].sort((a, b) => {
        const byTitle = pageTitle(a).localeCompare(pageTitle(b));
        return byTitle !== 0 ? byTitle : a.path.localeCompare(b.path);
      }),
    }));
}

/* ---------- Sub-components ---------- */

function SkeletonRow() {
  return <div className="h-12 rounded-md bg-surface-container-high animate-pulse" />;
}

function PageRow({
  page,
  selected,
  onClick,
}: {
  page: OkfPageSummary;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-all duration-150',
        'hover:bg-surface-container/60 hover:shadow-[inset_3px_0_0_var(--primary)]',
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
        selected && 'bg-primary/5 shadow-[inset_3px_0_0_var(--primary)]',
      )}
      aria-current={selected}
      data-testid={`okf-page-row-${page.path}`}
    >
      <div className="min-w-0">
        <div className="font-sans text-sm text-on-surface truncate">{pageTitle(page)}</div>
        {page.description ? (
          <div className="font-sans text-xs text-on-surface-variant truncate">{page.description}</div>
        ) : null}
      </div>
      <span className="shrink-0 font-mono text-xs text-on-surface-variant">
        {page.timestamp ? formatTimeAgo(page.timestamp) : '—'}
      </span>
    </button>
  );
}

/* ---------- Component ---------- */

/**
 * Master/detail surface for the OKF knowledge bundle — the primary content
 * of the OKF page (Task 5.2 wires this into the full page layout). The list
 * groups pages by section/type and always renders full width; selecting a
 * row reveals a right-side slide-out detail panel with the rendered
 * markdown. Modeled on CanopyEntriesPanel — same layout/interaction idiom.
 */
export function OkfBrowser() {
  const { data, isLoading, isError, error } = useOkfDocuments();
  const [selectedPath, setSelectedPath] = useState<string | undefined>();

  const groups = useMemo(() => groupPagesByType(data?.pages ?? []), [data?.pages]);

  if (isError) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
        <AlertCircle className="h-5 w-5" />
        <span className="font-sans text-sm">Failed to load OKF pages</span>
        <span className="font-sans text-xs text-on-surface-variant">
          {error instanceof Error ? error.message : 'Unknown error'}
        </span>
      </div>
    );
  }

  return (
    <div className="relative space-y-6">
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div
          className="flex h-48 flex-col items-center justify-center gap-3 text-on-surface-variant"
          data-testid="okf-browser-empty"
        >
          <FileText className="h-10 w-10 opacity-20" />
          <span className="font-sans text-sm">No pages published yet.</span>
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.type} className="space-y-2">
            <SectionHeader>{group.type}</SectionHeader>
            <Surface level="low" className="rounded-md divide-y divide-[var(--ghost-border)] overflow-hidden">
              {group.pages.map((page) => (
                <PageRow
                  key={page.path}
                  page={page}
                  selected={page.path === selectedPath}
                  onClick={() => setSelectedPath(page.path)}
                />
              ))}
            </Surface>
          </div>
        ))
      )}

      {selectedPath ? (
        <OkfDocumentView
          path={selectedPath}
          onNavigate={setSelectedPath}
          onClose={() => setSelectedPath(undefined)}
        />
      ) : null}
    </div>
  );
}
