import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
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

/** With more filters than this the selects size to their words, so the search keeps most of the row. */
export const FIXED_WIDTH_FILTERS = 2;

/** Under 1024px the selects share the lines below the search: three on a line, else two on a phone and all four on a tablet. */
const SELECT_GRID: Record<number, string> = {
  3: 'grid-cols-3',
  4: 'grid-cols-2 md:grid-cols-4',
};

/**
 * The one search-and-filter bar, on one row. The search field leads and fills
 * what the selects leave; the count sits at the end. Up to two selects share
 * one width; with more, each sizes to the words it shows (an option's `short`
 * form) and truncates past a bound, and the search keeps 55% of the row. Under
 * 1024px the search takes the first line and the selects share the lines below
 * it, so neither is squeezed to a stub.
 */
export function FilterBar({
  searchLabel, placeholder, query, onQueryChange, filters = [], values = {}, onFilterChange, onClear, count, inputRef, hint, className,
}: FilterBarProps) {
  const active = query.trim() !== '' || filters.some((filter) => (values[filter.key] ?? defaultOf(filter)) !== defaultOf(filter));
  const sized = filters.length > FIXED_WIDTH_FILTERS;
  const selects = filters.map((filter) => (
    <Select
      key={filter.key}
      label={filter.label}
      value={values[filter.key] ?? defaultOf(filter)}
      onValueChange={(value) => onFilterChange?.(filter.key, value)}
      options={filter.options}
      className={sized ? 'min-w-0 lg:w-auto lg:max-w-[168px]' : 'min-w-0 flex-1 basis-0 lg:w-[176px] lg:flex-none lg:basis-auto'}
    />
  ));
  return (
    <div data-filter-bar="" role="search" className={cn('flex flex-wrap items-center gap-s2 lg:flex-nowrap', className)}>
      <SearchInput
        ref={inputRef}
        label={searchLabel}
        placeholder={placeholder}
        value={query}
        hint={hint}
        onChange={(event) => onQueryChange(event.target.value)}
        className={cn('basis-full lg:basis-auto', sized && 'lg:min-w-[56%]')}
      />
      {sized ? <div className={cn('grid w-full gap-s2 lg:flex lg:w-auto lg:min-w-0 lg:shrink', SELECT_GRID[Math.min(filters.length, 4)])}>{selects}</div> : selects}
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
  /** Every filter's value, its default when the URL leaves it out. */
  values: Record<string, string>;
  setQuery: (query: string) => void;
  setFilter: (key: string, value: string) => void;
  /** Writes several parameters in one change to the URL; a value at its unfiltered form leaves it. */
  setMany: (changes: Readonly<Record<string, string>>) => void;
  /** Clears the query, every filter and every reset key in one change to the URL. */
  clear: () => void;
}

export interface FilterParamsOptions {
  /** The value a filter opens on, when it is not ANY; that value leaves the URL, and ANY is then written out. */
  defaults?: Readonly<Record<string, string>>;
  /** Parameters a change of query or filter drops, such as the page offset. */
  resets?: readonly string[];
}

/**
 * The FilterBar's state, held in the URL: `?q=` for the query and one
 * parameter per filter key, so back and forward restore a filtered list and a
 * filtered list is a link. A filter at its default is left out.
 *
 * Every change is ONE write to the URL: two writes in a row each start from
 * the params this render read, so the second would undo the first. Changing
 * several keys at once goes through `setMany`, and `clear` drops them all.
 */
export function useFilterParams(keys: readonly string[], options: FilterParamsOptions = {}): FilterParams {
  const [params, setParams] = useSearchParams();
  const keyList = keys.join(',');
  const defaults = options.defaults;
  const resetList = (options.resets ?? []).join(',');
  const defaultOf = useCallback((key: string) => defaults?.[key] ?? ANY, [defaults]);
  const values = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of keyList.split(',').filter(Boolean)) out[key] = params.get(key) ?? defaultOf(key);
    return out;
  }, [params, keyList, defaultOf]);
  const setMany = useCallback((changes: Readonly<Record<string, string>>) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      const filterKeys = keyList.split(',').filter(Boolean);
      let filtering = false;
      for (const [key, value] of Object.entries(changes)) {
        // A query is kept whatever it says, "all" included; a filter at its default leaves the URL, and ANY is written when it is not the default.
        const unfiltered = key === 'q' ? value === '' : value === '' || value === defaultOf(key);
        if (unfiltered) next.delete(key);
        else next.set(key, value);
        if (key === 'q' || filterKeys.includes(key)) filtering = true;
      }
      if (filtering) for (const key of resetList.split(',').filter(Boolean)) if (!(key in changes)) next.delete(key);
      return next;
    }, { replace: true });
  }, [setParams, keyList, resetList, defaultOf]);
  const setFilter = useCallback((key: string, value: string) => setMany({ [key]: value }), [setMany]);
  const setQuery = useCallback((query: string) => setMany({ q: query }), [setMany]);
  const clear = useCallback(() => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const key of ['q', ...keyList.split(','), ...resetList.split(',')].filter(Boolean)) next.delete(key);
      return next;
    }, { replace: true });
  }, [setParams, keyList, resetList]);
  return { query: params.get('q') ?? '', values, setQuery, setFilter, setMany, clear };
}

export interface QueryDraft {
  /** What the search box shows, ahead of the URL while the typing settles. */
  text: string;
  setText: (text: string) => void;
  /** Empties the box at once and forgets any write still waiting. */
  reset: () => void;
}

/**
 * The search box's text, written to the URL once typing pauses. A query that
 * arrives from elsewhere (Back, Forward, a link) is adopted into the box rather
 * than overwritten by the box's own pending write.
 */
export function useQueryDraft(query: string, setQuery: (query: string) => void, delayMs = 250): QueryDraft {
  const [text, setText] = useState(query);
  // The last query this box wrote.
  const wrote = useRef(query);
  useEffect(() => {
    if (query === wrote.current) return;
    wrote.current = query;
    setText(query);
  }, [query]);
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === wrote.current) return undefined;
    const handle = setTimeout(() => { wrote.current = trimmed; setQuery(trimmed); }, delayMs);
    return () => clearTimeout(handle);
  }, [text, setQuery, delayMs]);
  const reset = useCallback(() => { wrote.current = ''; setText(''); }, []);
  return { text, setText, reset };
}
