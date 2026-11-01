import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Disclosure, EmptyState, ErrorState, LoadingState, ShowMore, Switch } from '../../design';
import { PROMPT_ORIGINS, useTurns, useNamedTurn, useSessionChildren, type PromptOrigin } from '../../hooks/use-sessions';
import { ConversationHits, ConversationSearchBar, useConversationQuery } from './ConversationSearch';
import { dateTime } from './words';
import { Turn } from './Turn';

/** The prompts a person typed: what the conversation shows by default. */
export const PERSON_ONLY: readonly PromptOrigin[] = ['user'];

/** A conversation opens at its newest page and reads earlier turns on request. A named turn is read independently. */
export function Conversation({ projectId, sessionId, agent = null, contexts, now }: { projectId: string; sessionId: string; agent?: string | null; contexts?: Record<string, { subagents: number }>; now: number }) {
  const [showAll, setShowAll] = useState(false);
  const toggleId = useId();
  const turns = useTurns(projectId, sessionId, showAll ? PROMPT_ORIGINS : PERSON_ONLY);
  const [params] = useSearchParams();
  const wanted = params.get('turn');
  const named = useNamedTurn(projectId, sessionId, wanted);
  const target = named.data?.rows[0];
  useEffect(() => { if (target !== undefined && target.origin !== 'user') setShowAll(true); }, [target]);
  const search = useConversationQuery();
  const searching = search.query !== '';
  const rows = [...new Map([...turns.rows, ...(target === undefined ? [] : [target])].map((row) => [row.promptId, row])).values()]
    .sort((a, b) => a.createdAt - b.createdAt || a.promptId.localeCompare(b.promptId));
  return (
    <div className="flex flex-col gap-s4">
      <ConversationSearchBar search={search} />
      {searching && <ConversationHits projectId={projectId} sessionId={sessionId} agent={agent} query={search.query} now={now} />}
      <div hidden={searching}>
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
                  <Turn key={turn.promptId} projectId={projectId} sessionId={sessionId} agent={agent} contexts={contexts} turn={turn} scrollTo={!searching && turn.promptId === (target?.promptId ?? wanted)} />
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
      <Disclosure summary="Not placed on a turn">
        <UnplacedRecords projectId={projectId} sessionId={sessionId} now={now} />
      </Disclosure>
    </div>
  );
}

interface UnplacedRecord { key: string; kind: string; id: string; label: string; createdAt: number; failed?: boolean }

/** What the session holds that no turn does: the conversation's own records, then what hooks recorded beside it. */
function UnplacedRecords({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const conversation = useSessionChildren<UnplacedRecord>(projectId, sessionId, 'unplaced-records');
  const hooks = useSessionChildren<UnplacedRecord>(projectId, sessionId, 'unplaced');
  if (conversation.isPending || hooks.isPending) return <LoadingState label="Reading records not placed on a turn" count={1} />;
  const failed = conversation.error ?? hooks.error;
  if (failed) return <ErrorState error={failed} onRetry={() => { conversation.retry(); hooks.retry(); }} />;
  if (conversation.rows.length === 0 && hooks.rows.length === 0) return <p className="t-small text-muted">No records to show here.</p>;
  return (
    <section aria-label="Not placed on a turn" className="flex flex-col gap-s3 border-t border-line pt-s4">
      <p className="t-small text-muted">These records belong to this session. No turn in this session matches them.</p>
      {[conversation, hooks].map((records, index) => records.rows.length > 0 && <div key={index} className="flex flex-col gap-s2">
        <ul aria-label={index === 0 ? 'Conversation records' : 'Hook records'} className="flex flex-col divide-y divide-line">
          {records.rows.map(record => <li key={record.key} className="flex flex-wrap justify-between gap-s2 py-s2 t-small">
            <span className={record.failed ? 'text-bad' : undefined}>{record.label}{record.failed ? ' · failed' : ''}</span>
            <time dateTime={new Date(record.createdAt).toISOString()} className="text-muted">{dateTime(record.createdAt, now)}</time>
          </li>)}
        </ul>
        {records.hasMore && <ShowMore shown={records.rows.length} noun="records" onMore={records.more} pending={records.isFetchingMore} hasMore />}
      </div>)}
    </section>
  );
}
