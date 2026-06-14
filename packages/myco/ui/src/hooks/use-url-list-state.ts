// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FILTER_ALL, type UseListFiltersResult } from './use-list-filters';
import { useDebounce } from './use-debounce';
import { parseOffset, pathnameWithSearchHash, updateQueryValues } from '../lib/url-state';

export interface UrlListFilterSpec {
  key: string;
  defaultValue?: string;
}

export interface UseUrlListStateOptions {
  filters: UrlListFilterSpec[];
  searchParam?: string;
  offsetParam?: string;
}

export function useUrlListState({
  filters,
  searchParam = 'q',
  offsetParam = 'offset',
}: UseUrlListStateOptions): UseListFiltersResult {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState(() =>
    new URLSearchParams(location.search).get(searchParam) ?? '',
  );
  const debouncedSearch = useDebounce(searchInput);

  useEffect(() => {
    const next = new URLSearchParams(location.search).get(searchParam) ?? '';
    setSearchInput((prev) => (prev === next ? prev : next));
  }, [location.search, searchParam]);

  const filterDefaults = useMemo(() => {
    const defaults = new Map<string, string>();
    for (const spec of filters) defaults.set(spec.key, spec.defaultValue ?? FILTER_ALL);
    return defaults;
  }, [filters]);

  const filterValues = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const values: Record<string, string> = {};
    for (const spec of filters) {
      const defaultValue = spec.defaultValue ?? FILTER_ALL;
      values[spec.key] = params.get(spec.key) ?? defaultValue;
    }
    return values;
  }, [filters, location.search]);

  const offset = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return parseOffset(params.get(offsetParam));
  }, [location.search, offsetParam]);

  const navigateWithParams = useCallback((params: URLSearchParams, options?: { replace?: boolean }) => {
    navigate(pathnameWithSearchHash(location.pathname, params, location.hash), options);
  }, [location.hash, location.pathname, navigate]);

  const setOffset = useCallback((nextOffset: number) => {
    const params = updateQueryValues(location.search, {
      [offsetParam]: { value: nextOffset, defaultValue: 0 },
    });
    navigateWithParams(params);
  }, [location.search, navigateWithParams, offsetParam]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    const params = updateQueryValues(location.search, {
      [searchParam]: { value },
      [offsetParam]: { value: 0, defaultValue: 0 },
    });
    navigateWithParams(params, { replace: true });
  }, [location.search, navigateWithParams, offsetParam, searchParam]);

  const handleFilterChange = useCallback((key: string, value: string) => {
    const defaultValue = filterDefaults.get(key) ?? FILTER_ALL;
    const params = updateQueryValues(location.search, {
      [key]: { value, defaultValue },
      [offsetParam]: { value: 0, defaultValue: 0 },
    });
    navigateWithParams(params);
  }, [filterDefaults, location.search, navigateWithParams, offsetParam]);

  const activeFilter = useCallback((key: string): string | undefined => {
    const val = filterValues[key];
    const defaultValue = filterDefaults.get(key) ?? FILTER_ALL;
    return val && val !== defaultValue ? val : undefined;
  }, [filterDefaults, filterValues]);

  return {
    searchInput,
    debouncedSearch: debouncedSearch.length > 0 ? debouncedSearch : undefined,
    filterValues,
    offset,
    setOffset,
    handleSearchChange,
    handleFilterChange,
    activeFilter,
  };
}
