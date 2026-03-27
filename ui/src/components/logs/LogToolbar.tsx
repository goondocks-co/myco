import { Search, Radio, Clock } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { cn } from '../../lib/cn';
import { Surface } from '../ui/surface';
import { LOG_LEVELS, levelDotColor, type LogLevel } from '../../lib/constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogMode = 'live' | 'search';

interface LogToolbarProps {
  mode: LogMode;
  onModeChange: (mode: LogMode) => void;
  searchValue: string;
  onSearchChange: (value: string) => void;
  onSearchSubmit: () => void;
  activeLevel: LogLevel;
  onLevelChange: (level: LogLevel) => void;
  components: string[];
  activeComponents: Set<string>;
  onComponentToggle: (component: string) => void;
  onComponentsClear: () => void;
  timeRange: string;
  onTimeRangeChange: (range: string) => void;
  totalResults?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIME_RANGES = [
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LogToolbar({
  mode,
  onModeChange,
  searchValue,
  onSearchChange,
  onSearchSubmit,
  activeLevel,
  onLevelChange,
  components,
  activeComponents,
  onComponentToggle,
  onComponentsClear,
  timeRange,
  onTimeRangeChange,
  totalResults,
}: LogToolbarProps) {
  return (
    <Surface level="default" className="rounded-md p-3 space-y-2">
      {/* Row 1: Mode toggle, time range, search */}
      <div className="flex items-center gap-3">
        {/* Mode toggle */}
        <div className="flex items-center rounded-md bg-surface-container-low">
          <Button
            size="sm"
            variant={mode === 'live' ? 'default' : 'ghost'}
            className="h-7 gap-1.5 px-2.5 text-xs rounded-r-none"
            onClick={() => onModeChange('live')}
          >
            <Radio className="h-3 w-3" />
            Live
          </Button>
          <Button
            size="sm"
            variant={mode === 'search' ? 'default' : 'ghost'}
            className="h-7 gap-1.5 px-2.5 text-xs rounded-l-none"
            onClick={() => onModeChange('search')}
          >
            <Search className="h-3 w-3" />
            Search
          </Button>
        </div>

        {/* Time range (search mode only) */}
        {mode === 'search' && (
          <>
            <div className="h-5 w-px bg-outline-variant/30" />
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3 text-on-surface-variant/50" />
              {TIME_RANGES.map((r) => (
                <Button
                  key={r.value}
                  size="sm"
                  variant={timeRange === r.value ? 'default' : 'ghost'}
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() => onTimeRangeChange(r.value)}
                >
                  {r.label}
                </Button>
              ))}
            </div>
          </>
        )}

        {/* Search input */}
        <form
          className="ml-auto flex items-center gap-1.5"
          onSubmit={(e) => { e.preventDefault(); onSearchSubmit(); }}
        >
          <Input
            className="h-7 w-56 text-xs"
            placeholder={mode === 'search' ? 'Search logs...' : 'Filter messages...'}
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label="Search log messages"
          />
        </form>

        {/* Results count (search mode) */}
        {mode === 'search' && totalResults !== undefined && (
          <span className="text-[10px] font-mono text-on-surface-variant/50 tabular-nums whitespace-nowrap">
            {totalResults.toLocaleString()} results
          </span>
        )}
      </div>

      {/* Row 2: Level + component filters */}
      <div className="flex items-center gap-3">
        {/* Level filters */}
        <div className="flex items-center gap-1">
          {LOG_LEVELS.map((level) => (
            <Button
              key={level}
              size="sm"
              variant={activeLevel === level ? 'default' : 'ghost'}
              className="h-6 px-2 text-[10px] capitalize gap-1.5"
              onClick={() => onLevelChange(level)}
            >
              <div className={cn('h-1.5 w-1.5 rounded-full', levelDotColor(level))} />
              {level}
            </Button>
          ))}
        </div>

        {/* Component chips */}
        {components.length > 0 && (
          <>
            <div className="h-4 w-px bg-outline-variant/20" />
            <div className="flex items-center gap-1 flex-wrap">
              {components.map((comp) => (
                <Button
                  key={comp}
                  size="sm"
                  variant={activeComponents.has(comp) ? 'default' : 'ghost'}
                  className="h-5 px-1.5 text-[10px]"
                  onClick={() => onComponentToggle(comp)}
                >
                  {comp}
                </Button>
              ))}
              {activeComponents.size > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-[10px] text-on-surface-variant"
                  onClick={onComponentsClear}
                >
                  clear
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Surface>
  );
}
