import { Search } from 'lucide-react';
import { Input } from './input';
import { Surface } from './surface';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';

export interface FilterDefinition {
  key: string;
  label: string;
  options: { value: string; label: string }[];
}

export interface ListToolbarProps {
  searchPlaceholder?: string;
  searchValue: string;
  onSearchChange: (value: string) => void;
  filters?: FilterDefinition[];
  filterValues?: Record<string, string>;
  onFilterChange?: (key: string, value: string) => void;
}

export function ListToolbar({
  searchPlaceholder = 'Search...',
  searchValue,
  onSearchChange,
  filters = [],
  filterValues = {},
  onFilterChange,
}: ListToolbarProps) {
  return (
    <Surface level="bright" className="flex items-center gap-3 px-4 py-2 rounded-md">
      <Search className="h-3.5 w-3.5 text-on-surface-variant shrink-0" />
      <Input
        placeholder={searchPlaceholder}
        value={searchValue}
        onChange={(e) => onSearchChange(e.target.value)}
        className="bg-transparent border-none shadow-none focus-visible:ring-0 px-0 h-auto py-0 font-sans text-sm flex-1"
        aria-label={searchPlaceholder}
      />
      {filters.map((filter) => (
        <div key={filter.key} className="w-40 shrink-0">
          <Select
            value={filterValues[filter.key] ?? 'all'}
            onValueChange={(value) => onFilterChange?.(filter.key, value)}
          >
            <SelectTrigger>
              <SelectValue placeholder={filter.label} />
            </SelectTrigger>
            <SelectContent>
              {filter.options.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
    </Surface>
  );
}
