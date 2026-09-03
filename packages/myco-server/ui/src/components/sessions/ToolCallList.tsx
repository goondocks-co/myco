import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import { inlineLink } from '../ui/inline-link';
import { Skeleton } from '../ui/skeleton';
import { blobUrl, useTurnToolCalls, type ToolCallRow } from '../../hooks/use-sessions';
import { formatBytes, formatMillis } from '../../lib/format';
import { cn } from '../../lib/cn';


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

function ToolCallItem({ projectId, row }: { projectId: string; row: ToolCallRow }) {
  const [expanded, setExpanded] = useState(false);
  const file = firstFile(row);
  const hasDetail = row.inputPreview !== null || row.inputBlobKey !== null || row.outputPreview !== null || row.outputBlobKey !== null || row.errorMessage !== null;
  return (
    <li data-testid={`tool-call-${row.toolCallId}`} className={cn('border-l-2 transition-colors', expanded ? 'border-l-primary/30' : 'border-transparent hover:border-l-primary/20')}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-container/30"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />}
        {row.mycoTool !== null ? (
          <span className="font-mono text-xs font-medium text-primary">{row.mycoTool}{row.mycoOp !== null && <span className="text-primary/60"> · {row.mycoOp}</span>}</span>
        ) : (
          <span className="font-mono text-xs font-medium text-on-surface">{row.toolName}</span>
        )}
        {file !== null && <span className="min-w-0 flex-1 truncate font-sans text-xs text-on-surface-variant">{file}</span>}
        <span className="ml-auto shrink-0 font-mono text-xs text-on-surface-variant">{formatMillis(row.durationMs)}</span>
        {row.success ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="succeeded" /> : <XCircle className="h-3.5 w-3.5 shrink-0 text-tertiary" aria-label="failed" />}
      </button>
      {expanded && (
        <div className="space-y-2 px-8 pb-3">
          {!hasDetail && <p className="py-1 font-sans text-xs italic text-on-surface-variant/60">No input or output recorded.</p>}
          {(row.inputPreview !== null || row.inputBlobKey !== null) && (
            <div>
              <div className="mb-1 font-sans text-xs font-medium text-on-surface-variant">Input{row.inputBytes !== null ? ` · ${formatBytes(row.inputBytes)}` : ''}</div>
              {row.inputPreview !== null && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-container-lowest p-2 font-mono text-xs text-on-surface">
                  {row.inputPreview}{row.inputBytes !== null && row.inputBytes > row.inputPreview.length ? '…' : ''}
                </pre>
              )}
              {row.inputBlobKey !== null && <a href={blobUrl(projectId, row.inputBlobKey)} target="_blank" rel="noreferrer" className={inlineLink}>Full input</a>}
            </div>
          )}
          {(row.outputPreview !== null || row.outputBlobKey !== null) && (
            <div>
              <div className="mb-1 font-sans text-xs font-medium text-on-surface-variant">Output</div>
              {row.outputPreview !== null && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-container-lowest p-2 font-mono text-xs text-on-surface">{row.outputPreview}</pre>
              )}
              {row.outputBlobKey !== null && <a href={blobUrl(projectId, row.outputBlobKey)} target="_blank" rel="noreferrer" className={inlineLink}>Full output</a>}
            </div>
          )}
          {row.errorMessage !== null && (
            <div>
              <div className="mb-1 font-sans text-xs font-medium text-tertiary">Error</div>
              <pre className="whitespace-pre-wrap break-all rounded-md bg-tertiary/10 p-2 font-mono text-xs text-tertiary">{row.errorMessage}</pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** The tool calls a prompt led to, behind a toggle; nothing is read until the toggle opens. */
export function ToolCallList({ projectId, sessionId, promptId, count }: { projectId: string; sessionId: string; promptId: string; count: number }) {
  const [expanded, setExpanded] = useState(false);
  const calls = useTurnToolCalls(projectId, sessionId, promptId, expanded);
  if (count === 0) return null;
  return (
    <div className="border-t border-[var(--ghost-border)]">
      <button
        type="button"
        data-testid="tool-calls-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-surface-container/30"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />}
        <span className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant">Tool calls</span>
        <span className="font-mono text-[10px] text-on-surface-variant/60">{count.toLocaleString()}</span>
      </button>
      {expanded && (
        <div className="pb-2">
          {calls.isPending && (
            <div className="space-y-1 px-3 py-2">
              {Array.from({ length: Math.min(count, 3) }).map((_, i) => <Skeleton key={i} className="h-3 w-full" />)}
            </div>
          )}
          {calls.error && <p className="px-4 py-2 font-sans text-xs text-tertiary">The tool calls could not be read.</p>}
          {calls.rows.length > 0 && (
            <ul aria-label="Tool calls" className="space-y-0">
              {calls.rows.map((row) => <ToolCallItem key={row.toolCallId} projectId={projectId} row={row} />)}
            </ul>
          )}
          {calls.hasMore && (
            <div className="px-4 pt-2">
              <button type="button" onClick={calls.more} className="rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high">Load more</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
