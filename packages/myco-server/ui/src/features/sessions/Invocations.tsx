import { Button, ErrorState, LoadingState } from '../../design';
import { useSessionInvocations } from '../../hooks/use-sessions';
import { dateTimeWords } from '@goondocks/myco-shared/time-words';

/** Sender reports name the session, with no claim about which turn they opened. */
export function SessionInvocations({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const facts = useSessionInvocations(projectId, sessionId);
  return <section aria-label="Session invocations" className="flex flex-col gap-s2">
    <h2 className="t-small font-medium">Session invocations</h2>
    {facts.isPending && <LoadingState label="Loading invocation reports" count={1} />}
    {facts.error && <ErrorState error={facts.error} onRetry={() => void facts.refetch()} />}
    {!facts.isPending && !facts.error && facts.rows.length === 0 && <p className="t-small text-muted">No invocation reports.</p>}
    <ul>{facts.rows.map(fact => <li key={`${fact.keyId}:${fact.traceId}:${fact.spanId}`} className="t-small">
      {[fact.keyLabel, fact.serviceName, fact.agentName].filter(Boolean).join(' · ')}{' · '}
      <time dateTime={new Date(fact.startAt).toISOString()}>{dateTimeWords(fact.startAt, now)}</time>{' – '}
      <time dateTime={new Date(fact.endAt).toISOString()}>{dateTimeWords(fact.endAt, now)}</time>
    </li>)}</ul>
    {facts.hasNextPage && <Button variant="secondary" disabled={facts.isFetchingNextPage} onClick={() => void facts.fetchNextPage({ cancelRefetch: false })}>
      {facts.isFetchingNextPage ? 'Reading reports…' : 'Show more reports'}
    </Button>}
  </section>;
}
