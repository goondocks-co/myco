import { useState } from 'react';
import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import { Card, CardContent, CardHeader } from '../ui/card';
import { useSessionBatches, useSessionAttachments, type BatchRow, type AttachmentRow } from '../../hooks/use-sessions';
import { ActivityList } from './ActivityList';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

/** Number of characters to show in a collapsed batch prompt preview. */
const PROMPT_PREVIEW_CHARS = 120;

/* ---------- Helpers ---------- */

function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function promptPreview(text: string | null): string {
  if (!text) return '(no prompt)';
  return text.length > PROMPT_PREVIEW_CHARS
    ? text.slice(0, PROMPT_PREVIEW_CHARS) + '…'
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
    <Card className="overflow-hidden">
      <CardHeader className="p-0">
        <button
          type="button"
          className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent/40 transition-colors"
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-2 mb-0.5">
              <span className="text-xs font-semibold text-muted-foreground">
                #{batch.prompt_number ?? batch.id}
              </span>
              {batch.started_at && (
                <span className="shrink-0 text-xs text-muted-foreground font-mono">
                  {formatTimestamp(batch.started_at)}
                </span>
              )}
            </div>
            <p className="text-sm text-foreground truncate">
              {open ? (batch.user_prompt ?? '(no prompt)') : promptPreview(batch.user_prompt)}
            </p>
          </div>
        </button>
      </CardHeader>

      {open && (
        <CardContent className="p-0">
          {/* User prompt (full) */}
          <div className="px-4 pt-0 pb-3">
            {batch.user_prompt && batch.user_prompt.length > PROMPT_PREVIEW_CHARS && (
              <p className="text-sm text-foreground whitespace-pre-wrap break-words">
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
                    className="max-w-md rounded border border-border"
                    loading="lazy"
                  />
                ))}
              </div>
            )}
          </div>

          {/* Activities */}
          {batch.activity_count > 0 && (
            <div>
              <div className="px-4 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide border-t border-border/60">
                Tool calls
              </div>
              <ActivityList batchId={batch.id} activityCount={batch.activity_count} />
            </div>
          )}

          {/* AI summary */}
          {batch.response_summary && (
            <div className="border-t border-border/60 px-4 py-3">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                Response
              </div>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
                {batch.response_summary}
              </p>
            </div>
          )}
        </CardContent>
      )}
    </Card>
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
          <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  const batchList = batches ?? [];

  if (batchList.length === 0) {
    return (
      <div className={cn('flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground')}>
        <MessageSquare className="h-8 w-8 opacity-30" />
        <span className="text-sm">No batches recorded</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
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
