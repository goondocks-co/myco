import { Surface } from '../ui/surface';
import { Input } from '../ui/input';

/* ---------- Constants ---------- */

const ENTITY_TYPES = [
  { type: 'concept', label: 'Concept', dotColor: 'bg-primary' },
  { type: 'component', label: 'Component', dotColor: 'bg-secondary' },
  { type: 'bug', label: 'Bug', dotColor: 'bg-tertiary' },
  { type: 'tool', label: 'Tool', dotColor: 'bg-outline' },
  { type: 'file', label: 'File', dotColor: 'bg-outline' },
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
  return (
    <Surface level="default" className="w-[200px] shrink-0 p-4 space-y-5 overflow-y-auto max-h-full">
      {/* Search */}
      <div>
        <Input
          placeholder="Search entities..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="text-xs"
        />
      </div>

      {/* Entity type filters */}
      <div className="space-y-2">
        <div className="font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant">
          Entities
        </div>
        <div className="space-y-0.5">
          {ENTITY_TYPES.map((et) => {
            const count = entityCounts[et.type] ?? 0;
            const enabled = enabledTypes.has(et.type);
            return (
              <label
                key={et.type}
                className="flex items-center gap-2.5 py-1.5 cursor-pointer group"
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => onToggleType(et.type)}
                  className="sr-only"
                />
                {/* Custom checkbox with colored dot */}
                <div
                  className={`h-3.5 w-3.5 rounded-sm flex items-center justify-center transition-colors ${
                    enabled
                      ? 'bg-surface-container-high'
                      : 'bg-surface-container-lowest'
                  }`}
                >
                  {enabled && <div className={`h-2 w-2 rounded-full ${et.dotColor}`} />}
                </div>
                <span
                  className={`font-sans text-sm transition-colors ${
                    enabled
                      ? 'text-on-surface'
                      : 'text-on-surface-variant/50'
                  }`}
                >
                  {et.label}
                </span>
                <span className="ml-auto font-mono text-[10px] text-on-surface-variant/60">
                  {count}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Edge type filters */}
      {enabledEdgeTypes && onToggleEdgeType && (
        <div className="space-y-2">
          <div className="font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant">
            Edge Types
          </div>
          <div className="space-y-0.5">
            {EDGE_TYPES.map((et) => {
              const enabled = enabledEdgeTypes.has(et.type);
              return (
                <label
                  key={et.type}
                  className="flex items-center gap-2.5 py-1 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => onToggleEdgeType(et.type)}
                    className="sr-only"
                  />
                  <div
                    className={`h-3 w-3 rounded-sm flex items-center justify-center transition-colors ${
                      enabled
                        ? 'bg-surface-container-high'
                        : 'bg-surface-container-lowest'
                    }`}
                  >
                    {enabled && (
                      <div className="h-1.5 w-1.5 rounded-full bg-outline" />
                    )}
                  </div>
                  <span
                    className={`font-sans text-xs transition-colors ${
                      enabled
                        ? 'text-on-surface-variant'
                        : 'text-on-surface-variant/40'
                    }`}
                  >
                    {et.label}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </Surface>
  );
}
