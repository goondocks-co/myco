import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MasterDetailSplit } from '../components/ui/master-detail-split';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Row } from '../components/ui/row';
import { StatusDot } from '../components/ui/status-dot';
import { SubtabPill } from '../components/ui/subtab-pill';
import { SessionDetail } from '../components/sessions/SessionDetail';
import { useSessions, type SessionRow } from '../hooks/use-sessions';
import { formatRelative } from '../lib/format';

/** Open means no end was recorded — a runtime that died never ends its session, so this is what the data says, not a liveness claim. */
const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'ended', label: 'Ended' },
];

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high';

export const memberName = (s: SessionRow): string => s.memberLabel ?? s.memberId ?? s.createdByTokenId;
const runtimeName = (s: SessionRow): string | null => s.runtimeLabel ?? s.runtimeKind;

function matches(s: SessionRow, status: string, text: string): boolean {
  if (status === 'open' && s.endedAt !== null) return false;
  if (status === 'ended' && s.endedAt === null) return false;
  if (text === '') return true;
  const needle = text.toLowerCase();
  return [s.agent, s.branch, memberName(s), runtimeName(s), s.machineId, s.sessionId].some((v) => v !== null && v.toLowerCase().includes(needle));
}

/** `/p/:projectId/sessions` and `/p/:projectId/sessions/:sessionId`: what each runtime captured, session by session. Filtering is over the rows loaded so far. */
export function Sessions() {
  const { projectId = '', sessionId } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState('all');
  const [text, setText] = useState('');
  const sessions = useSessions(projectId);
  const base = `/p/${encodeURIComponent(projectId)}/sessions`;
  const shown = sessions.rows.filter((s) => matches(s, status, text));

  return (
    <PageContainer>
      <PageHeader title="Sessions" subtitle="What each runtime captured for this project, session by session." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SubtabPill tabs={STATUS_TABS} activeTab={status} onTabChange={setStatus} />
        <input
          type="search"
          aria-label="Filter sessions"
          placeholder="Filter by agent, branch, member…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1 font-sans text-sm text-on-surface"
        />
      </div>
      <PageLoading isLoading={sessions.isPending} error={sessions.error}>
        <div className="min-h-[60vh] rounded-lg border border-outline-variant/20">
          <MasterDetailSplit
            hasSelection={sessionId !== undefined}
            onCloseMobileDetail={() => navigate(base)}
            masterAriaLabel="Sessions"
            detailAriaLabel="Session"
            master={
              sessions.rows.length === 0 ? (
                <p className="p-4 font-sans text-sm text-on-surface-variant">No sessions yet. Sessions appear here as your runtimes capture them.</p>
              ) : shown.length === 0 ? (
                <p className="p-4 font-sans text-sm text-on-surface-variant">No sessions match.</p>
              ) : (
                <div role="table" aria-label="Sessions">
                  {shown.map((s) => (
                    <SessionRowView key={s.sessionId} session={s} active={s.sessionId === sessionId} onOpen={() => navigate(`${base}/${encodeURIComponent(s.sessionId)}`)} />
                  ))}
                  {sessions.hasMore && (
                    <div className="p-3">
                      <button type="button" className={button} onClick={sessions.more}>Load more</button>
                    </div>
                  )}
                </div>
              )
            }
            detail={sessionId === undefined ? <p className="font-sans text-sm text-on-surface-variant">Select a session to read it.</p> : <SessionDetail projectId={projectId} sessionId={sessionId} />}
          />
        </div>
      </PageLoading>
    </PageContainer>
  );
}

function SessionRowView({ session, active, onOpen }: { session: SessionRow; active: boolean; onOpen: () => void }) {
  const open = session.endedAt === null;
  return (
    <Row isActive={active} onClick={onOpen}>
      <div className="flex items-center gap-2 font-sans text-sm">
        <StatusDot tone={open ? 'sage' : 'outline'} />
        <span className="min-w-0 flex-1 truncate text-on-surface">{session.agent ?? 'session'}</span>
        {session.branch !== null && <span className="truncate font-mono text-[11px] text-on-surface-variant">{session.branch}</span>}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px] text-on-surface-variant">
        <span>{memberName(session)}</span>
        <span>{[runtimeName(session), session.machineId].filter((v) => v !== null).join(' · ') || '—'}</span>
        <span>{open ? `last ${formatRelative(session.lastReceivedAt)}` : `ended ${formatRelative(session.endedAt)}`}</span>
      </div>
    </Row>
  );
}
