import { CheckCircle2, XCircle } from 'lucide-react';
import { Button, Disclosure, ExternalLink, Skeleton } from '../../design';
import { processedBodyUrl, useTurnToolCalls, type ToolCallRow } from '../../hooks/use-sessions';
import { formatBytes, formatMillis } from '../../lib/format';
import { count } from './words';

/** The first file a tool call named, for the row's one-line summary. */
function firstFile(row: ToolCallRow): string | null {
  if (row.filesAffected === null) return null;
  try {
    const parsed = JSON.parse(row.filesAffected) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : null;
  } catch {
    return null;
  }
}

const block = 'max-h-[256px] overflow-auto whitespace-pre-wrap break-words rounded-control border border-line bg-page px-s3 py-s2 t-mono text-ink-2';

function ToolCallItem({ projectId, row }: { projectId: string; row: ToolCallRow }) {
  const file = firstFile(row);
  const hasDetail = row.inputPreview !== null || row.inputBlobKey !== null || row.outputPreview !== null || row.outputBlobKey !== null || row.errorMessage !== null;
  return (
    <li data-testid={`tool-call-${row.toolCallId}`}>
      <Disclosure
        wide
        summaryClassName="px-s2 py-s1"
        summary={(
          <span className="flex min-w-0 items-center gap-s2 t-small">
            <span className="shrink-0 t-mono text-ink">{row.mycoTool !== null ? `${row.mycoTool}${row.mycoOp !== null ? ` · ${row.mycoOp}` : ''}` : row.toolName}</span>
            {file !== null && <span className="min-w-0 flex-1 truncate text-muted">{file}</span>}
            <span className="ml-auto shrink-0 tabular-nums text-muted">{formatMillis(row.durationMs)}</span>
            {row.success
              ? <CheckCircle2 className="size-s4 shrink-0 text-ok" role="img" aria-label="succeeded" />
              : <XCircle className="size-s4 shrink-0 text-bad" role="img" aria-label="failed" />}
          </span>
        )}
      >
        <div className="flex flex-col gap-s3 py-s2 pl-s8 pr-s2">
          {!hasDetail && <p className="t-small text-muted">No input or output recorded.</p>}
          {(row.inputPreview !== null || row.inputBlobKey !== null) && (
            <div className="flex flex-col gap-s1">
              <span className="t-meta font-medium text-muted">Input{row.inputBytes !== null ? ` · ${formatBytes(row.inputBytes)}` : ''}</span>
              {row.inputPreview !== null && (
                <pre className={block}>{row.inputPreview}{row.inputTruncated ? '…' : ''}</pre>
              )}
              {(row.inputTruncated || row.inputBlobKey !== null) && <ExternalLink href={processedBodyUrl(projectId, { kind: 'tool-input', id: row.toolCallId })} className="w-fit t-small">Full input</ExternalLink>}
            </div>
          )}
          {(row.outputPreview !== null || row.outputBlobKey !== null) && (
            <div className="flex flex-col gap-s1">
              <span className="t-meta font-medium text-muted">Output</span>
              {row.outputPreview !== null && <pre className={block}>{row.outputPreview}</pre>}
              {row.outputBlobKey !== null && <ExternalLink href={processedBodyUrl(projectId, { kind: 'tool-output', id: row.toolCallId })} className="w-fit t-small">Full output</ExternalLink>}
            </div>
          )}
          {row.errorMessage !== null && (
            <div className="flex flex-col gap-s1">
              <span className="t-meta font-medium text-bad">Error</span>
              <pre className={`${block} text-bad`}>{row.errorMessage}</pre>
            </div>
          )}
        </div>
      </Disclosure>
    </li>
  );
}

/** The tool calls a prompt led to, folded away; nothing is read until they open. */
export function ToolCalls({ projectId, sessionId, promptId, total }: { projectId: string; sessionId: string; promptId: string; total: number }) {
  if (total === 0) return null;
  return (
    <Disclosure summary={<span data-testid="tool-calls-toggle">{count(total, 'tool call')}</span>}>
      <ToolCallList projectId={projectId} sessionId={sessionId} promptId={promptId} total={total} />
    </Disclosure>
  );
}

function ToolCallList({ projectId, sessionId, promptId, total }: { projectId: string; sessionId: string; promptId: string; total: number }) {
  const calls = useTurnToolCalls(projectId, sessionId, promptId, true);
  return (
    <div className="flex flex-col gap-s2 rounded-control border border-line bg-surface-1 p-s1">
      {calls.isPending && (
        <div role="status" aria-label="Loading tool calls" className="flex flex-col gap-s2 p-s2">
          {Array.from({ length: Math.min(total, 3) }).map((_, i) => <Skeleton key={i} className="h-s4 w-full" />)}
        </div>
      )}
      {calls.error && <p className="p-s2 t-small text-bad">The tool calls could not be read.</p>}
      {calls.rows.length > 0 && (
        <ul aria-label="Tool calls" className="flex flex-col">
          {calls.rows.map((row) => <ToolCallItem key={row.toolCallId} projectId={projectId} row={row} />)}
        </ul>
      )}
      {calls.hasMore && <Button size="sm" variant="ghost" className="w-fit" pending={calls.isFetchingMore} onClick={calls.more}>Show more</Button>}
    </div>
  );
}
