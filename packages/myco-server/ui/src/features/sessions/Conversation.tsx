import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, EmptyState, ErrorState, LoadingState, Switch } from '../../design';
import { PROMPT_ORIGINS, useTurns, useNamedTurn, type PromptOrigin } from '../../hooks/use-sessions';
import { Turn } from './Turn';

/** The prompts a person typed: what the conversation shows by default. */
export const PERSON_ONLY: readonly PromptOrigin[] = ['user'];

/** A conversation opens at its newest page and reads earlier turns on request. A named turn is read independently. */
export function Conversation({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const [showAll, setShowAll] = useState(false);
  const toggleId = useId();
  const turns = useTurns(projectId, sessionId, showAll ? PROMPT_ORIGINS : PERSON_ONLY);
  const [params] = useSearchParams();
  const wanted = params.get('turn');
  const named = useNamedTurn(projectId, sessionId, wanted);
  const target = named.data?.rows[0];
  useEffect(() => { if (target !== undefined && target.origin !== 'user') setShowAll(true); }, [target]);
  const rows = [...new Map([...turns.rows, ...(target === undefined ? [] : [target])].map((row) => [row.promptId, row])).values()]
    .sort((a, b) => a.createdAt - b.createdAt || a.promptId.localeCompare(b.promptId));
  return (
    <div className="flex flex-col gap-s4">
      <div className="flex items-center justify-end gap-s2">
        <label htmlFor={toggleId} className="t-small text-muted">Show prompts from the system and sub-agents</label>
        <Switch id={toggleId} checked={showAll} onCheckedChange={setShowAll} />
      </div>
      {wanted !== null && named.error && <ErrorState error={named.error} onRetry={() => { void named.refetch(); }} />}
      {wanted !== null && named.isPending && <p role="status" className="t-small text-muted">Reading the linked turn…</p>}
      {wanted !== null && named.isSuccess && target === undefined && <p className="t-small text-muted">The linked turn is unavailable in this session.</p>}
      {turns.isPending ? (
        <LoadingState label="Loading the conversation" count={3} />
      ) : turns.error && rows.length === 0 ? (
        <ErrorState error={turns.error} onRetry={turns.retry} />
      ) : rows.length === 0 ? (
        <EmptyState title={showAll ? 'Nothing captured in this session yet.' : 'No prompts a person typed. Show the prompts from the system and sub-agents to see what ran.'} />
      ) : (
        <>
          {turns.error && <ErrorState error={turns.error} onRetry={turns.retry} />}
          {turns.hasMore && (
            <Button variant="secondary" className="w-fit" onClick={turns.more} disabled={turns.isFetchingMore}>
              {turns.isFetchingMore ? 'Reading earlier turns…' : 'Show earlier turns'}
            </Button>
          )}
          {target !== undefined && !turns.rows.some((row) => row.promptId === target.promptId) && <p className="t-small text-muted">The linked turn is shown alongside the latest turns. More turns may sit between them.</p>}
          <ol aria-label="Conversation" className="flex flex-col gap-s8">
            {rows.map((turn) => (
              <Turn key={turn.promptId} projectId={projectId} sessionId={sessionId} turn={turn} scrollTo={turn.promptId === (target?.promptId ?? wanted)} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
