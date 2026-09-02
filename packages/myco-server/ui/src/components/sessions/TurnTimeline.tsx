import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import { PageLoading } from '../ui/page-loading';
import { SkeletonList } from '../ui/skeleton';
import { PROMPT_ORIGINS, useTurns, type PromptOrigin, type TurnRow } from '../../hooks/use-sessions';
import { TurnCard } from './TurnCard';

const PERSON_ONLY: readonly PromptOrigin[] = ['user'];

/** The turn a fresh timeline opens: the last one a person typed, so a late runtime notification never takes the spot. */
export function defaultOpenTurn(rows: readonly TurnRow[]): string | null {
  const typed = [...rows].reverse().find((row) => row.origin === 'user');
  return (typed ?? rows[rows.length - 1])?.promptId ?? null;
}

/** A session's conversation as a spine of collapsed turns: what a person typed by default, every injected prompt on request, the last typed turn open. */
export function TurnTimeline({ projectId, sessionId, promptCount = 0 }: { projectId: string; sessionId: string; promptCount?: number }) {
  const [showAll, setShowAll] = useState(false);
  const turns = useTurns(projectId, sessionId, showAll ? PROMPT_ORIGINS : PERSON_ONLY);
  // A link that names a turn (`?turn=`) opens that one; otherwise the last typed turn opens once the list is whole.
  const [params] = useSearchParams();
  const wanted = params.get('turn');
  const found = wanted !== null && turns.rows.some((t) => t.promptId === wanted);
  const openId = found ? wanted : turns.hasMore ? null : defaultOpenTurn(turns.rows);
  // A named turn not on the page yet is reached by reading the next page, then by showing every origin; each step once.
  const widened = useRef(false);
  useEffect(() => {
    if (wanted === null || found || turns.isPending || turns.isFetchingMore) return;
    if (turns.hasMore) { turns.more(); return; }
    if (!showAll && !widened.current) { widened.current = true; setShowAll(true); }
  }, [wanted, found, turns.isPending, turns.isFetchingMore, turns.hasMore, showAll, turns]);
  const toggle = (
    <label className="inline-flex cursor-pointer select-none items-center gap-2">
      <input type="checkbox" className="h-3 w-3 cursor-pointer accent-primary" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
      <span>Show system &amp; sub-agent prompts</span>
    </label>
  );
  return (
    <div>
      <div className="mb-3 flex items-center justify-end pl-11 text-xs text-on-surface-variant">{toggle}</div>
      {turns.isPending ? (
        <SkeletonList count={3} label="Loading conversation" className="pl-11" />
      ) : (
        <PageLoading isLoading={false} error={turns.error}>
          {turns.rows.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant">
              <MessageSquare className="h-8 w-8 opacity-30" />
              <span className="font-sans text-sm">
                {!showAll && promptCount > 0 ? 'No prompts typed by a person. Show system & sub-agent prompts to see what ran.' : 'Nothing captured in this session yet.'}
              </span>
            </div>
          ) : (
            <div aria-label="Conversation" role="list">
              {turns.rows.map((turn, i) => (
                <div key={turn.promptId} role="listitem">
                  <TurnCard projectId={projectId} sessionId={sessionId} turn={turn} index={i} isLast={i === turns.rows.length - 1 && !turns.hasMore} defaultOpen={turn.promptId === openId} scrollTo={found && turn.promptId === wanted} />
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
