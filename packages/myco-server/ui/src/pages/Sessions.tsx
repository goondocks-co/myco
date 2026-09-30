import { useCallback, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MasterDetailSplit } from '../components/ui/master-detail-split';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { SessionDetail } from '../components/sessions/SessionDetail';
import { SessionRail } from '../components/sessions/SessionRail';
import type { SessionListFilters } from '../hooks/use-sessions';
import { FilterBar, useFilterParams, useQueryDraft, type FilterDefinition } from '../design';

/** Open means no end was recorded — a runtime that died never ends its session, so this is what the data says, not a liveness claim. */
const STATE_FILTER: FilterDefinition = {
  key: 'state',
  label: 'State',
  options: [
    { value: 'all', label: 'Open and ended' },
    { value: 'open', label: 'Open' },
    { value: 'ended', label: 'Ended' },
  ],
};

/** The filters the bar holds; `branch` and `member` ride the URL too, with no control yet, and Clear leaves them. */
const FILTER_KEYS = ['state'] as const;

/** How long the filter box waits after the last keystroke before the list is re-read. */
const FILTER_DEBOUNCE_MS = 250;

function stateOf(tab: string): SessionListFilters['state'] {
  return tab === 'open' || tab === 'ended' ? tab : undefined;
}

/** `/p/:projectId/sessions` and `/p/:projectId/sessions/:sessionId`: what each runtime captured, session by session. The state tabs and the filter box live in the URL, so a link carries them, and the server does the filtering. */
export function Sessions() {
  const { projectId = '', sessionId } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const filterParams = useFilterParams(FILTER_KEYS);
  const status = filterParams.values.state === 'open' || filterParams.values.state === 'ended' ? filterParams.values.state : 'all';
  const q = filterParams.query;
  const draft = useQueryDraft(q, filterParams.setQuery, FILTER_DEBOUNCE_MS);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const base = `/p/${encodeURIComponent(projectId)}/sessions`;

  const select = useCallback((id: string, options?: { replace?: boolean }) => {
    const search = params.toString();
    navigate(`${base}/${encodeURIComponent(id)}${search === '' ? '' : `?${search}`}`, options);
  }, [base, navigate, params]);

  const deleted = () => {
    const remaining = new URLSearchParams(params);
    for (const key of ['tab', 'turn', 'plan']) remaining.delete(key);
    navigate(`${base}${remaining.size === 0 ? '' : `?${remaining}`}`, { replace: true });
  };

  // `branch` and `member` ride the URL for a link to carry; the rail has no control for them yet.
  const branch = params.get('branch') ?? undefined;
  const member = params.get('member') ?? undefined;
  const filters: SessionListFilters = { state: stateOf(status), q, branch, member };
  const filtered = status !== 'all' || q !== '' || branch !== undefined || member !== undefined;

  return (
    <PageContainer>
      <PageHeader className="pb-0" title="Sessions" subtitle="What each runtime captured for this project, session by session." />
      <FilterBar
        className="mb-4"
        searchLabel="Filter sessions"
        placeholder="Filter by title, agent or branch"
        inputRef={filterInputRef}
        query={draft.text}
        onQueryChange={draft.setText}
        filters={[STATE_FILTER]}
        values={{ state: status }}
        onFilterChange={filterParams.setFilter}
        onClear={() => { draft.reset(); filterParams.clear(); }}
      />
      <div className="min-h-[60vh] rounded-lg border border-outline-variant/20">
        <MasterDetailSplit
          hasSelection={sessionId !== undefined}
          onCloseMobileDetail={() => navigate(`${base}${params.toString() === '' ? '' : `?${params.toString()}`}`)}
          masterAriaLabel="Sessions"
          detailAriaLabel="Session"
          master={<SessionRail projectId={projectId} selectedId={sessionId} filters={filters} filtered={filtered} filterInputRef={filterInputRef} onSelect={select} />}
          detail={sessionId === undefined ? <p className="font-sans text-sm text-on-surface-variant">Select a session to read it.</p> : <SessionDetail key={`${projectId}/${sessionId}`} projectId={projectId} sessionId={sessionId} onDeleted={deleted} />}
        />
      </div>
    </PageContainer>
  );
}
