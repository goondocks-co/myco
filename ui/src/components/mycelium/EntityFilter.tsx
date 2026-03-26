import { useState } from 'react';
import { Filter, Search, X } from 'lucide-react';
import { Input } from '../ui/input';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const ENTITY_TYPES = [
  { type: 'concept', label: 'Concept', dotColor: 'bg-primary' },
  { type: 'component', label: 'Component', dotColor: 'bg-secondary' },
  { type: 'bug', label: 'Bug', dotColor: 'bg-tertiary' },
  { type: 'tool', label: 'Tool', dotColor: 'bg-outline' },
  { type: 'file', label: 'File', dotColor: 'bg-outline' },
  { type: 'spore', label: 'Spore', dotColor: 'bg-primary' },
  { type: 'session', label: 'Session', dotColor: 'bg-secondary' },
  { type: 'other', label: 'Other', dotColor: 'bg-on-surface-variant' },
] as const;

const EDGE_TYPES = [
  { type: 'RELATES_TO', label: 'Relates To' },
  { type: 'DERIVES_FROM', label: 'Derives From' },
  { type: 'REFERENCES', label: 'References' },
  { type: 'DEPENDS_ON', label: 'Depends On' },
  { type: 'AFFECTS', label: 'Affects' },
] as const;

/* ---------- Types ---------- */

interface EntityFilterProps {
  entityCounts?: Record<string, number>;
  enabledTypes: Set<string>;
  onToggleType: (type: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  enabledEdgeTypes?: Set<string>;
  onToggleEdgeType?: (type: string) => void;
}

/* ---------- Component ---------- */

export function EntityFilter({
  entityCounts = {},
  enabledTypes,
  onToggleType,
  searchQuery,
  onSearchChange,
  enabledEdgeTypes,
  onToggleEdgeType,
}: EntityFilterProps) {
  const [open, setOpen] = useState(false);

  const totalNodes = Object.values(entityCounts).reduce((a, b) => a + b, 0);
  const activeFilterCount = ENTITY_TYPES.length - enabledTypes.size;

  return (
    <div className="absolute top-3 left-3 z-10">
      {/* Collapsed: compact toggle button */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 rounded-md bg-surface-container/90 backdrop-blur-sm px-3 py-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high/90 transition-colors shadow-sm"
          aria-label="Open graph filters"
        >
          <Filter className="h-3.5 w-3.5" />
          <span className="font-sans text-xs font-medium">Filters</span>
          {activeFilterCount > 0 && (
            <span className="font-mono text-[10px] bg-primary/20 text-primary rounded-full px-1.5 py-0.5 leading-none">
              {activeFilterCount}
            </span>
          )}
          <span className="font-mono text-[10px] text-on-surface-variant/50">{totalNodes}</span>
        </button>
      )}

      {/* Expanded: filter panel */}
      {open && (
        <div className="w-52 rounded-md bg-surface-container/95 backdrop-blur-md shadow-lg border border-outline-variant/20 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-outline-variant/10">
            <span className="font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant">
              Filters
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-on-surface-variant hover:text-on-surface transition-colors"
              aria-label="Close filters"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="p-3 space-y-4">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-on-surface-variant/50" />
              <Input
                placeholder="Search nodes..."
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                className="text-xs pl-7 h-7"
              />
            </div>

            {/* Entity type filters */}
            <div className="space-y-1">
              {ENTITY_TYPES.map((et) => {
                const count = entityCounts[et.type] ?? 0;
                const enabled = enabledTypes.has(et.type);
                return (
                  <label
                    key={et.type}
                    className="flex items-center gap-2 py-1 cursor-pointer group"
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={() => onToggleType(et.type)}
                      className="sr-only"
                    />
                    <div
                      className={cn(
                        'h-3 w-3 rounded-sm flex items-center justify-center transition-colors',
                        enabled ? 'bg-surface-container-high' : 'bg-surface-container-lowest',
                      )}
                    >
                      {enabled && <div className={cn('h-1.5 w-1.5 rounded-full', et.dotColor)} />}
                    </div>
                    <span
                      className={cn(
                        'font-sans text-xs transition-colors',
                        enabled ? 'text-on-surface' : 'text-on-surface-variant/50',
                      )}
                    >
                      {et.label}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-on-surface-variant/50">
                      {count}
                    </span>
                  </label>
                );
              })}
            </div>

            {/* Edge type filters */}
            {enabledEdgeTypes && onToggleEdgeType && (
              <div className="space-y-1 pt-1 border-t border-outline-variant/10">
                <div className="font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant/60 pt-1">
                  Edges
                </div>
                {EDGE_TYPES.map((et) => {
                  const enabled = enabledEdgeTypes.has(et.type);
                  return (
                    <label
                      key={et.type}
                      className="flex items-center gap-2 py-0.5 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => onToggleEdgeType(et.type)}
                        className="sr-only"
                      />
                      <div
                        className={cn(
                          'h-2.5 w-2.5 rounded-sm flex items-center justify-center transition-colors',
                          enabled ? 'bg-surface-container-high' : 'bg-surface-container-lowest',
                        )}
                      >
                        {enabled && <div className="h-1 w-1 rounded-full bg-outline" />}
                      </div>
                      <span
                        className={cn(
                          'font-sans text-[11px] transition-colors',
                          enabled ? 'text-on-surface-variant' : 'text-on-surface-variant/40',
                        )}
                      >
                        {et.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
