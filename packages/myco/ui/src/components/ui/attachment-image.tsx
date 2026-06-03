/**
 * Reusable attachment image rendering.
 *
 * Attachment bytes are served by a URL-scoped, bearer-token-gated daemon route
 * (`/api/g/:groveId/p/:projectId/attachments/:file`). A bare `<img src>` can't
 * send the `x-myco-auth` header, so we fetch the bytes with the token and render
 * a blob object URL instead. `AttachmentImage` is the single place that does
 * this — use it anywhere attachments are shown (prompt batches today, other
 * surfaces later). The `useAttachmentObjectUrls` hook exposes the same
 * resolution for callers that need raw URLs (e.g. the lightbox).
 */
import { useEffect, useState } from 'react';
import { withBasePath } from '../../lib/base-path';
import { useProjectSelection } from '../../hooks/use-project-selection';
import type { ProjectSelection } from '../../lib/selection';

/**
 * Daemon-issued bearer token, injected into index.html as `window.__MYCO_AUTH__`.
 * Read directly (not via lib/api) so this component carries no dependency on the
 * JSON api surface — many tests fully mock lib/api, and coupling here would force
 * every one of them to stub an export they never use.
 */
function daemonAuthToken(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const token = (window as unknown as { __MYCO_AUTH__?: string }).__MYCO_AUTH__;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * Fetch a bearer-token-gated daemon resource and return a blob object URL. A
 * bare `<img src>` can't send `x-myco-auth`, so attachments are fetched and
 * streamed into a blob. The caller owns the URL's lifecycle.
 */
async function fetchObjectUrl(path: string): Promise<string> {
  const headers = new Headers();
  const token = daemonAuthToken();
  if (token) headers.set('x-myco-auth', token);
  const res = await fetch(path, { headers });
  if (!res.ok) throw new Error(`resource fetch failed: ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

/**
 * Build the daemon URL for an attachment. The (Grove, project) scope is carried
 * in the URL path because subresource loads can't attach tenancy headers; falls
 * back to the legacy unscoped path only when no project selection is active.
 */
export function attachmentUrl(filePath: string, selection: ProjectSelection | null): string {
  if (selection) {
    return withBasePath(
      `/api/g/${selection.grove.id}/p/${selection.project.project_id}/attachments/${filePath}`,
    );
  }
  return withBasePath(`/api/attachments/${filePath}`);
}

/**
 * Resolve attachment file paths to authed blob object URLs, revoking them on
 * change/unmount. Returns `null` per slot while loading or on failure.
 */
export function useAttachmentObjectUrls(filePaths: string[]): (string | null)[] {
  const selection = useProjectSelection();
  const [urls, setUrls] = useState<(string | null)[]>(() => filePaths.map(() => null));
  // Re-resolve when the set of paths or the active scope changes.
  const key = `${selection?.grove.id ?? ''}|${selection?.project.project_id ?? ''}|${filePaths.join('|')}`;

  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    setUrls(filePaths.map(() => null));
    Promise.all(
      filePaths.map((fp) =>
        fetchObjectUrl(attachmentUrl(fp, selection))
          .then((url) => {
            created.push(url);
            return url;
          })
          .catch(() => null),
      ),
    ).then((resolved) => {
      if (cancelled) {
        for (const url of created) URL.revokeObjectURL(url);
        return;
      }
      setUrls(resolved);
    });
    return () => {
      cancelled = true;
      for (const url of created) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return urls;
}

export interface AttachmentImageProps {
  filePath: string;
  alt?: string;
  className?: string;
  loading?: 'lazy' | 'eager';
}

/** Render a single attachment as an authed blob-backed `<img>`. */
export function AttachmentImage({ filePath, alt, className, loading = 'lazy' }: AttachmentImageProps) {
  const [objectUrl] = useAttachmentObjectUrls([filePath]);
  if (!objectUrl) {
    return <div className={className} aria-busy="true" />;
  }
  return <img src={objectUrl} alt={alt ?? filePath} className={className} loading={loading} />;
}
