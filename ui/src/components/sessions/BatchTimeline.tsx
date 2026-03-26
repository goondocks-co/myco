import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, MessageSquare, Bot } from 'lucide-react';
import { Surface } from '../ui/surface';
import { MarkdownContent } from '../ui/markdown-content';
import { Lightbox } from '../ui/lightbox';
import { useSessionBatches, useSessionAttachments, type BatchRow, type AttachmentRow } from '../../hooks/use-sessions';
import { ActivityList } from './ActivityList';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

/** Number of characters to show in a collapsed batch prompt preview. */
const PROMPT_PREVIEW_CHARS = 120;

/** Diameter of the timeline node marker in pixels (Tailwind: h-7 w-7 = 28px). */
const TIMELINE_NODE_SIZE_CLASS = 'h-7 w-7';

/** Number of skeleton items to show during loading. */
const SKELETON_COUNT = 3;

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
  promptIndex: number;
  isLast: boolean;
}

function BatchCard({ batch, batchAttachments, defaultOpen = false, promptIndex, isLast }: BatchCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  return (
    <div className="relative flex gap-4">
      {/* Timeline spine */}
      <div className="relative flex flex-col items-center shrink-0" style={{ width: '28px' }}>
        {/* Connector line above node */}
        {promptIndex > 0 && (
          <div className="absolute top-0 w-px bg-outline-variant/40" style={{ height: '14px' }} />
        )}
        {/* Node marker */}
        <div
          className={cn(
            TIMELINE_NODE_SIZE_CLASS,
            'rounded-full flex items-center justify-center shrink-0 text-[10px] font-mono font-bold transition-colors z-10',
            open
              ? 'bg-primary text-on-primary'
              : 'bg-surface-container-high text-on-surface-variant border border-outline-variant/40',
          )}
        >
          {promptIndex + 1}
        </div>
        {/* Connector line below node */}
        {!isLast && (
          <div className="flex-1 w-px bg-outline-variant/40" />
        )}
      </div>

      {/* Card content */}
      <Surface level="low" className="flex-1 overflow-hidden rounded-md max-w-full border border-outline-variant/10 mb-2">
        {/* Collapsible header */}
        <button
          type="button"
          className={cn(
            'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors overflow-hidden',
            'hover:bg-surface-container/40',
            open && 'bg-surface-container/20',
          )}
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-on-surface-variant transition-transform" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-on-surface-variant transition-transform" />
          )}
          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="flex items-baseline justify-between gap-2 mb-0.5">
              <span className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant shrink-0">
                Prompt
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

        {/* Expandable body — CSS grid animation for smooth expand/collapse */}
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out"
          style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        >
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

            {/* AI summary — distinct response block with left accent */}
            {batch.response_summary && (
              <div className="border-t border-[var(--ghost-border)] overflow-hidden">
                <div className="flex gap-3 px-4 py-3">
                  <div className="w-0.5 shrink-0 rounded-full bg-primary/30" />
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Bot className="h-3 w-3 text-primary/60" />
                      <span className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant">
                        Response
                      </span>
                    </div>
                    <MarkdownContent content={batch.response_summary} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </Surface>
    </div>
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
      <div className="space-y-3 pl-11">
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
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
    <div>
      {batchList.map((batch, idx) => {
        const resolved = byBatchId.get(batch.id)
          ?? (batch.prompt_number !== null ? byTurnNumber.get(batch.prompt_number) ?? [] : []);
        return (
          <BatchCard
            key={batch.id}
            batch={batch}
            batchAttachments={resolved}
            defaultOpen={idx === 0}
            promptIndex={idx}
            isLast={idx === batchList.length - 1}
          />
        );
      })}
    </div>
  );
}
