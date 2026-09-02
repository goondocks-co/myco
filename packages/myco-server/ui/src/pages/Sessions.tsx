import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MasterDetailSplit } from '../components/ui/master-detail-split';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { SubtabPill } from '../components/ui/subtab-pill';
import { SessionDetail } from '../components/sessions/SessionDetail';
import { SessionRail } from '../components/sessions/SessionRail';
import type { SessionListFilters } from '../hooks/use-sessions';

/** Open means no end was recorded — a runtime that died never ends its session, so this is what the data says, not a liveness claim. */
const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'ended', label: 'Ended' },
];

/** How long the filter box waits after the last keystroke before the list is re-read. */
const FILTER_DEBOUNCE_MS = 250;

function stateOf(tab: string): SessionListFilters['state'] {
  return tab === 'open' || tab === 'ended' ? tab : undefined;
}

/** `/p/:projectId/sessions` and `/p/:projectId/sessions/:sessionId`: what each runtime captured, session by session. The state tabs and the filter box live in the URL, so a link carries them, and the server does the filtering. */
export function Sessions() {
  const { projectId = '', sessionId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('state') === 'open' || params.get('state') === 'ended' ? params.get('state')! : 'all';
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  // The last `q` this page wrote. A `q` that arrives from elsewhere — Back, Forward, a link — is adopted into the box rather than overwritten by the box's own debounce.
  const wroteQ = useRef(q);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const base = `/p/${encodeURIComponent(projectId)}/sessions`;

  const setParam = useCallback((key: string, value: string) => {
    if (key === 'q') wroteQ.current = value;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === '' || value === 'all') next.delete(key); else next.set(key, value);
      return next;
    }, { replace: true });
  }, [setParams]);

  useEffect(() => {
    if (q === wroteQ.current) return;
    wroteQ.current = q;
    setText(q);
  }, [q]);

  useEffect(() => {
    if (text.trim() === wroteQ.current) return;
    const handle = setTimeout(() => setParam('q', text.trim()), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [text, setParam]);

  const select = useCallback((id: string, options?: { replace?: boolean }) => {
    const search = params.toString();
    navigate(`${base}/${encodeURIComponent(id)}${search === '' ? '' : `?${search}`}`, options);
  }, [base, navigate, params]);

  // `branch` and `member` ride the URL for a link to carry; the rail has no control for them yet.
  const branch = params.get('branch') ?? undefined;
  const member = params.get('member') ?? undefined;
  const filters: SessionListFilters = { state: stateOf(status), q, branch, member };
  const filtered = status !== 'all' || q !== '' || branch !== undefined || member !== undefined;

  return (
    <PageContainer>
      <PageHeader title="Sessions" subtitle="What each runtime captured for this project, session by session." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SubtabPill tabs={STATUS_TABS} activeTab={status} onTabChange={(tab) => setParam('state', tab)} />
        <input
          ref={filterInputRef}
          type="search"
          aria-label="Filter sessions"
          placeholder="Filter by title, agent, branch…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1 font-sans text-sm text-on-surface"
        />
      </div>
      <div className="min-h-[60vh] rounded-lg border border-outline-variant/20">
        <MasterDetailSplit
          hasSelection={sessionId !== undefined}
          onCloseMobileDetail={() => navigate(`${base}${params.toString() === '' ? '' : `?${params.toString()}`}`)}
          masterAriaLabel="Sessions"
          detailAriaLabel="Session"
          master={<SessionRail projectId={projectId} selectedId={sessionId} filters={filters} filtered={filtered} filterInputRef={filterInputRef} onSelect={select} />}
          detail={sessionId === undefined ? <p className="font-sans text-sm text-on-surface-variant">Select a session to read it.</p> : <SessionDetail projectId={projectId} sessionId={sessionId} />}
        />
      </div>
    </PageContainer>
  );
}
