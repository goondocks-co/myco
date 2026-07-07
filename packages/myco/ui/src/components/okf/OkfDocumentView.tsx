import { useMemo } from 'react';
import { AlertCircle } from 'lucide-react';
import type { Components } from 'react-markdown';
import { SlideoutDetailPanel } from '../ui/slideout-detail-panel';
import { Badge } from '../ui/badge';
import { MarkdownContent } from '../ui/markdown-content';
import { useOkfDocument } from '../../hooks/use-okf';
import { formatTimeAgo } from '../../lib/format';

/** Any URL scheme prefix (http:, https:, mailto:, tel:, ...) — mirrors validate.ts's EXTERNAL_LINK_SCHEME_PATTERN. */
const EXTERNAL_LINK_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolve a markdown link's `href` to an in-bundle page path, or `null` when
 * it's external or a same-doc anchor and should render as a normal link.
 * Handles both link forms an OKF page body can carry: the canonical
 * absolute ("/"-rooted) bundle-relative form `bundleLink` always emits
 * (packages/myco/src/okf/paths.ts), and a plain relative form a hand-edited
 * page may still use — `isBundleRelativeLinkTarget` in validate.ts only
 * warns on the latter under strict validation, it doesn't forbid it.
 */
export function resolveInAppTarget(href: string | undefined, fromPath: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#') || EXTERNAL_LINK_SCHEME_PATTERN.test(trimmed)) return null;
  if (trimmed.startsWith('/')) return trimmed.slice(1);

  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const segments = fromDir === '' ? [] : fromDir.split('/');
  for (const piece of trimmed.split('/')) {
    if (piece === '' || piece === '.') continue;
    if (piece === '..') segments.pop();
    else segments.push(piece);
  }
  return segments.join('/');
}

function SkeletonDetail() {
  return (
    <div className="space-y-4">
      <div className="h-7 w-48 animate-pulse rounded bg-surface-container-high" />
      <div className="h-40 animate-pulse rounded-md bg-surface-container-high" />
    </div>
  );
}

export interface OkfDocumentViewProps {
  /** Bundle-relative path of the page to display. */
  path: string;
  /** Called with a bundle-relative path when the user clicks an in-body link to another page. */
  onNavigate: (path: string) => void;
  onClose: () => void;
}

/**
 * Slide-out detail view for one OKF document page — renders its markdown
 * body with the app's shared MarkdownContent renderer and rewrites
 * bundle-relative links to in-app navigation (onNavigate) instead of a
 * broken href / external nav. Sibling to CanopyEntryDetail: same
 * SlideoutDetailPanel shell and empty/error/loading state shape.
 */
export function OkfDocumentView({ path, onNavigate, onClose }: OkfDocumentViewProps) {
  const { data, isPending, isError, error } = useOkfDocument(path);
  const page = data?.page ?? null;

  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, ...props }) => {
        const target = resolveInAppTarget(href, path);
        if (target !== null) {
          return (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onNavigate(target);
              }}
              {...props}
            >
              {children}
            </a>
          );
        }
        return (
          <a href={href} target="_blank" rel="noreferrer" {...props}>
            {children}
          </a>
        );
      },
    }),
    [path, onNavigate],
  );

  return (
    <SlideoutDetailPanel open onClose={onClose} ariaLabel="OKF page detail" testIdRoot="okf-page-detail">
      {isPending ? (
        <SkeletonDetail />
      ) : isError ? (
        <div
          className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary"
          data-testid="okf-page-detail-error"
        >
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Failed to load page</span>
          <span className="font-sans text-xs text-on-surface-variant">
            {error instanceof Error ? error.message : 'Unknown error'}
          </span>
        </div>
      ) : !page ? (
        <div
          className="flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant"
          data-testid="okf-page-detail-empty"
        >
          <AlertCircle className="h-5 w-5 opacity-50" />
          <span className="font-sans text-sm">No page found at this path.</span>
        </div>
      ) : (
        <div className="space-y-4" data-testid="okf-page-detail">
          <div className="space-y-2">
            <h2 className="myco-display-sm text-on-surface break-words">{page.title ?? page.path}</h2>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{page.type}</Badge>
              {page.timestamp ? (
                <span className="font-mono text-xs text-on-surface-variant">{formatTimeAgo(page.timestamp)}</span>
              ) : null}
            </div>
            {page.description ? (
              <p className="font-sans text-sm text-on-surface-variant">{page.description}</p>
            ) : null}
          </div>
          <MarkdownContent content={page.body} components={components} />
        </div>
      )}
    </SlideoutDetailPanel>
  );
}
