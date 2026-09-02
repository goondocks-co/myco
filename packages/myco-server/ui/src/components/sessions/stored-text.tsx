import { MarkdownContent } from '../ui/markdown-content';
import { useBlobText } from '../../hooks/use-sessions';

/** Stored text that spilled to a blob, fetched and shown; a line says so while it loads, so a body is never blank. */
export function BlobText({ projectId, blobKey, markdown = false }: { projectId: string; blobKey: string; markdown?: boolean }) {
  const text = useBlobText(projectId, blobKey);
  if (text.isPending) return <span className="font-sans text-xs text-on-surface-variant">Loading stored text…</span>;
  if (text.error) return <span className="font-sans text-xs text-tertiary">The stored text could not be read.</span>;
  return markdown ? <MarkdownContent content={text.data} /> : <pre className="whitespace-pre-wrap break-words font-sans text-sm text-on-surface">{text.data}</pre>;
}

/** Text held inline, or fetched from its blob, or noted absent. */
export function TextOrBlob({ projectId, text, blobKey, markdown = false }: { projectId: string; text: string | null; blobKey: string | null; markdown?: boolean }) {
  if (text !== null) return markdown ? <MarkdownContent content={text} /> : <pre className="whitespace-pre-wrap break-words font-sans text-sm text-on-surface">{text}</pre>;
  if (blobKey !== null) return <BlobText projectId={projectId} blobKey={blobKey} markdown={markdown} />;
  return <span className="font-sans text-xs text-on-surface-variant">No text recorded.</span>;
}
