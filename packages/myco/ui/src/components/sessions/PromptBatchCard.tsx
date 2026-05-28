import { useState } from 'react';
import { ChevronDown, ChevronRight, Bot } from 'lucide-react';
import { Surface } from '../ui/surface';
import { MarkdownContent } from '../ui/markdown-content';
import { Lightbox } from '../ui/lightbox';
import type { BatchRow, AttachmentRow } from '../../hooks/use-sessions';
import { ActivityList } from './ActivityList';
import { SteeringChildCard } from './SteeringChildCard';
import { cn } from '../../lib/cn';
import { withBasePath } from '../../lib/base-path';
import {
  PROMPT_PREVIEW_CHARS,
  TIMELINE_NODE_SIZE_CLASS,
  formatTimestamp,
  promptPreview,
} from './batch-timeline-helpers';

export interface PromptBatchCardProps {
  batch: BatchRow;
  batchAttachments: AttachmentRow[];
  steeringChildren: BatchRow[];
  defaultOpen?: boolean;
  promptIndex: number;
  isLast: boolean;
}

/**
 * Renders a single prompt batch as a collapsible card within the timeline spine.
 * Includes the numbered spine segment, the collapsible prompt header, attachments,
 * tool-call activities, steering/interrupt children, and the AI response summary.
 */
export function PromptBatchCard({ batch, batchAttachments, steeringChildren, defaultOpen = false, promptIndex, isLast }: PromptBatchCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  return (
    <div className="relative flex gap-2">
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
      <Surface level="low" className={cn(
        'flex-1 overflow-hidden rounded-md max-w-full border border-outline-variant/10 mb-2',
        // Synthetic recovery batches render faded + dashed so the
        // timeline shows they are reconstructed, not real prompts.
        batch.kind === 'recovered' && 'opacity-60 border-dashed',
      )}>
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
                {batch.kind === 'recovered' ? 'Recovered' : 'Prompt'}
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
                        src={withBasePath(`/api/attachments/${att.file_path}`)}
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
                    src: withBasePath(`/api/attachments/${a.file_path}`),
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

            {/* Myco tool calls made during this turn — surfaces CLI-routed calls
                (recorded as "Bash" activities) and MCP calls under their canonical
                Myco tool name + op, the way the myco agent attributes them. */}
            {batch.myco_tool_calls && batch.myco_tool_calls.length > 0 && (
              <div className="px-4 pb-3 flex flex-wrap items-center gap-1.5">
                <span className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant mr-0.5">
                  Myco
                </span>
                {batch.myco_tool_calls.map((c) => (
                  <span
                    key={`${c.tool_name}:${c.op}`}
                    className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary"
                    title={c.op ? `${c.tool_name} (${c.op})` : c.tool_name}
                  >
                    {c.tool_name}
                    {c.op && <span className="text-primary/60">· {c.op}</span>}
                    {c.count > 1 && <span className="text-primary/60">×{c.count}</span>}
                  </span>
                ))}
              </div>
            )}

            {/* Steering / interrupt children nested beneath parent */}
            {steeringChildren.map((child) => (
              <SteeringChildCard key={child.id} child={child} />
            ))}

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
