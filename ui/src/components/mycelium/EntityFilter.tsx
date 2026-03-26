import { Surface } from '../ui/surface';
import { Input } from '../ui/input';

const ENTITY_TYPES = [
  { type: 'concept', label: 'Concept', color: 'text-primary' },
  { type: 'component', label: 'Component', color: 'text-secondary' },
  { type: 'bug', label: 'Bug', color: 'text-tertiary' },
  { type: 'tool', label: 'Tool', color: 'text-outline' },
  { type: 'file', label: 'File', color: 'text-outline' },
  { type: 'other', label: 'Other', color: 'text-on-surface-variant' },
] as const;

interface EntityFilterProps {
  entityCounts?: Record<string, number>;
  enabledTypes: Set<string>;
  onToggleType: (type: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export function EntityFilter({ entityCounts = {}, enabledTypes, onToggleType, searchQuery, onSearchChange }: EntityFilterProps) {
  return (
    <Surface level="default" className="w-[200px] shrink-0 p-4 space-y-4">
      <div className="font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant">Entities</div>
      <Input placeholder="Search entities..." value={searchQuery} onChange={(e) => onSearchChange(e.target.value)} className="text-xs" />
      <div className="space-y-1">
        {ENTITY_TYPES.map((et) => {
          const count = entityCounts[et.type] ?? 0;
          const enabled = enabledTypes.has(et.type);
          return (
            <label key={et.type} className="flex items-center gap-2 py-1 cursor-pointer text-sm">
              <input type="checkbox" checked={enabled} onChange={() => onToggleType(et.type)} className="accent-primary" />
              <span className={`font-sans text-sm ${enabled ? et.color : 'text-on-surface-variant/50'}`}>{et.label}</span>
              <span className="ml-auto font-mono text-xs text-on-surface-variant">{count}</span>
            </label>
          );
        })}
      </div>
    </Surface>
  );
}
