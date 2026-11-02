import type { ReactNode } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Button, Disclosure, ExternalLink, Skeleton } from '../../design';
import { processedBodyUrl, useTurnToolCalls, type ToolCallRow, type ToolRollup, type ToolSummary as ToolSummaryRow } from '../../hooks/use-sessions';
import { cn } from '../../lib/cn';
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

const callName = (row: ToolCallRow) => row.mycoTool !== null ? `${row.mycoTool}${row.mycoOp !== null ? ` · ${row.mycoOp}` : ''}` : row.toolName;

/** A call's input, output and error in full, or as much as was kept with a link to the rest. */
function ToolCallDetail({ projectId, sessionId, row }: { projectId: string; sessionId: string; row: ToolCallRow }) {
  const hasDetail = row.inputPreview !== null || row.inputBlobKey !== null || row.outputPreview !== null || row.outputBlobKey !== null || row.errorMessage !== null;
  return (
    <div className="flex flex-col gap-s3 py-s2 pl-s8 pr-s2">
      {!hasDetail && <p className="t-small text-muted">No input or output recorded.</p>}
      {(row.inputPreview !== null || row.inputBlobKey !== null) && (
        <div className="flex flex-col gap-s1">
          <span className="t-meta font-medium text-muted">Input{row.inputBytes !== null ? ` · ${formatBytes(row.inputBytes)}` : ''}</span>
          {row.inputPreview !== null && (
            <pre className={block}>{row.inputPreview}{row.inputTruncated ? '…' : ''}</pre>
          )}
          {(row.inputTruncated || row.inputBlobKey !== null) && <ExternalLink href={processedBodyUrl(projectId, { kind: 'tool-input', id: row.toolCallId, at: row.locator === undefined ? undefined : { ...row.locator, sessionId } })} className="w-fit t-small">Full input</ExternalLink>}
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
  );
}

function ToolCallItem({ projectId, sessionId, row }: { projectId: string; sessionId: string; row: ToolCallRow }) {
  const file = firstFile(row);
  return (
    <li data-testid={`tool-call-${row.toolCallId}`}>
      <Disclosure
        wide
        summaryClassName="px-s2 py-s1"
        summary={(
          <span className="flex min-w-0 items-center gap-s2 t-small">
            <span className="shrink-0 t-mono text-ink">{callName(row)}</span>
            {file !== null && <span className="min-w-0 flex-1 truncate text-muted">{file}</span>}
            <span className="ml-auto shrink-0 tabular-nums text-muted">{formatMillis(row.durationMs)}</span>
            {row.success
              ? <CheckCircle2 className="size-s4 shrink-0 text-ok" role="img" aria-label="succeeded" />
              : <XCircle className="size-s4 shrink-0 text-bad" role="img" aria-label="failed" />}
          </span>
        )}
      >
        <ToolCallDetail projectId={projectId} sessionId={sessionId} row={row} />
      </Disclosure>
    </li>
  );
}

/** One failed call with its error in view, and the rest of the call a click away. */
function FailedCall({ projectId, sessionId, row }: { projectId: string; sessionId: string; row: ToolCallRow }) {
  const file = firstFile(row);
  const said = row.errorMessage ?? (row.outputPreview === null ? 'No result was captured.' : null);
  return (
    <li data-testid={`failed-call-${row.toolCallId}`} className="flex flex-col gap-s1 rounded-control bg-bad-bg px-s3 py-s2">
      <span className="t-small font-medium text-ink">{callName(row)}</span>
      {file !== null && <code className="t-mono break-all text-ink-2">{file}</code>}
      {said !== null && <pre className="max-h-[256px] overflow-auto whitespace-pre-wrap break-words t-mono text-bad">{said}</pre>}
      <Disclosure summary="Input and output">
        <ToolCallDetail projectId={projectId} sessionId={sessionId} row={row} />
      </Disclosure>
    </li>
  );
}

const countsLine = (rollup: ToolRollup) => rollup.tools.map((tool) => `${tool.name} ${tool.count.toLocaleString()}`).join(' · ');

const mycoChip = 'rounded-control border border-primary/45 bg-primary-bg px-s2 py-px t-mono text-primary';
const failedChip = 'border-bad/50 bg-bad-bg text-bad';

export interface ToolUseProps {
  projectId: string;
  sessionId: string;
  promptId: string;
  /** All the turn's calls. */
  total: number;
  /** All its failed calls, once `rollup` is known. */
  failed: number;
  rollup: ToolRollup | null;
  summary: ToolSummaryRow | undefined;
  /** How many calls the lists here cover. */
  shown: { total: number; shown: number } | undefined;
  /** What Myco added to the prompt, between the Myco calls and the failures. */
  added?: ReactNode;
}

/** A turn's tool calls in brief: counts by tool, Myco calls as chips, each failure with its error, the files, and every call folded away. */
export function ToolUse({ projectId, sessionId, promptId, total, failed, rollup, summary, shown, added }: ToolUseProps) {
  const failures = summary?.failures ?? [];
  const files = summary?.files ?? [];
  const edited = rollup?.filesEdited ?? files.length;
  const named = summary?.filesNamed ?? 0;
  const fileWords = edited > 0 ? `${count(edited, 'file')} edited${named > edited ? ` · ${named.toLocaleString()} named` : ''}` : named > 0 ? `${count(named, 'file')} named` : null;
  const myco = rollup !== null
    ? rollup.myco.map((call) => ({ key: call.name, name: call.name, count: call.count, failed: call.failed }))
    : (summary?.myco ?? []).map((call) => ({ key: `${call.tool}:${call.op ?? ''}`, name: `${call.tool}${call.op !== null ? ` · ${call.op}` : ''}`, count: call.count, failed: call.failed }));
  const failuresTotal = rollup !== null ? failed : summary?.failed ?? 0;
  const partial = summary?.complete === false;
  const calls = total > 0 || partial;
  return (
    <section aria-label="Tool use" className="flex flex-col gap-s2" data-testid="tool-use">
      <h2 className="t-h3 text-ink">{calls ? 'Tool use' : 'Myco'}</h2>
      <div className="flex flex-col gap-s3 rounded-card border border-line bg-surface-1 px-s4 py-s3">
        {total > 0 && (
          <p className="t-small text-ink-2" data-testid="tool-counts">
            {count(total, 'call')}
            {rollup !== null && failed > 0 && <> · <span className="font-medium text-bad">{failed.toLocaleString()} failed</span></>}
            {rollup !== null && rollup.tools.length > 0 && <span className="text-muted"> · {countsLine(rollup)}</span>}
          </p>
        )}
        {shown !== undefined && shown.shown < shown.total && <p className="t-small text-muted" data-testid="tool-partial">Failures, Myco calls and files below: showing the first {shown.shown.toLocaleString()} of {shown.total.toLocaleString()} calls.</p>}
        {myco.length > 0 && (
          <ul className="flex flex-wrap gap-s2" aria-label="Myco tool calls">
            {myco.map((call) => (
              <li key={call.key} className={cn(mycoChip, call.failed > 0 && failedChip)}>
                {call.name}{call.count > 1 ? ` ×${call.count.toLocaleString()}` : ''}{call.failed > 0 ? ` · ${call.failed.toLocaleString()} failed` : ''}
              </li>
            ))}
          </ul>
        )}
        {added}
        {failures.length > 0 && (
          <ul className="flex flex-col gap-s2" aria-label="Failed tool calls">
            {failures.map((row) => <FailedCall key={row.toolCallId} projectId={projectId} sessionId={sessionId} row={row} />)}
            {failuresTotal > failures.length && <li className="t-small text-muted">Showing the first {failures.length.toLocaleString()} of {failuresTotal.toLocaleString()} failures. All tool calls has the rest.</li>}
          </ul>
        )}
        {files.length > 0 ? (
          <Disclosure summary={<span>{fileWords}</span>}>
            <ul className="flex flex-col gap-s1 t-mono text-muted" aria-label="Files edited">
              {files.map((file) => <li key={file} className="break-all">{file}</li>)}
            </ul>
          </Disclosure>
        ) : fileWords !== null && <p className="t-small text-ink-2">{fileWords}</p>}
        <ToolCalls projectId={projectId} sessionId={sessionId} promptId={promptId} total={total} partial={partial} />
      </div>
    </section>
  );
}

/** The tool calls a prompt led to, folded away; nothing is read until they open. `partial` keeps them reachable when `total` may miss some. */
export function ToolCalls({ projectId, sessionId, promptId, total, partial = false }: { projectId: string; sessionId: string; promptId: string; total: number; partial?: boolean }) {
  if (total === 0 && !partial) return null;
  return (
    <Disclosure summary={<span data-testid="tool-calls-toggle">{total === 0 ? 'Tool calls' : total === 1 ? '1 tool call' : `All ${count(total, 'tool call')}`}</span>}>
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
          {Array.from({ length: Math.min(Math.max(total, 1), 3) }).map((_, i) => <Skeleton key={i} className="h-s4 w-full" />)}
        </div>
      )}
      {calls.error && <p className="p-s2 t-small text-bad">The tool calls could not be read.</p>}
      {calls.rows.length > 0 && (
        <ul aria-label="Tool calls" className="flex flex-col">
          {calls.rows.map((row) => <ToolCallItem key={row.toolCallId} projectId={projectId} sessionId={sessionId} row={row} />)}
        </ul>
      )}
      {calls.hasMore && <Button size="sm" variant="ghost" className="w-fit" pending={calls.isFetchingMore} onClick={calls.more}>Show more</Button>}
    </div>
  );
}
