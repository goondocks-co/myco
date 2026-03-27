import { useState, useEffect, useMemo, useCallback } from 'react';
import { PageHeader } from '../components/ui/page-header';
import { Pagination } from '../components/ui/pagination';
import { LogToolbar, type LogMode } from '../components/logs/LogToolbar';
import { LogTable } from '../components/logs/LogTable';
import { LogDetail } from '../components/logs/LogDetail';
import { useLogStream, useLogSearch, useLogDetail, type LogEntry } from '../hooks/use-logs';
import { cn } from '../lib/cn';
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
  return new Date(now - (ms[range] ?? ms['24h'])).toISOString();
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Logs() {
  const [mode, setMode] = useState<LogMode>('live');
  const [searchValue, setSearchValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeLevel, setActiveLevel] = useState<LogLevel>('debug');
  const [activeComponents, setActiveComponents] = useState<Set<string>>(new Set());
  const [timeRange, setTimeRange] = useState('24h');
  const [page, setPage] = useState(1);
  const [selectedEntry, setSelectedEntry] = useState<LogEntry | null>(null);

  // Live mode
  const { entries: liveEntries } = useLogStream();

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
  const [knownComponents, setKnownComponents] = useState<string[]>([]);
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
      if ((LEVEL_ORDER[e.level] ?? 0) < minLevel) return false;
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
  }, []);

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
        />
      </div>

      {/* Main content: table + optional detail panel */}
      <div className="flex flex-1 overflow-hidden mx-6 mb-6 rounded-lg border border-outline-variant/10">
        {/* Log table */}
        <div className={cn('flex flex-col', detailOpen ? 'w-3/5' : 'w-full')}>
          <LogTable
            entries={displayEntries}
            selectedId={selectedEntry?.id ?? null}
            onSelect={handleSelect}
            autoScroll={mode === 'live'}
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

        {/* Detail slide-out */}
        {detailOpen && selectedEntry && (
          <div className="w-2/5 border-l border-outline-variant/10">
            <LogDetail
              entry={selectedEntry}
              resolved={detailData?.resolved}
              onClose={() => setSelectedEntry(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
