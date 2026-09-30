import { useCallback, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MasterDetailSplit } from '../components/ui/master-detail-split';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { SporeDetail } from '../components/spores/SporeDetail';
import { SporeRail } from '../components/spores/SporeRail';
import { formatLabel, OBSERVATION_TYPES, SPORE_STATUSES } from '../components/spores/labels';
import { SPORE_PAGE_SIZE, type SporeFilters } from '../hooks/use-intelligence';
import { FilterBar, useFilterParams, useQueryDraft, type FilterDefinition } from '../design';

/** The status the page opens on: what this project currently holds true. */
const DEFAULT_STATUS = 'active';

/** The status filter opens on what the project holds true now; every status is one pick away. */
const STATUS_FILTER: FilterDefinition = {
  key: 'status',
  label: 'Status',
  options: [
    { value: DEFAULT_STATUS, label: formatLabel(DEFAULT_STATUS) },
    ...SPORE_STATUSES.filter((status) => status !== DEFAULT_STATUS).map((status) => ({ value: status, label: formatLabel(status) })),
    { value: 'all', label: 'Every status' },
  ],
};

const TYPE_FILTER: FilterDefinition = {
  key: 'type',
  label: 'Type',
  options: [{ value: 'all', label: 'Every type' }, ...OBSERVATION_TYPES.map((type) => ({ value: type, label: formatLabel(type) }))],
};

const FILTER_KEYS = ['status', 'type'] as const;

/** The value each filter opens on; at that value it leaves the URL. */
const FILTER_DEFAULTS: Readonly<Record<string, string>> = { status: DEFAULT_STATUS, type: 'all' };

/** A change of query or filter starts the match at its first page. */
const RESETS = ['offset'] as const;

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
  const [params] = useSearchParams();
  const filterParams = useFilterParams(FILTER_KEYS, { defaults: FILTER_DEFAULTS, resets: RESETS });
  const status = filterParams.values.status === 'all' || isStatus(filterParams.values.status!) ? filterParams.values.status! : DEFAULT_STATUS;
  const type = isType(filterParams.values.type!) ? filterParams.values.type! : 'all';
  const q = filterParams.query;
  const offset = offsetOf(params.get('offset'));
  const draft = useQueryDraft(q, filterParams.setQuery, FILTER_DEBOUNCE_MS);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const base = `/p/${encodeURIComponent(projectId)}/spores`;

  const select = useCallback((id: string, options?: { replace?: boolean }) => {
    const search = params.toString();
    navigate(`${base}/${encodeURIComponent(id)}${search === '' ? '' : `?${search}`}`, options);
  }, [base, navigate, params]);

  const filters: SporeFilters = {
    status: status === 'all' ? undefined : status,
    type: type === 'all' ? undefined : type,
    q,
    limit: SPORE_PAGE_SIZE,
    offset,
  };

  return (
    <PageContainer>
      <PageHeader className="pb-0" title="Spores" subtitle="What this project learned, one observation at a time." />
      <FilterBar
        className="mb-4"
        searchLabel="Filter spores"
        placeholder="Filter by text"
        inputRef={filterInputRef}
        query={draft.text}
        onQueryChange={draft.setText}
        filters={[STATUS_FILTER, TYPE_FILTER]}
        values={{ status, type }}
        onFilterChange={filterParams.setFilter}
        onClear={() => { draft.reset(); filterParams.clear(); }}
      />
      <div className="min-h-[60vh] rounded-lg border border-outline-variant/20">
        <MasterDetailSplit
          hasSelection={sporeId !== undefined}
          onCloseMobileDetail={() => navigate(`${base}${params.toString() === '' ? '' : `?${params.toString()}`}`)}
          masterAriaLabel="Spores"
          detailAriaLabel="Spore"
          master={<SporeRail projectId={projectId} selectedId={sporeId} filters={filters} filterInputRef={filterInputRef} onSelect={select} onOffsetChange={(next) => filterParams.setMany({ offset: next === 0 ? '' : String(next) })} />}
          detail={sporeId === undefined ? <p className="font-sans text-sm text-on-surface-variant">Select a spore to read it.</p> : <SporeDetail projectId={projectId} sporeId={sporeId} />}
        />
      </div>
    </PageContainer>
  );
}
