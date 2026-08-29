import { type RefObject } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Input } from './input';
import { Button } from './button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';
import type { FilterDefinition } from './list-toolbar';

/*
 * Page-top filter bar. Renders above a MasterDetailSplit (or any list/detail
 * layout) at full page width, unlike <ListToolbar> which lives inside the
 * narrow master pane. Search + dropdown filters + optional result count.
 *
 * Phase 7 surfaces (Sessions, Skills) lift their filters out of the master
 * pane into this bar so the master never has to compete for horizontal space.
 */

export type { FilterDefinition };

export interface ListFilterBarProps {
  searchPlaceholder?: string;
  searchValue: string;
  onSearchChange: (value: string) => void;
  filters?: FilterDefinition[];
  filterValues?: Record<string, string>;
  onFilterChange?: (key: string, value: string) => void;
  onClear?: () => void;
  hasActiveFilters?: boolean;
  /** Forwarded to the underlying search input so callers can programmatically focus it. */
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Optional result count rendered on the far right (e.g. "12 sessions"). */
  count?: string;
  className?: string;
}

export function ListFilterBar({
  searchPlaceholder = 'Search...',
  searchValue,
  onSearchChange,
  filters = [],
  filterValues = {},
  onFilterChange,
  onClear,
  hasActiveFilters,
  inputRef,
  count,
  className,
}: ListFilterBarProps) {
  const computedHasActiveFilters = searchValue.trim().length > 0
    || filters.some((filter) => {
      const defaultValue = filter.options[0]?.value ?? 'all';
      return (filterValues[filter.key] ?? defaultValue) !== defaultValue;
    });
  const showClear = onClear && (hasActiveFilters ?? computedHasActiveFilters);

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-2.5 rounded-md bg-surface-container-low border border-[var(--ghost-border)]',
        className,
      )}
    >
      <Search className="h-4 w-4 text-on-surface-variant shrink-0" />
      <Input
        ref={inputRef}
        placeholder={searchPlaceholder}
        value={searchValue}
        onChange={(e) => onSearchChange(e.target.value)}
        className="bg-transparent border-none shadow-none focus-visible:ring-0 px-0 h-auto py-0 font-sans text-sm flex-1 min-w-[200px]"
        aria-label={searchPlaceholder}
      />
      {filters.map((filter) => (
        <div key={filter.key} className="w-44 shrink-0">
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
      {showClear && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={onClear}
          aria-label="Clear search and filters"
        >
          <X className="h-3.5 w-3.5" />
          Clear
        </Button>
      )}
      {count != null && (
        <span className="myco-eyebrow-sm shrink-0">{count}</span>
      )}
    </div>
  );
}
