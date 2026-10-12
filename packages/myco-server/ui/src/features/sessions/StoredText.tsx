import { Markdown } from '../../design';
import { useProcessedText, type ProcessedBodyRef } from '../../hooks/use-sessions';

/** Stored text that spilled to a blob, fetched and shown; a line says so while it loads, so a body is never blank. */
export function StoredText({ projectId, body, blobKey, markdown = false, transform = (value) => value }: { projectId: string; body: ProcessedBodyRef; blobKey: string; markdown?: boolean; transform?: (value: string) => string }) {
  const text = useProcessedText(projectId, body, blobKey);
  if (text.isPending) return <span className="t-small text-muted">Loading the stored text…</span>;
  if (text.error) return <span className="t-small text-bad">The stored text could not be read.</span>;
  return markdown ? <Markdown content={transform(text.data)} /> : <PlainText text={transform(text.data)} />;
}

/** Text held inline, or fetched from its blob, or noted absent. */
export function TextOrBlob({ projectId, text, blobKey, body, markdown = false, transform = (value) => value }: { projectId: string; text: string | null; blobKey: string | null; body: ProcessedBodyRef; markdown?: boolean; transform?: (value: string) => string }) {
  if (text !== null) return markdown ? <Markdown content={transform(text)} /> : <PlainText text={transform(text)} />;
  if (blobKey !== null) return <StoredText projectId={projectId} body={body} blobKey={blobKey} markdown={markdown} transform={transform} />;
  return <span className="t-small text-muted">No text recorded.</span>;
}

function PlainText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words t-body text-ink-2">{text}</p>;
}
