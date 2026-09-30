import { Check, ChevronDown, Search } from 'lucide-react';
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../../lib/cn';
import { fieldFrame, focusRing, overlaySurface } from '../lib/classes';

const TOKEN_SPLIT = /[\s/_.:-]+/;
const TOKEN_SPLIT_GLOBAL = /[\s/_.:-]+/g;
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** Extra words the option matches against, such as a project's path. */
  searchText?: string;
  /** What the closed control shows for this option, when the list's words are longer than it has room for. */
  short?: string;
}

const normalize = (value: string): string => value.trim().toLowerCase();
const tokens = (value: string): string[] => normalize(value).split(TOKEN_SPLIT).filter(Boolean);

/**
 * How well an option matches a query, lower is better, or null for no match:
 * exact, prefix, substring, token prefix, every token, then the query with its
 * separators removed.
 */
export function searchableSelectRank(option: SearchableSelectOption, rawQuery: string): number | null {
  const query = normalize(rawQuery);
  if (query === '') return 0;
  const label = normalize(option.label);
  const value = normalize(option.value);
  const corpus = normalize(`${option.label} ${option.value} ${option.searchText ?? ''}`);
  const queryTokens = tokens(query);
  if (label === query || value === query) return 0;
  if (label.startsWith(query) || value.startsWith(query)) return 1;
  if (corpus.includes(query)) return 2;
  if (tokens(corpus).some((token) => token.startsWith(query))) return 3;
  if (queryTokens.length > 1 && queryTokens.every((token) => token.length >= 2 && corpus.includes(token))) return 4;
  const compactQuery = query.replace(TOKEN_SPLIT_GLOBAL, '');
  if (compactQuery !== '' && corpus.replace(TOKEN_SPLIT_GLOBAL, '').includes(compactQuery)) return 5;
  return null;
}

export interface SearchableSelectProps {
  /** The field's accessible name. */
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SearchableSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

/**
 * A select with a search field, for lists longer than eight. The trigger opens
 * a popup holding a combobox and its listbox: arrows move, Enter picks, Escape
 * closes and returns focus to the trigger.
 */
export function SearchableSelect({
  label,
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder = 'Search',
  emptyMessage = 'Nothing matches.',
  disabled = false,
  className,
  id,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const matches = useMemo(() => options
    .map((option) => ({ option, rank: searchableSelectRank(option, deferredQuery) }))
    .filter((entry): entry is { option: SearchableSelectOption; rank: number } => entry.rank !== null)
    // Before anything is typed the options keep the order given, so the unfiltered choice stays first.
    .sort((a, b) => (deferredQuery.trim() === '' ? 0 : a.rank - b.rank || COLLATOR.compare(a.option.label, b.option.label)))
    .map((entry) => entry.option), [options, deferredQuery]);

  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) { setQuery(''); return; }
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  // Opening highlights the current value; typing highlights the best match.
  useEffect(() => {
    if (!open) return;
    setActive(deferredQuery === '' ? Math.max(0, matches.findIndex((option) => option.value === value)) : 0);
  }, [open, deferredQuery, matches, value]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  const pick = (option: SearchableSelectOption) => { onValueChange(option.value); close(); };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(matches.length - 1, i + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0); }
    else if (event.key === 'End') { event.preventDefault(); setActive(Math.max(0, matches.length - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); const option = matches[active]; if (option) pick(option); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
  });

  return (
    <div ref={rootRef} className={cn('relative min-w-0', className)}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={selected ? `${label}: ${selected.label}` : label}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}
        className={cn(fieldFrame, focusRing, 'flex items-center justify-between gap-s2 text-left')}
      >
        <span className={cn('truncate', !selected && 'text-muted')}>{selected?.short ?? selected?.label ?? placeholder ?? label}</span>
        <ChevronDown aria-hidden className="size-s4 shrink-0 text-muted" />
      </button>

      {open && (
        <div className={cn(overlaySurface, 'absolute left-0 z-50 mt-s1 w-full min-w-[224px]')}>
          <div className="relative border-b border-line p-s2">
            <Search aria-hidden className="pointer-events-none absolute left-s4 top-1/2 size-s4 -translate-y-1/2 text-muted" />
            <input
              ref={searchRef}
              role="combobox"
              aria-label={`Search ${label.toLowerCase()}`}
              aria-expanded
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={matches.length > 0 ? optionId(active) : undefined}
              value={query}
              placeholder={searchPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              className={cn(fieldFrame, focusRing, 'h-control-sm pl-s8')}
            />
          </div>
          <ul id={listboxId} role="listbox" aria-label={label} className="max-h-[288px] overflow-y-auto p-s1">
            {matches.length === 0 && <li role="presentation" className="px-s2 py-s3 t-small text-muted">{emptyMessage}</li>}
            {matches.map((option, index) => {
              const isSelected = option.value === value;
              return (
                <li
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(option)}
                  className={cn(
                    'flex h-control-sm cursor-default items-center justify-between gap-s2 rounded-chip px-s2 t-control text-ink-2',
                    index === active && 'bg-surface-3 text-ink',
                    isSelected && 'text-ink',
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {isSelected && <Check aria-hidden className="size-s4 shrink-0 text-primary" />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
