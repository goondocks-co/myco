import { Check, ChevronDown, Search } from 'lucide-react';
import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/cn';
import { Input } from './input';

const SEARCH_TOKEN_SPLIT = /[\s/_.:-]+/;
const SEARCH_TOKEN_SPLIT_GLOBAL = /[\s/_.:-]+/g;
const LABEL_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export interface SearchableSelectOption {
  value: string;
  label: string;
  searchText?: string;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  sortOptions?: boolean;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  monospace?: boolean;
  renderOption?: (option: SearchableSelectOption) => ReactNode;
  renderValue?: (option: SearchableSelectOption) => ReactNode;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function tokenizeSearchText(value: string): string[] {
  return normalizeSearchText(value).split(SEARCH_TOKEN_SPLIT).filter(Boolean);
}

function shouldUseTokenMatch(queryTokens: string[]): boolean {
  return queryTokens.length > 1 && queryTokens.every((token) => token.length >= 2);
}

export function getSearchableSelectRank(
  option: SearchableSelectOption,
  rawQuery: string,
): number | null {
  const query = normalizeSearchText(rawQuery);
  if (query === '') {
    return 0;
  }

  const label = normalizeSearchText(option.label);
  const value = normalizeSearchText(option.value);
  const searchCorpus = normalizeSearchText(
    `${option.label} ${option.value} ${option.searchText ?? ''}`,
  );
  const queryTokens = tokenizeSearchText(query);
  const corpusTokens = tokenizeSearchText(searchCorpus);
  const compactQuery = query.replace(SEARCH_TOKEN_SPLIT_GLOBAL, '');
  const compactCorpus = searchCorpus.replace(SEARCH_TOKEN_SPLIT_GLOBAL, '');

  if (label === query || value === query) {
    return 0;
  }
  if (label.startsWith(query) || value.startsWith(query)) {
    return 1;
  }
  if (label.includes(query) || value.includes(query) || searchCorpus.includes(query)) {
    return 2;
  }
  if (corpusTokens.some((token) => token.startsWith(query))) {
    return 3;
  }
  if (shouldUseTokenMatch(queryTokens) && queryTokens.every((token) => searchCorpus.includes(token))) {
    return 4;
  }
  if (compactQuery !== '' && compactCorpus.includes(compactQuery)) {
    return 5;
  }

  return null;
}

export function SearchableSelect({
  options,
  value,
  onValueChange,
  placeholder = 'Select an option',
  searchPlaceholder = 'Search...',
  emptyMessage = 'No matching options.',
  disabled = false,
  sortOptions = false,
  className,
  triggerClassName,
  contentClassName,
  monospace = false,
  renderOption,
  renderValue,
}: SearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const processedOptions = useMemo(() => {
    const next = [...options];
    if (sortOptions) {
      next.sort((left, right) => (
        LABEL_COLLATOR.compare(left.label, right.label)
        || LABEL_COLLATOR.compare(left.value, right.value)
      ));
    }
    return next;
  }, [options, sortOptions]);

  const filteredOptions = useMemo(() => {
    const ranked = processedOptions
      .map((option) => ({ option, rank: getSearchableSelectRank(option, deferredQuery) }))
      .filter(
        (entry): entry is { option: SearchableSelectOption; rank: number } => entry.rank !== null,
      );

    ranked.sort((left, right) => (
      left.rank - right.rank
      || LABEL_COLLATOR.compare(left.option.label, right.option.label)
      || LABEL_COLLATOR.compare(left.option.value, right.option.value)
    ));

    return ranked.map((entry) => entry.option);
  }, [deferredQuery, processedOptions]);

  const selectedOption = processedOptions.find((option) => option.value === value);
  const fallbackSelectedOption = value
    ? { value, label: value }
    : undefined;
  const displayedOption = selectedOption ?? fallbackSelectedOption;

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-expanded={isOpen}
        aria-controls={listboxId}
        className={cn(
          'flex h-9 w-full items-center justify-between rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 py-2 text-left text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50',
          triggerClassName,
        )}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className={cn('truncate text-on-surface', !displayedOption && 'text-on-surface-variant/60')}>
          {displayedOption
            ? renderValue?.(displayedOption) ?? (
              <span className={cn(monospace && 'font-mono')}>{displayedOption.label}</span>
            )
            : placeholder}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </button>

      {isOpen ? (
        <div
          className={cn(
            'absolute left-0 right-0 z-50 mt-1 rounded-md border border-[var(--ghost-border)] bg-surface-container-highest shadow-ambient',
            contentClassName,
          )}
        >
          <div className="border-b border-[var(--ghost-border)] p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-on-surface-variant/70" />
              <Input
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="pl-9"
              />
            </div>
          </div>

          <div
            id={listboxId}
            role="listbox"
            className="max-h-72 overflow-y-auto p-1"
          >
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={cn(
                      'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm text-on-surface outline-none transition-colors hover:bg-surface-bright focus-visible:bg-surface-bright',
                      isSelected && 'bg-surface-bright',
                    )}
                    onClick={() => {
                      onValueChange(option.value);
                      setIsOpen(false);
                      triggerRef.current?.focus();
                    }}
                  >
                    <span className={cn('truncate', monospace && 'font-mono')}>
                      {renderOption?.(option) ?? option.label}
                    </span>
                    {isSelected ? <Check className="ml-2 h-4 w-4 shrink-0" /> : null}
                  </button>
                );
              })
            ) : (
              <div className="px-2 py-3 text-sm text-on-surface-variant">
                {emptyMessage}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
