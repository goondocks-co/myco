import { useState } from 'react';
import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import { Surface } from '../ui/surface';
import { useSessionBatches, useSessionAttachments, type BatchRow, type AttachmentRow } from '../../hooks/use-sessions';
import { ActivityList } from './ActivityList';

/* ---------- Constants ---------- */

/** Number of characters to show in a collapsed batch prompt preview. */
const PROMPT_PREVIEW_CHARS = 120;

/* ---------- Helpers ---------- */

function formatTimestamp(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function promptPreview(text: string | null): string {
  if (!text) return '(no prompt)';
  return text.length > PROMPT_PREVIEW_CHARS
    ? text.slice(0, PROMPT_PREVIEW_CHARS) + '\u2026'
    : text;
}

/* ---------- Sub-components ---------- */

interface BatchCardProps {
  batch: BatchRow;
  attachments: AttachmentRow[];
  defaultOpen?: boolean;
}

function BatchCard({ batch, attachments, defaultOpen = false }: BatchCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  const batchAttachments = attachments.filter(
    (a) => a.prompt_batch_id === batch.id,
  );

  return (
    <Surface level="low" className="overflow-hidden rounded-md">
      {/* Collapsible header */}
      <button
        type="button"
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-container/40 transition-colors"
        onClick={() => setOpen((prev) => !prev)}
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-on-surface-variant" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-on-surface-variant" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2 mb-0.5">
            <span className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant">
              Batch #{batch.prompt_number ?? batch.id}
            </span>
            {batch.activity_count > 0 && (
              <span className="font-mono text-[10px] text-on-surface-variant/70">
                {batch.activity_count} tool call{batch.activity_count !== 1 ? 's' : ''}
              </span>
            )}
            {batch.started_at && (
              <span className="shrink-0 font-mono text-xs text-on-surface-variant">
                {formatTimestamp(batch.started_at)}
              </span>
            )}
          </div>
          <p className="font-sans text-sm text-on-surface truncate">
            {open ? (batch.user_prompt ?? '(no prompt)') : promptPreview(batch.user_prompt)}
          </p>
        </div>
      </button>

      {open && (
        <div>
          {/* User prompt (full) */}
          <div className="px-4 pt-0 pb-3">
            {batch.user_prompt && batch.user_prompt.length > PROMPT_PREVIEW_CHARS && (
              <p className="font-sans text-sm text-on-surface whitespace-pre-wrap break-words">
                {batch.user_prompt}
              </p>
            )}

            {/* Inline attachments */}
            {batchAttachments.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-3">
                {batchAttachments.map((att) => (
                  <img
                    key={att.id}
                    src={`/api/attachments/${att.file_path}`}
                    alt={att.description ?? att.file_path}
                    className="max-w-md rounded-md"
                    loading="lazy"
                  />
                ))}
              </div>
            )}
          </div>

          {/* Activities */}
          {batch.activity_count > 0 && (
            <div className="border-t border-[var(--ghost-border)]">
              <div className="px-4 py-1.5 font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant">
                Tool Calls
              </div>
              <ActivityList batchId={batch.id} activityCount={batch.activity_count} />
            </div>
          )}

          {/* AI summary */}
          {batch.response_summary && (
            <div className="border-t border-[var(--ghost-border)] px-4 py-3">
              <div className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant mb-1">
                Response
              </div>
              <p className="font-sans text-sm text-on-surface-variant whitespace-pre-wrap break-words">
                {batch.response_summary}
              </p>
            </div>
          )}
        </div>
      )}
    </Surface>
  );
}

/* ---------- Component ---------- */

export interface BatchTimelineProps {
  sessionId: string;
}

export function BatchTimeline({ sessionId }: BatchTimelineProps) {
  const { data: batches, isLoading: batchesLoading } = useSessionBatches(sessionId);
  const { data: attachments } = useSessionAttachments(sessionId);

  const allAttachments = attachments ?? [];

  if (batchesLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-md bg-surface-container-low" />
        ))}
      </div>
    );
  }

  // Sort by started_at ascending (chronological) — prompt_number can reset across daemon restarts
  const batchList = [...(batches ?? [])].sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));

  if (batchList.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant">
        <MessageSquare className="h-8 w-8 opacity-30" />
        <span className="font-sans text-sm">No batches recorded</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {batchList.map((batch, idx) => (
        <BatchCard
          key={batch.id}
          batch={batch}
          attachments={allAttachments}
          defaultOpen={idx === 0}
        />
      ))}
    </div>
  );
}
