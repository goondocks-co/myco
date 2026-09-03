import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MasterDetailSplit } from '../components/ui/master-detail-split';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { SubtabPill } from '../components/ui/subtab-pill';
import { SporeDetail } from '../components/spores/SporeDetail';
import { SporeRail } from '../components/spores/SporeRail';
import { formatLabel, OBSERVATION_TYPES, SPORE_STATUSES } from '../components/spores/labels';
import { SPORE_PAGE_SIZE, type SporeFilters } from '../hooks/use-intelligence';

/** The status the page opens on: what this project currently holds true. */
const DEFAULT_STATUS = 'active';

const STATUS_TABS = [
  { id: 'all', label: 'All' },
  ...SPORE_STATUSES.map((status) => ({ id: status, label: formatLabel(status) })),
];

/** How long the filter box waits after the last keystroke before the list is re-read. */
const FILTER_DEBOUNCE_MS = 250;

const isStatus = (value: string | null): boolean => value !== null && (SPORE_STATUSES as readonly string[]).includes(value);
const isType = (value: string | null): boolean => value !== null && (OBSERVATION_TYPES as readonly string[]).includes(value);

const offsetOf = (raw: string | null): number => {
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

/** `/p/:projectId/spores` and `/p/:projectId/spores/:sporeId`: what this project learned, observation by observation. The status tabs, the type filter, the filter box and the page all live in the URL, so a link carries them, and the server does the filtering. */
export function Spores() {
  const { projectId = '', sporeId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') === 'all' || isStatus(params.get('status')) ? params.get('status')! : DEFAULT_STATUS;
  const type = isType(params.get('type')) ? params.get('type')! : 'all';
  const q = params.get('q') ?? '';
  const offset = offsetOf(params.get('offset'));
  const [text, setText] = useState(q);
  // The last `q` this page wrote. A `q` that arrives from elsewhere — Back, Forward, a link — is adopted into the box rather than overwritten by the box's own debounce.
  const wroteQ = useRef(q);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const base = `/p/${encodeURIComponent(projectId)}/spores`;

  // A change of filter starts the match at its first page; the page control moves the offset on its own.
  const setParam = useCallback((key: string, value: string, fallback: string) => {
    if (key === 'q') wroteQ.current = value;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === fallback) next.delete(key); else next.set(key, value);
      if (key !== 'offset') next.delete('offset');
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
    const handle = setTimeout(() => setParam('q', text.trim(), ''), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [text, setParam]);

  const select = useCallback((id: string) => {
    const search = params.toString();
    navigate(`${base}/${encodeURIComponent(id)}${search === '' ? '' : `?${search}`}`);
  }, [base, navigate, params]);

  const filters: SporeFilters = {
    status: status === 'all' ? undefined : status,
    type: type === 'all' ? undefined : type,
    q,
    limit: SPORE_PAGE_SIZE,
    offset,
  };
  const filtered = status !== DEFAULT_STATUS || type !== 'all' || q !== '';

  return (
    <PageContainer>
      <PageHeader title="Spores" subtitle="What this project learned, one observation at a time." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SubtabPill tabs={STATUS_TABS} activeTab={status} onTabChange={(tab) => setParam('status', tab, DEFAULT_STATUS)} />
        <select
          aria-label="Filter by type"
          value={type}
          onChange={(e) => setParam('type', e.target.value, 'all')}
          className="rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1 font-sans text-sm text-on-surface"
        >
          <option value="all">All types</option>
          {OBSERVATION_TYPES.map((t) => <option key={t} value={t}>{formatLabel(t)}</option>)}
        </select>
        <input
          ref={filterInputRef}
          type="search"
          aria-label="Filter spores"
          placeholder="Filter by text or type…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1 font-sans text-sm text-on-surface"
        />
      </div>
      <div className="min-h-[60vh] rounded-lg border border-outline-variant/20">
        <MasterDetailSplit
          hasSelection={sporeId !== undefined}
          onCloseMobileDetail={() => navigate(`${base}${params.toString() === '' ? '' : `?${params.toString()}`}`)}
          masterAriaLabel="Spores"
          detailAriaLabel="Spore"
          master={<SporeRail projectId={projectId} selectedId={sporeId} filters={filters} filtered={filtered} filterInputRef={filterInputRef} onSelect={select} onOffsetChange={(next) => setParam('offset', String(next), '0')} />}
          detail={sporeId === undefined ? <p className="font-sans text-sm text-on-surface-variant">Select a spore to read it.</p> : <SporeDetail projectId={projectId} sporeId={sporeId} />}
        />
      </div>
    </PageContainer>
  );
}
