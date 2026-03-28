import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Toggle } from '../ui/toggle';
import { SearchResults } from './SearchResults';
import { useSearch, type SearchResult } from '../../hooks/use-search';

/** Debounce delay (ms) before firing a search query. */
const SEARCH_DEBOUNCE_MS = 300;

/** Number of results to display per search. */
const SEARCH_RESULTS_LIMIT = 20;

type SearchMode = 'semantic' | 'fts';

function getResultPath(result: SearchResult): string {
  switch (result.type) {
    case 'session':
      return `/sessions/${result.id}`;
    case 'spore':
      return `/mycelium?spore=${encodeURIComponent(result.id)}`;
    case 'plan':
      return result.session_id
        ? `/sessions/${result.session_id}?tab=plans&plan=${encodeURIComponent(result.id)}`
        : '/sessions';
    case 'prompt_batch':
      return result.session_id ? `/sessions/${result.session_id}` : '/sessions';
    case 'activity':
      return result.session_id ? `/sessions/${result.session_id}` : '/sessions';
    default:
      return '/';
  }
}

interface GlobalSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GlobalSearch({ open, onOpenChange }: GlobalSearchProps) {
  const navigate = useNavigate();
  const [inputValue, setInputValue] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('semantic');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce the query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(inputValue.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [inputValue]);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setInputValue('');
      setDebouncedQuery('');
      setHighlightedIndex(0);
      // Focus input after portal renders
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const { data, isLoading } = useSearch(debouncedQuery, mode);

  const results = (data?.results ?? []).slice(0, SEARCH_RESULTS_LIMIT);

  // Reset highlight when results change
  useEffect(() => {
    setHighlightedIndex(0);
  }, [results.length, debouncedQuery]);

  const handleSelect = useCallback(
    (result: SearchResult) => {
      const path = getResultPath(result);
      onOpenChange(false);
      navigate(path);
    },
    [navigate, onOpenChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (results.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const selected = results[highlightedIndex];
        if (selected) handleSelect(selected);
      }
    },
    [results, highlightedIndex, handleSelect],
  );

  const showEmpty = debouncedQuery.length > 2 && !isLoading && results.length === 0;
  const showPrompt = debouncedQuery.length <= 2 && !isLoading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl p-0 gap-0 overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        {/* Accessible title (visually hidden via sr-only) */}
        <DialogTitle className="sr-only">Search vault</DialogTitle>

        {/* Search input row */}
        <div className="flex items-center gap-2 border-b border-[var(--ghost-border)] pl-4 pr-12 py-3">
          <Search className="h-4 w-4 shrink-0 text-on-surface-variant" />
          <Input
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Search sessions, spores, plans…"
            className="border-0 shadow-none focus-visible:ring-0 px-0 h-auto text-base bg-surface-bright font-mono"
          />
          <div className="flex items-center gap-1 shrink-0">
            <Toggle
              size="sm"
              pressed={mode === 'semantic'}
              onPressedChange={() => setMode('semantic')}
              aria-label="Semantic search"
              title="Semantic (embedded knowledge)"
            >
              Semantic
            </Toggle>
            <Toggle
              size="sm"
              pressed={mode === 'fts'}
              onPressedChange={() => setMode('fts')}
              aria-label="Full-text search"
              title="Full text (raw data)"
            >
              Full Text
            </Toggle>
          </div>
        </div>

        {/* Results area */}
        <div className="max-h-96 overflow-y-auto">
          {isLoading && debouncedQuery.length > 2 && (
            <div className="px-4 py-8 text-center">
              <div className="flex flex-col items-center gap-2 text-on-surface-variant">
                <div className="h-4 w-32 rounded bg-muted animate-pulse" />
                <div className="h-3 w-24 rounded bg-muted animate-pulse" />
                <div className="h-3 w-28 rounded bg-muted animate-pulse" />
              </div>
            </div>
          )}

          {showPrompt && (
            <div className="px-4 py-8 text-center text-sm text-on-surface-variant">
              Type to search your vault…
            </div>
          )}

          {showEmpty && (
            <div className="px-4 py-8 text-center text-sm text-on-surface-variant">
              No results for <span className="font-medium text-on-surface">"{debouncedQuery}"</span>
            </div>
          )}

          {results.length > 0 && !isLoading && (
            <SearchResults
              results={results}
              onSelect={handleSelect}
              highlightedIndex={highlightedIndex}
            />
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t border-[var(--ghost-border)] px-4 py-2 flex items-center gap-4 text-xs text-on-surface-variant">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span><kbd className="font-mono">Esc</kbd> close</span>
          <span className="ml-auto">
            {data?.mode && results.length > 0 && `${results.length} result${results.length !== 1 ? 's' : ''} · ${data.mode}`}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
