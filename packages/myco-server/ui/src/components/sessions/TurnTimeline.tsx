import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { PageLoading } from '../ui/page-loading';
import { SkeletonList } from '../ui/skeleton';
import { PROMPT_ORIGINS, useTurns, type PromptOrigin } from '../../hooks/use-sessions';
import { TurnCard } from './TurnCard';

const PERSON_ONLY: readonly PromptOrigin[] = ['user'];

/** A session's conversation as a spine of collapsed turns: what a person typed by default, every injected prompt on request, the last turn open. */
export function TurnTimeline({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const [showAll, setShowAll] = useState(false);
  const turns = useTurns(projectId, sessionId, showAll ? PROMPT_ORIGINS : PERSON_ONLY);
  return (
    <div>
      <div className="mb-3 flex items-center justify-end pl-11 text-xs text-on-surface-variant">
        <label className="inline-flex cursor-pointer select-none items-center gap-2">
          <input type="checkbox" className="h-3 w-3 cursor-pointer accent-primary" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          <span>Show system &amp; sub-agent prompts</span>
        </label>
      </div>
      {turns.isPending ? (
        <SkeletonList count={3} label="Loading conversation" className="pl-11" />
      ) : (
        <PageLoading isLoading={false} error={turns.error}>
          {turns.rows.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant">
              <MessageSquare className="h-8 w-8 opacity-30" />
              <span className="font-sans text-sm">Nothing captured in this session yet.</span>
            </div>
          ) : (
            <div aria-label="Conversation" role="list">
              {turns.rows.map((turn, i) => (
                <div key={turn.promptId} role="listitem">
                  <TurnCard projectId={projectId} sessionId={sessionId} turn={turn} index={i} isLast={i === turns.rows.length - 1 && !turns.hasMore} defaultOpen={i === turns.rows.length - 1 && !turns.hasMore} />
                </div>
              ))}
            </div>
          )}
          {turns.hasMore && (
            <div className="mt-3 pl-11">
              <button type="button" disabled={turns.isFetchingMore} onClick={turns.more} className="rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50">Load more</button>
            </div>
          )}
        </PageLoading>
      )}
    </div>
  );
}
