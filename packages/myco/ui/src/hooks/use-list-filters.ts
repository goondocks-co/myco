import { useState, useCallback, useMemo } from 'react';
import { useDebounce } from './use-debounce';

/** Sentinel value for "show all" in filter dropdowns. */
export const FILTER_ALL = 'all';

export interface UseListFiltersOptions {
  /** Initial filter values (e.g., { status: 'all', agent: 'all' }). */
  initialFilters: Record<string, string>;
}

export interface UseListFiltersResult {
  searchInput: string;
  debouncedSearch: string | undefined;
  filterValues: Record<string, string>;
  offset: number;
  setOffset: (offset: number) => void;
  handleSearchChange: (value: string) => void;
  handleFilterChange: (key: string, value: string) => void;
  handleClearFilters: () => void;
  hasActiveFilters: boolean;
  /** Get the active value for a filter key (returns undefined if set to FILTER_ALL). */
  activeFilter: (key: string) => string | undefined;
}

export function useListFilters({ initialFilters }: UseListFiltersOptions): UseListFiltersResult {
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebounce(searchInput);
  const [filterValues, setFilterValues] = useState<Record<string, string>>(initialFilters);
  const [offset, setOffset] = useState(0);

  const handleFilterChange = useCallback((key: string, value: string) => {
    setFilterValues((prev) => ({ ...prev, [key]: value }));
    setOffset(0);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    setOffset(0);
  }, []);

  const handleClearFilters = useCallback(() => {
    setSearchInput('');
    setFilterValues(initialFilters);
    setOffset(0);
  }, [initialFilters]);

  const hasActiveFilters = useMemo(() => (
    searchInput.trim().length > 0
    || offset > 0
    || Object.entries(filterValues).some(([key, value]) => value !== (initialFilters[key] ?? FILTER_ALL))
  ), [filterValues, initialFilters, offset, searchInput]);

  const activeFilter = useCallback((key: string): string | undefined => {
    const val = filterValues[key];
    return val && val !== FILTER_ALL ? val : undefined;
  }, [filterValues]);

  return {
    searchInput,
    debouncedSearch: debouncedSearch.length > 0 ? debouncedSearch : undefined,
    filterValues,
    offset,
    setOffset,
    handleSearchChange,
    handleFilterChange,
    handleClearFilters,
    hasActiveFilters,
    activeFilter,
  };
}
