import { useState } from 'react';
import { Sprout, ArrowRight, FileX } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { useCanopyInjectionBlob } from '../../hooks/use-canopy';
import type { ActivityRow } from '../../hooks/use-sessions';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

/** Tool names where we show the indicator. Per spec: only Read. */
const READ_TOOL_NAMES = new Set(['Read', 'read']);

/* ---------- Helpers ---------- */

/**
 * Decides whether a tool-call row qualifies for a Canopy indicator. Two
 * gates: the tool must be a Read, and the row must carry a non-null
 * `canopy_injection_tokens` value (the column is null on every non-Read row
 * and on Read rows where Canopy didn't inject — targeted reads, small
 * files, unknown files, disabled scope).
 */
function qualifies(activity: { tool_name: string; canopy_injection_tokens: number | null }): boolean {
  if (activity.canopy_injection_tokens === null) return false;
  return READ_TOOL_NAMES.has(activity.tool_name);
}

/* ---------- Sub-components ---------- */

/**
 * Modal body that lazy-loads the verbatim injection blob via React Query.
 * Rendered inside <Dialog open> so the fetch only fires when the user opens
 * the popover — keeps the timeline lightweight by default.
 */
function BlobPanel({ sessionId, toolCallId }: { sessionId: string; toolCallId: number }) {
  const { data, isLoading, isError, error } = useCanopyInjectionBlob(sessionId, toolCallId);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <div className="h-3 w-3/4 animate-pulse rounded bg-surface-container-high" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-surface-container-high" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-surface-container-high" />
      </div>
    );
  }

  if (isError || data === null) {
    return (
      <div className="flex items-center gap-2 text-on-surface-variant">
        <FileX className="h-4 w-4" />
        <span className="font-sans text-sm">
          {error instanceof Error
            ? error.message
            : 'No injection blob available — Track C may not have shipped this endpoint yet.'}
        </span>
      </div>
    );
  }

  return (
    <pre
      className="font-mono text-xs whitespace-pre-wrap break-words bg-surface-container-lowest rounded-md p-3 text-on-surface overflow-x-auto"
      data-testid="canopy-blob-text"
    >
      {`[canopy] ${data.path} — ${data.tokenEstimate} tok, ${data.lineCount} lines`}
      {data.exports.length > 0 && `\n  exports: ${data.exports.join(', ')}`}
      {data.imports.length > 0 && `\n  imports: ${data.imports.join(', ')}`}
      {data.summary && `\n  summary: "${data.summary}"`}
      {!data.summary && data.top && `\n  top: "${data.top}"`}
      {`\n[meta] File anatomy from Myco. If exports + top line already answer your question, skipping the full read may be appropriate.`}
    </pre>
  );
}

/* ---------- Component ---------- */

export interface CanopyToolCallIndicatorProps {
  sessionId: string;
  /**
   * Activity row for this tool call. The component reads `tool_name`,
   * `canopy_injection_tokens`, and `id`; it does not modify the row.
   */
  activity: ActivityRow;
}

/**
 * Compact inline indicator for the Canopy injection on a Read tool-call
 * row. Renders nothing for non-Read tools or for Read rows without an
 * injection — the column being NULL is the universal "no indicator" signal.
 *
 * Click opens a transparency popover with the verbatim blob Cortex sent the
 * agent. The blob fetch is lazy (only fires on open).
 */
export function CanopyToolCallIndicator({ sessionId, activity }: CanopyToolCallIndicatorProps) {
  const [open, setOpen] = useState(false);

  if (!qualifies(activity)) return null;

  // Type-narrow: qualifies() guarantees this is non-null.
  const tokens = activity.canopy_injection_tokens as number;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // Tool-call rows are clickable themselves (they expand/collapse).
          // Stop propagation so opening the blob popover doesn't also toggle
          // the row's expand state.
          e.stopPropagation();
          setOpen(true);
        }}
        className={cn(
          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded',
          'font-mono text-[10px] text-sage',
          'bg-sage/10 hover:bg-sage/20 transition-colors cursor-pointer',
          'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sage/40',
        )}
        title={`Canopy injected ${tokens} tokens of file anatomy. Click to view the blob sent to the agent.`}
        aria-label={`Canopy injection: ${tokens} tokens`}
        data-testid="canopy-tool-call-indicator"
      >
        <Sprout className="h-3 w-3" aria-hidden="true" />
        <span>{tokens} tok</span>
        <ArrowRight className="h-2.5 w-2.5 opacity-60" aria-hidden="true" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Canopy injection blob</DialogTitle>
            <DialogDescription>
              The verbatim file-anatomy snippet Cortex sent the agent before this Read.
              Transparency is the default — what you see here is exactly what the model saw.
            </DialogDescription>
          </DialogHeader>
          <BlobPanel sessionId={sessionId} toolCallId={activity.id} />
        </DialogContent>
      </Dialog>
    </>
  );
}
