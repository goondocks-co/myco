import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import { Surface } from '../ui/surface';
import { MarkdownContent } from '../ui/markdown-content';
import { Lightbox } from '../ui/lightbox';
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
  batchAttachments: AttachmentRow[];
  defaultOpen?: boolean;
}

function BatchCard({ batch, batchAttachments, defaultOpen = false }: BatchCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  return (
    <Surface level="low" className="overflow-hidden rounded-md max-w-full border border-outline-variant/10">
      {/* Collapsible header */}
      <button
        type="button"
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-container/40 transition-colors overflow-hidden"
        onClick={() => setOpen((prev) => !prev)}
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-on-surface-variant" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-on-surface-variant" />
        )}
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex items-baseline justify-between gap-2 mb-0.5">
            <span className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant shrink-0">
              Prompt #{batch.prompt_number ?? batch.id}
            </span>
            {batch.activity_count > 0 && (
              <span className="font-mono text-[10px] text-on-surface-variant/70 shrink-0">
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
        <div className="overflow-hidden">
          {/* User prompt (full) */}
          <div className="px-4 pt-0 pb-3 overflow-hidden">
            {batch.user_prompt && batch.user_prompt.length > PROMPT_PREVIEW_CHARS && (
              <MarkdownContent content={batch.user_prompt} />
            )}

            {/* Inline attachments */}
            {batchAttachments.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-3">
                {batchAttachments.map((att, idx) => (
                  <button
                    key={att.id}
                    type="button"
                    className="rounded-md overflow-hidden hover:ring-2 hover:ring-primary/40 transition-all"
                    onClick={() => setLightboxIndex(idx)}
                  >
                    <img
                      src={`/api/attachments/${att.file_path}`}
                      alt={att.description ?? att.file_path ?? ''}
                      className="max-w-[200px] max-h-[140px] object-cover rounded-md"
                      loading="lazy"
                    />
                  </button>
                ))}
              </div>
            )}
            {lightboxIndex !== null && (
              <Lightbox
                images={batchAttachments.map((a) => ({
                  src: `/api/attachments/${a.file_path}`,
                  alt: a.description ?? a.file_path ?? '',
                }))}
                index={lightboxIndex}
                onNavigate={setLightboxIndex}
                onClose={() => setLightboxIndex(null)}
              />
            )}
          </div>

          {/* Activities — header is built into ActivityList for expand/collapse */}
          {batch.activity_count > 0 && (
            <ActivityList batchId={batch.id} activityCount={batch.activity_count} />
          )}

          {/* AI summary */}
          {batch.response_summary && (
            <div className="border-t border-[var(--ghost-border)] px-4 py-3 overflow-hidden">
              <div className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant mb-1">
                Response
              </div>
              <MarkdownContent content={batch.response_summary} />
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

  const { byBatchId, byTurnNumber } = useMemo(() => {
    const byBatchId = new Map<number, AttachmentRow[]>();
    const byTurnNumber = new Map<number, AttachmentRow[]>();
    for (const a of allAttachments) {
      if (a.prompt_batch_id != null) {
        const arr = byBatchId.get(a.prompt_batch_id) ?? [];
        arr.push(a);
        byBatchId.set(a.prompt_batch_id, arr);
      }
      const match = a.file_path?.match(/-t(\d+)-/);
      if (match?.[1]) {
        const turn = parseInt(match[1]);
        const arr = byTurnNumber.get(turn) ?? [];
        arr.push(a);
        byTurnNumber.set(turn, arr);
      }
    }
    return { byBatchId, byTurnNumber };
  }, [allAttachments]);

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
        <span className="font-sans text-sm">No prompts recorded</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {batchList.map((batch, idx) => {
        const resolved = byBatchId.get(batch.id)
          ?? (batch.prompt_number !== null ? byTurnNumber.get(batch.prompt_number) ?? [] : []);
        return (
          <BatchCard
            key={batch.id}
            batch={batch}
            batchAttachments={resolved}
            defaultOpen={idx === 0}
          />
        );
      })}
    </div>
  );
}
