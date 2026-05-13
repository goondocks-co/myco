import { useState, useEffect, useMemo, useCallback } from 'react';
import { PageHeader } from '../components/ui/page-header';
import { Pagination } from '../components/ui/pagination';
import { LogToolbar, type LogMode } from '../components/logs/LogToolbar';
import { LogTable } from '../components/logs/LogTable';
import { LogDetail } from '../components/logs/LogDetail';
import { SlideoutDetailPanel } from '../components/ui/slideout-detail-panel';
import { useLogStream, useLogSearch, useLogDetail, type LogEntry } from '../hooks/use-logs';
import { DEFAULT_PAGE_SIZE, LEVEL_ORDER, type LogLevel } from '../lib/constants';

/** Map time range presets to ISO from-timestamp. */
function timeRangeToFrom(range: string): string {
  const now = Date.now();
  const ms: Record<string, number> = {
    '15m': 15 * 60_000,
    '1h': 60 * 60_000,
    '6h': 6 * 60 * 60_000,
    '24h': 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
    '30d': 30 * 24 * 60 * 60_000,
  };
  return new Date(now - (ms[range] ?? 24 * 60 * 60_000)).toISOString();
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Logs() {
  // Hydrate initial state from URL query params (deep-link support)
  const initialParams = useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    const components = sp.get('component')?.split(',').filter(Boolean) ?? [];
    const level = sp.get('level') as LogLevel | null;
    const q = sp.get('q') ?? '';
    // If any filter param is present, start in search mode
    const hasFilters = components.length > 0 || !!level || !!q;
    return { components, level, q, hasFilters };
  }, []);

  const [mode, setMode] = useState<LogMode>(initialParams.hasFilters ? 'search' : 'live');
  const [searchValue, setSearchValue] = useState(initialParams.q);
  const [searchQuery, setSearchQuery] = useState(initialParams.q);
  const [activeLevel, setActiveLevel] = useState<LogLevel>(initialParams.level ?? 'debug');
  const [activeComponents, setActiveComponents] = useState<Set<string>>(new Set(initialParams.components));
  const [timeRange, setTimeRange] = useState('24h');
  const [page, setPage] = useState(1);
  const [selectedEntry, setSelectedEntry] = useState<LogEntry | null>(null);
  const [paused, setPaused] = useState(false);

  // Live mode
  const { entries: liveEntries, clear: clearLive } = useLogStream(paused);

  // Search mode
  const searchParams = useMemo(() => ({
    q: searchQuery || undefined,
    level: activeLevel !== 'debug' ? activeLevel : undefined,
    component: activeComponents.size > 0 ? Array.from(activeComponents).join(',') : undefined,
    from: timeRangeToFrom(timeRange),
    page,
    page_size: DEFAULT_PAGE_SIZE,
  }), [searchQuery, activeLevel, activeComponents, timeRange, page]);

  const { data: searchData } = useLogSearch(searchParams, mode === 'search');

  // Detail panel
  const { data: detailData } = useLogDetail(selectedEntry?.id ?? null);

  // Discover components from entries
  const [knownComponents, setKnownComponents] = useState<string[]>(initialParams.components);
  useEffect(() => {
    const source = mode === 'live' ? liveEntries : (searchData?.entries ?? []);
    setKnownComponents((prev) => {
      const known = new Set(prev);
      let changed = false;
      for (const e of source) {
        if (!known.has(e.component)) { known.add(e.component); changed = true; }
      }
      return changed ? Array.from(known).sort() : prev;
    });
  }, [liveEntries, searchData, mode]);

  // Filter live entries client-side (level + component + search)
  const filteredLiveEntries = useMemo(() => {
    const minLevel = LEVEL_ORDER[activeLevel] ?? 0;
    const search = searchValue.trim().toLowerCase();
    return liveEntries.filter((e) => {
      if ((LEVEL_ORDER[e.level as LogLevel] ?? 0) < minLevel) return false;
      if (activeComponents.size > 0 && !activeComponents.has(e.component)) return false;
      if (search && !e.message.toLowerCase().includes(search)) return false;
      return true;
    });
  }, [liveEntries, activeLevel, activeComponents, searchValue]);

  const displayEntries = mode === 'live' ? filteredLiveEntries : (searchData?.entries ?? []);

  // Handlers
  const handleModeChange = useCallback((newMode: LogMode) => {
    setMode(newMode);
    setSelectedEntry(null);
    // Reset the live buffer on mode toggle so re-entering live mode starts
    // from a fresh tail instead of replaying stale entries.
    if (newMode === 'live') {
      clearLive();
      setPaused(false);
    }
  }, [clearLive]);

  const handleSearchSubmit = useCallback(() => {
    setSearchQuery(searchValue);
    setPage(1);
  }, [searchValue]);

  const handleSelect = useCallback((entry: LogEntry) => {
    setSelectedEntry((prev) => prev?.id === entry.id ? null : entry);
  }, []);

  const handleComponentToggle = useCallback((comp: string) => {
    setActiveComponents((prev) => {
      const next = new Set(prev);
      if (next.has(comp)) next.delete(comp); else next.add(comp);
      return next;
    });
    setPage(1);
  }, []);

  const handleLevelChange = useCallback((level: LogLevel) => {
    setActiveLevel(level);
    setPage(1);
  }, []);

  const detailOpen = selectedEntry !== null;

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6">
        <PageHeader title="Logs" subtitle="Daemon log explorer" />
      </div>

      {/* Toolbar */}
      <div className="px-6 mb-3">
        <LogToolbar
          mode={mode}
          onModeChange={handleModeChange}
          searchValue={searchValue}
          onSearchChange={setSearchValue}
          onSearchSubmit={handleSearchSubmit}
          activeLevel={activeLevel}
          onLevelChange={handleLevelChange}
          components={knownComponents}
          activeComponents={activeComponents}
          onComponentToggle={handleComponentToggle}
          onComponentsClear={() => { setActiveComponents(new Set()); setPage(1); }}
          timeRange={timeRange}
          onTimeRangeChange={(r) => { setTimeRange(r); setPage(1); }}
          totalResults={mode === 'search' ? searchData?.total : undefined}
          paused={paused}
          onPausedToggle={() => setPaused((p) => !p)}
        />
      </div>

      {/* Main content: table */}
      <div className="flex flex-1 overflow-hidden mx-6 mb-6 rounded-lg border border-outline-variant/10">
        <div className="flex flex-col w-full">
          <LogTable
            entries={displayEntries}
            selectedId={selectedEntry?.id ?? null}
            onSelect={handleSelect}
            autoScroll={mode === 'live' && !paused}
            relativeTime={mode === 'live'}
            compact
          />
          {/* Pagination (search mode only) */}
          {mode === 'search' && searchData && (
            <div className="border-t border-outline-variant/10 px-3 py-2 bg-surface-container-low">
              <Pagination
                total={searchData.total}
                offset={(page - 1) * DEFAULT_PAGE_SIZE}
                limit={DEFAULT_PAGE_SIZE}
                onPageChange={(newOffset) => setPage(Math.floor(newOffset / DEFAULT_PAGE_SIZE) + 1)}
              />
            </div>
          )}
        </div>
      </div>

      <SlideoutDetailPanel
        open={detailOpen && !!selectedEntry}
        onClose={() => setSelectedEntry(null)}
        ariaLabel="Log entry detail"
      >
        {selectedEntry && (
          <LogDetail
            entry={selectedEntry}
            resolved={detailData?.resolved}
            onClose={() => setSelectedEntry(null)}
          />
        )}
      </SlideoutDetailPanel>
    </div>
  );
}
