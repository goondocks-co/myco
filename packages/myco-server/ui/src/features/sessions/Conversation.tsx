import { useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, EmptyState, ErrorState, LoadingState, Switch } from '../../design';
import { PROMPT_ORIGINS, TURN_PAGE, useAllTurns, type PromptOrigin } from '../../hooks/use-sessions';
import { Turn } from './Turn';
import { count } from './words';

/** The prompts a person typed: what the conversation shows by default. */
export const PERSON_ONLY: readonly PromptOrigin[] = ['user'];

/**
 * A session's conversation, read top to bottom: the prompts a person typed by
 * default, every prompt on request. It opens on the latest turns; a longer
 * session keeps its earlier turns above them, a page at a time. A link that
 * names a turn (`?turn=`) brings it into view, showing every prompt when only
 * that list holds it.
 */
export function Conversation({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const [showAll, setShowAll] = useState(false);
  const [pagesShown, setPagesShown] = useState(1);
  const toggleId = useId();
  const turns = useAllTurns(projectId, sessionId, showAll ? PROMPT_ORIGINS : PERSON_ONLY);
  const [params] = useSearchParams();
  const wanted = params.get('turn');
  const wantedAt = wanted === null ? -1 : turns.rows.findIndex((t) => t.promptId === wanted);
  const first = Math.max(0, turns.rows.length - TURN_PAGE * pagesShown);

  // A named turn above the shown ones is shown; one the person-typed list does not hold widens it once.
  const widened = useRef(false);
  useEffect(() => {
    if (wanted === null || turns.walking || turns.isPending) return;
    if (wantedAt >= 0) {
      if (wantedAt < first) setPagesShown(Math.ceil((turns.rows.length - wantedAt) / TURN_PAGE));
      return;
    }
    if (!showAll && !widened.current) { widened.current = true; setShowAll(true); }
  }, [wanted, wantedAt, first, turns.walking, turns.isPending, turns.rows.length, showAll]);

  const earlier = first;
  return (
    <div className="flex flex-col gap-s4">
      <div className="flex items-center justify-end gap-s2">
        <label htmlFor={toggleId} className="t-small text-muted">Show prompts from the system and sub-agents</label>
        <Switch id={toggleId} checked={showAll} onCheckedChange={(next) => { setShowAll(next); setPagesShown(1); }} />
      </div>
      {turns.isPending || turns.walking ? (
        <LoadingState label="Loading the conversation" count={3} />
      ) : turns.error ? (
        <ErrorState error={turns.error} onRetry={turns.retry} />
      ) : turns.rows.length === 0 ? (
        <EmptyState title={showAll ? 'Nothing captured in this session yet.' : 'No prompts a person typed. Show the prompts from the system and sub-agents to see what ran.'} />
      ) : (
        <>
          {earlier > 0 && (
            <Button variant="secondary" className="w-fit" onClick={() => setPagesShown((n) => n + 1)}>
              Show {count(Math.min(earlier, TURN_PAGE), 'earlier turn')}
            </Button>
          )}
          <ol aria-label="Conversation" className="flex flex-col gap-s8">
            {turns.rows.slice(first).map((turn) => (
              <Turn key={turn.promptId} projectId={projectId} sessionId={sessionId} turn={turn} scrollTo={turn.promptId === wanted} />
            ))}
          </ol>
          {!turns.complete && <p className="t-small text-muted">This conversation holds more turns than are listed here.</p>}
        </>
      )}
    </div>
  );
}
