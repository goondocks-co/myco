import { ToolUsageLine } from './Usage';
import { countEvidence, fileEditWords } from './evidence';
import { Button, CopyButton, Disclosure, ErrorState, FactRow, FactsPanel, Link, LoadingState, ShowMore, SlideOver } from '../../design';
import { releaseStateLabel, shortRef } from '../../components/release/release-labels';
import { useMe } from '../../hooks/use-me';
import { SESSION_ANSWER_KIND_PREFIX, useSessionChildren, useSessionLineage, type ContextInjectionRow, type SessionResponse, type SessionRow } from '../../hooks/use-sessions';
import { formatElapsed } from '../../lib/format';
import { memberLabel } from '../../lib/member-name';
import { workPlace } from '../today/words';
import { lineageName, sessionPagePath } from './Lineage';
import { RawData, type RawSection } from './RawData';
import { WhatCameOfIt } from './WhatCameOfIt';
import { agentName, count, memberName } from './words';
import { agoWords, dateTimeWords } from '@goondocks/myco-shared/time-words';

export interface SessionAboutProps {
  open: boolean;
  onClose: () => void;
  answer: SessionResponse;
  projectId: string;
  projectName: string;
  now: number;
  live: boolean;
  /** The part of the raw data a link named. */
  rawSection: RawSection | null;
}

/** What a reader checks or copies about a session, what came of it, and what it was captured from, beside the page and read only once opened. */
export function SessionAbout({ open, onClose, answer, projectId, projectName, now, live, rawSection }: SessionAboutProps) {
  const { session, outcome } = answer;
  const sporesHref = `?${new URLSearchParams({ tab: 'spores' })}`;
  return (
    <SlideOver open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="About this session" data-testid="session-about">
      <div className="flex flex-col gap-s4">
        <SessionContext projectId={projectId} sessionId={session.sessionId} />
        <Facts answer={answer} projectName={projectName} projectId={projectId} now={now} live={live} />
        <WhatCameOfIt projectId={projectId} outcome={outcome} open={session.endedAt === null} now={now} sporesHref={sporesHref} />
        <TechnicalDetails answer={answer} />
        <Disclosure summary="Not placed on a turn">
          <UnplacedRecords projectId={projectId} sessionId={session.sessionId} now={now} />
        </Disclosure>
        <RawData agent={session.agent} projectId={projectId} sessionId={session.sessionId} open={rawSection} now={now} />
      </div>
    </SlideOver>
  );
}

/**
 * What Myco served the session as a whole, read from its session-level context records: the start block, and the
 * context that reached no prompt the conversation shows.
 */
function SessionContext({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const records = useSessionChildren<ContextInjectionRow>(projectId, sessionId, 'context-injections');
  if (records.isPending) return null;
  if (records.error) return <p className="t-small text-muted" data-session-context="">Myco’s session context could not be read.</p>;
  const start = records.rows.some((record) => record.kind === 'cortex');
  const unattached = records.rows.filter((record) => record.kind.startsWith(SESSION_ANSWER_KIND_PREFIX)).length;
  if (!start && unattached === 0) return null;
  return (
    <ul className="flex flex-col gap-s1 t-small text-muted" data-session-context="">
      {start && <li>Myco gave this session the project’s instructions when it started</li>}
      {unattached > 0 && <li>Myco handed it spores or plans {count(unattached, 'time')}{records.hasMore ? ' or more' : ''} that no prompt shown here carries</li>}
    </ul>
  );
}

/** The facts a reader checks or copies. The session's id is only ever copied, never shown. */
function Facts({ answer, projectId, projectName, now, live }: { answer: SessionResponse; projectId: string; projectName: string; now: number; live: boolean }) {
  const { session, counts, release } = answer;
  const who = memberName(session);
  // The viewer's own machine, by its name or as "Your machine"; another member's machine is named by the Member row alone.
  const viewerId = useMe().data?.member?.id ?? null;
  const place = workPlace(session.runtimeLabel, session.memberId === null ? null : { id: session.memberId, label: session.memberLabel }, viewerId);
  const machine = place?.own === true ? place.machine : null;
  const endedBy = session.endedBy === null ? null : memberLabel({ id: session.endedBy, label: session.endedByLabel }) ?? 'a member';
  return (
    <FactsPanel
      actions={(
        <>
          {answer.resume != null && <CopyButton value={answer.resume.line} label="Copy resume command" variant="secondary" data-resume="" />}
          <CopyButton value={session.sessionId} label="Copy session id" variant="secondary" />
        </>
      )}
    >
      <FactRow term="Project">{projectName}</FactRow>
      <FactRow term="Agent">{agentName(session.agent)}</FactRow>
      {machine !== null && <FactRow term="Machine">{machine}</FactRow>}
      {who !== null && <FactRow term="Member">{who}</FactRow>}
      {session.branch !== null && <FactRow term="Branch" mono>{session.branch}</FactRow>}
      {session.originPath !== null && <FactRow term="Folder" mono>{session.originPath}</FactRow>}
      <FactRow term="Started">{dateTimeWords(session.startedAt ?? session.firstReceivedAt, now)}</FactRow>
      {session.endedAt !== null
        ? <FactRow term="Ended">{dateTimeWords(session.endedAt, now)}{endedBy !== null && ` by ${endedBy}`}</FactRow>
        : <FactRow term={live ? 'Live' : 'Went quiet'}>Last heard {agoWords(session.lastReceivedAt, now)}</FactRow>}
      <FactRow term={session.endedAt === null ? 'Time observed' : 'Wall time'}>{answer.metrics?.durationMs === null ? 'Not recorded' : formatElapsed(answer.metrics?.durationMs ?? Math.max(0, (session.endedAt ?? session.lastReceivedAt) - (session.startedAt ?? session.firstReceivedAt)))}</FactRow>
      <FactRow term="Tools">{answer.visibility.toolCalls === 'recorded' && (answer.metrics?.tools.length ?? 0) > 0 ? <ToolUsageLine tools={answer.metrics!.tools} /> : countEvidence(answer, 'toolCalls', 'tool call')}</FactRow>
      <FactRow term="Files">{fileEditWords(answer.fileEdits)}</FactRow>
      <FactRow term="Reported errors">{answer.reportedErrors == null || answer.visibility.reportedErrors === 'not_visible' ? 'Not visible' : `${count(answer.reportedErrors, 'call')} reported an error or a non-zero exit`}</FactRow>
      {session.launchParentSessionId !== null && <FactRow term="Launch">Launched by another agent</FactRow>}
      {answer.metrics?.tokens != null && <FactRow term="Tokens">{answer.metrics.tokens.toLocaleString()}, its sub-agents included</FactRow>}
      <FactRow term="Size">{[count(answer.turns, 'turn'), count(answer.promptEntries, 'prompt entry', 'prompt entries'), countEvidence(answer, 'toolCalls', 'tool call'), count(counts.responses, 'reply', 'replies')].join(' · ')}</FactRow>
      {release != null && <FactRow term="Release">{releaseStateLabel(release.state)}{release.ref !== null && release.state !== 'not_on_release_line' ? ` · ${shortRef(release.ref)}` : ''}</FactRow>}
      <Family projectId={projectId} session={session} />
    </FactsPanel>
  );
}

/** What only someone checking how the session was recorded needs: calls made inside other calls, and tokens its agent didn't report. */
function TechnicalDetails({ answer }: { answer: SessionResponse }) {
  return (
    <Disclosure summary="Technical details">
      <FactsPanel>
        <FactRow term="Calls inside other calls">{answer.visibility.nestedToolCalls === 'not_visible'
          ? 'This agent doesn’t record them'
          : `${count(answer.nestedToolCalls, 'tool call')} ran inside another call, such as one that started a sub-agent`}</FactRow>
        {answer.metrics?.tokens == null && <FactRow term="Tokens">This agent didn’t report how many it used</FactRow>}
      </FactsPanel>
    </Disclosure>
  );
}

/** How many children the facts name: exact when the family was read whole, a lower bound when a bound cut it short. */
function childrenWords(children: number, truncated: boolean): string {
  if (!truncated) return count(children, 'session');
  return children === 0 ? 'Not all counted' : `${children}+ ${children === 1 ? 'session' : 'sessions'}`;
}

/**
 * The session's parents, each by name, and how many children it has, which open the lineage. A failed read says so
 * with a retry, beside whatever an earlier read already showed.
 */
function Family({ projectId, session }: { projectId: string; session: SessionRow }) {
  const lineage = useSessionLineage(projectId, session.sessionId);
  if (lineage.isPending) return null;
  const failed = lineage.error !== null && (
    <FactRow term="Family">
      <span data-family-error="">Could not be read</span>{' '}
      <Button size="sm" variant="ghost" className="tap-area" onClick={() => void lineage.refetch()}>Retry</Button>
    </FactRow>
  );
  if (lineage.data === undefined) return failed;
  const byId = new Map(lineage.data.nodes.map((node) => [node.sessionId, node]));
  const parents = lineage.data.edges.filter((edge) => edge.childId === session.sessionId);
  const children = new Set(lineage.data.edges.filter((edge) => edge.parentId === session.sessionId).map((edge) => edge.childId)).size;
  return (
    <>
      {parents.map((edge) => {
        const parent = byId.get(edge.parentId);
        const name = lineageName(parent);
        return (
          <FactRow key={`${edge.kind}:${edge.parentId}`} term="Parent">
            {parent?.captured === true ? <Link to={sessionPagePath(projectId, edge.parentId)} className="tap-area">{name}</Link> : name}
            {edge.kind === 'continuation' && <span className="block text-muted">This session continues it{edge.reason === null ? '' : ` (${edge.reason})`}</span>}
          </FactRow>
        );
      })}
      {(children > 0 || lineage.data.truncated) && (
        <FactRow term="Children">
          <Link to={`?${new URLSearchParams({ tab: 'lineage' })}`} className="tap-area">{childrenWords(children, lineage.data.truncated)}</Link>
        </FactRow>
      )}
      {failed}
    </>
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
            <time dateTime={new Date(record.createdAt).toISOString()} className="text-muted">{dateTimeWords(record.createdAt, now)}</time>
          </li>)}
        </ul>
        {records.hasMore && <ShowMore shown={records.rows.length} noun="records" onMore={records.more} pending={records.isFetchingMore} hasMore />}
      </div>)}
    </section>
  );
}
