import { useCallback, useMemo, type ReactNode, type RefObject } from 'react';
import { useSearchParams } from 'react-router-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from '../primitives/Button';
import { SearchInput } from '../primitives/Input';
import { Select, type SelectOption } from '../primitives/Select';

/** The value a filter holds when it filters nothing; it never reaches the URL. */
export const ANY = 'all';

export interface FilterDefinition {
  key: string;
  /** Names the select, as in "Agent" or "Type". */
  label: string;
  /** The first option is the unfiltered one, conventionally `{ value: 'all', label: 'Every agent' }`. */
  options: readonly SelectOption[];
}

export interface FilterBarProps {
  /** Names the search field and fills it when empty, as in "Search sessions". */
  searchLabel: string;
  /** Says what the search matches, as in "Filter by title, agent or branch"; defaults to the label. */
  placeholder?: string;
  query: string;
  onQueryChange: (query: string) => void;
  filters?: readonly FilterDefinition[];
  values?: Readonly<Record<string, string>>;
  onFilterChange?: (key: string, value: string) => void;
  /** Clears the query and every filter; the Clear button shows only while something is set. */
  onClear?: () => void;
  /** The result count in words, as in "134 sessions". */
  count?: ReactNode;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** A keyboard hint in the search field, such as "/". */
  hint?: ReactNode;
  className?: string;
}

/**
 * The one search-and-filter bar. The search field fills the row; every select
 * is the same width; the count sits at the end. On a phone the search takes the
 * first line and the selects wrap below it.
 */
export function FilterBar({
  searchLabel, placeholder, query, onQueryChange, filters = [], values = {}, onFilterChange, onClear, count, inputRef, hint, className,
}: FilterBarProps) {
  const active = query.trim() !== '' || filters.some((filter) => (values[filter.key] ?? defaultOf(filter)) !== defaultOf(filter));
  return (
    <div data-filter-bar="" role="search" className={cn('flex flex-wrap items-center gap-s2 sm:flex-nowrap', className)}>
      <SearchInput
        ref={inputRef}
        label={searchLabel}
        placeholder={placeholder}
        value={query}
        hint={hint}
        onChange={(event) => onQueryChange(event.target.value)}
        className="basis-full sm:basis-auto"
      />
      {filters.map((filter) => (
        <Select
          key={filter.key}
          label={filter.label}
          value={values[filter.key] ?? defaultOf(filter)}
          onValueChange={(value) => onFilterChange?.(filter.key, value)}
          options={filter.options}
          className="w-[176px] shrink-0"
        />
      ))}
      {onClear && active && (
        <Button variant="ghost" onClick={onClear} icon={<X aria-hidden className="size-s4" />} aria-label="Clear search and filters">
          Clear
        </Button>
      )}
      {count != null && <span className="ml-auto shrink-0 whitespace-nowrap pl-s2 t-small text-muted" aria-live="polite">{count}</span>}
    </div>
  );
}

function defaultOf(filter: FilterDefinition): string {
  return filter.options[0]?.value ?? ANY;
}

export interface FilterParams {
  query: string;
  values: Record<string, string>;
  setQuery: (query: string) => void;
  setFilter: (key: string, value: string) => void;
  clear: () => void;
}

/**
 * The FilterBar's state, held in the URL: `?q=` for the query and one
 * parameter per filter key, so back and forward restore a filtered list and a
 * filtered list is a link. A filter at its unfiltered value is left out.
 */
export function useFilterParams(keys: readonly string[]): FilterParams {
  const [params, setParams] = useSearchParams();
  const keyList = keys.join(',');
  const values = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of keyList.split(',').filter(Boolean)) out[key] = params.get(key) ?? ANY;
    return out;
  }, [params, keyList]);
  // A filter at ANY and an empty query leave the URL; a query is kept whatever it says, "all" included.
  const write = useCallback((key: string, value: string, unfiltered: readonly string[]) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (unfiltered.includes(value)) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  }, [setParams]);
  const setFilter = useCallback((key: string, value: string) => write(key, value, ['', ANY]), [write]);
  const setQuery = useCallback((query: string) => write('q', query, ['']), [write]);
  const clear = useCallback(() => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('q');
      for (const key of keyList.split(',').filter(Boolean)) next.delete(key);
      return next;
    }, { replace: true });
  }, [setParams, keyList]);
  return {
    query: params.get('q') ?? '',
    values,
    setQuery,
    setFilter,
    clear,
  };
}
