import type { ReactNode } from 'react';
import { Markdown } from '../../design';
import { useProcessedText, type ProcessedBodyRef } from '../../hooks/use-sessions';

/** Stored text that spilled to a blob, fetched and shown; a line says so while it loads, so a body is never blank. */
export function StoredText({ projectId, body, blobKey, markdown = false, transform = (value) => value, render }: { projectId: string; body: ProcessedBodyRef; blobKey: string; markdown?: boolean; transform?: (value: string) => string; render?: (value: string) => ReactNode }) {
  const text = useProcessedText(projectId, body, blobKey);
  if (text.isPending) return <span className="t-small text-muted">Loading the stored text…</span>;
  if (text.error) return <span className="t-small text-bad">The stored text could not be read.</span>;
  if (render !== undefined) return render(text.data);
  return markdown ? <Markdown content={transform(text.data)} /> : <PlainText text={transform(text.data)} />;
}

/** Text held inline, or fetched whole when a stored body stands behind it, or noted absent. */
export function TextOrBlob({ projectId, text, blobKey, body, markdown = false, transform = (value) => value, render }: { projectId: string; text: string | null; blobKey: string | null; body: ProcessedBodyRef; markdown?: boolean; transform?: (value: string) => string; render?: (value: string) => ReactNode }) {
  if (blobKey !== null) return <StoredText projectId={projectId} body={body} blobKey={blobKey} markdown={markdown} transform={transform} render={render} />;
  if (text !== null) return render !== undefined ? render(text) : markdown ? <Markdown content={transform(text)} /> : <PlainText text={transform(text)} />;
  return <span className="t-small text-muted">No text recorded.</span>;
}

function PlainText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words t-body text-ink-2">{text}</p>;
}
