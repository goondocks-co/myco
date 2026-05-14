import { useState, useMemo } from 'react';
import { MessageSquare } from 'lucide-react';
import {
  useSessionBatches,
  useSessionAttachments,
  type BatchRow,
  type AttachmentRow,
  type PromptBatchOrigin,
} from '../../hooks/use-sessions';
import { PromptBatchCard } from './PromptBatchCard';

/* ---------- Constants ---------- */

/** Number of skeleton items to show during loading. */
const SKELETON_COUNT = 3;

/* ---------- Helpers: steering grouping ---------- */

interface BatchGroup {
  parent: BatchRow;
  children: BatchRow[];
}

function groupBatches(sortedBatches: BatchRow[]): BatchGroup[] {
  const childrenByParentId = new Map<number, BatchRow[]>();
  const parents: BatchRow[] = [];

  for (const batch of sortedBatches) {
    if (batch.parent_prompt_batch_id == null) {
      parents.push(batch);
    } else {
      const arr = childrenByParentId.get(batch.parent_prompt_batch_id) ?? [];
      arr.push(batch);
      childrenByParentId.set(batch.parent_prompt_batch_id, arr);
    }
  }

  return parents.map((parent) => ({
    parent,
    children: (childrenByParentId.get(parent.id) ?? []).sort(
      (a, b) => (a.started_at ?? 0) - (b.started_at ?? 0),
    ),
  }));
}

/* ---------- Component ---------- */

export interface BatchTimelineProps {
  sessionId: string;
}

/** Default origin filter for the Sessions view: human-typed prompts only. */
const DEFAULT_ORIGINS: readonly PromptBatchOrigin[] = ['human'];
/** "Show everything" filter, including system-injected and agent-dispatched batches. */
const ALL_ORIGINS: readonly PromptBatchOrigin[] = ['human', 'system', 'agent_dispatch', 'hook_injected'];

export function BatchTimeline({ sessionId }: BatchTimelineProps) {
  // Default to human-only prompts so async <task-notification> /
  // <subagent_notification> / <skill> envelope batches don't swamp the
  // visible timeline. The toggle exposes the full set for operator views
  // and debugging.
  const [showAllOrigins, setShowAllOrigins] = useState(false);
  const origins = showAllOrigins ? ALL_ORIGINS : DEFAULT_ORIGINS;
  const { data: batches, isLoading: batchesLoading } = useSessionBatches(sessionId, origins);
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
      if (a.turn_number != null) {
        const arr = byTurnNumber.get(a.turn_number) ?? [];
        arr.push(a);
        byTurnNumber.set(a.turn_number, arr);
      }
    }
    return { byBatchId, byTurnNumber };
  }, [allAttachments]);

  // Sort by started_at ascending — prompt_number resets across daemon restarts.
  const groups = useMemo(() => {
    const sorted = [...(batches ?? [])].sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
    return groupBatches(sorted);
  }, [batches]);

  if (batchesLoading) {
    return (
      <div className="space-y-3 pl-11">
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-md bg-surface-container-low" />
        ))}
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant">
        <MessageSquare className="h-8 w-8 opacity-30" />
        <span className="font-sans text-sm">No prompts recorded</span>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-end pl-11 text-xs text-on-surface-variant">
        <label className="inline-flex cursor-pointer items-center gap-2 select-none">
          <input
            type="checkbox"
            className="h-3 w-3 cursor-pointer accent-primary"
            checked={showAllOrigins}
            onChange={(e) => setShowAllOrigins(e.target.checked)}
          />
          <span>Show system &amp; sub-agent prompts</span>
        </label>
      </div>
      {groups.map(({ parent, children }, idx) => {
        const resolved = byBatchId.get(parent.id)
          ?? (parent.prompt_number !== null ? byTurnNumber.get(parent.prompt_number) ?? [] : []);
        return (
          <PromptBatchCard
            key={parent.id}
            batch={parent}
            batchAttachments={resolved}
            steeringChildren={children}
            defaultOpen={idx === groups.length - 1}
            promptIndex={idx}
            isLast={idx === groups.length - 1}
          />
        );
      })}
    </div>
  );
}
