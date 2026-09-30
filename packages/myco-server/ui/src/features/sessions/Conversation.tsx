import { useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingState, ShowMore, Switch } from '../../design';
import { PROMPT_ORIGINS, useTurns, type PromptOrigin, type TurnRow } from '../../hooks/use-sessions';
import { Turn } from './Turn';

const PERSON_ONLY: readonly PromptOrigin[] = ['user'];

/** The turn a fresh conversation opens: the last one a person typed, so a late runtime notification never takes the spot. */
export function defaultOpenTurn(rows: readonly TurnRow[]): string | null {
  const typed = [...rows].reverse().find((row) => row.origin === 'user');
  return (typed ?? rows[rows.length - 1])?.promptId ?? null;
}

/**
 * A session's conversation, oldest first: the prompts a person typed by
 * default, every prompt on request, the last typed one open. A link that names
 * a turn (`?turn=`) opens that one and brings it into view.
 */
export function Conversation({ projectId, sessionId, promptCount = 0 }: { projectId: string; sessionId: string; promptCount?: number }) {
  const [showAll, setShowAll] = useState(false);
  const toggleId = useId();
  const turns = useTurns(projectId, sessionId, showAll ? PROMPT_ORIGINS : PERSON_ONLY);
  const [params] = useSearchParams();
  const wanted = params.get('turn');
  const found = wanted !== null && turns.rows.some((t) => t.promptId === wanted);
  const openId = found ? wanted : turns.hasMore ? null : defaultOpenTurn(turns.rows);
  // A named turn not on the page yet is reached by reading the next page, then by showing every prompt; each step once.
  const widened = useRef(false);
  useEffect(() => {
    if (wanted === null || found || turns.isPending || turns.isFetchingMore) return;
    if (turns.hasMore) { turns.more(); return; }
    if (!showAll && !widened.current) { widened.current = true; setShowAll(true); }
  }, [wanted, found, turns.isPending, turns.isFetchingMore, turns.hasMore, showAll, turns]);

  return (
    <div className="flex flex-col gap-s4">
      <div className="flex items-center justify-end gap-s2">
        <label htmlFor={toggleId} className="t-small text-muted">Show prompts from the system and sub-agents</label>
        <Switch id={toggleId} checked={showAll} onCheckedChange={setShowAll} />
      </div>
      {turns.isPending ? (
        <LoadingState label="Loading the conversation" count={3} />
      ) : turns.error ? (
        <ErrorState error={turns.error} onRetry={turns.retry} />
      ) : turns.rows.length === 0 ? (
        <EmptyState title={!showAll && promptCount > 0 ? 'No prompts a person typed. Show the prompts from the system and sub-agents to see what ran.' : 'Nothing captured in this session yet.'} />
      ) : (
        <ol aria-label="Conversation" className="flex flex-col gap-s3">
          {turns.rows.map((turn) => (
            <Turn key={turn.promptId} projectId={projectId} sessionId={sessionId} turn={turn} defaultOpen={turn.promptId === openId} scrollTo={found && turn.promptId === wanted} />
          ))}
        </ol>
      )}
      {turns.hasMore && <ShowMore shown={turns.rows.length} noun="prompts" onMore={turns.more} pending={turns.isFetchingMore} hasMore />}
    </div>
  );
}
