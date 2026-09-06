import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './ui/dialog';
import { SEARCH_DEBOUNCE_MS, SEARCH_MIN_CHARS, searchResultPath, useSearch } from '../hooks/use-search';
import { OBSERVATION_TYPES, formatLabel } from './spores/labels';
import { SEARCH_TYPES } from '../../../src/read/search-types';

const TYPES = ['all', ...SEARCH_TYPES];
const DAY_SECONDS = 86_400;
const control = 'rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1 font-sans text-sm text-on-surface';

/** Mounted by project identity so switching projects discards the open dialog and its query. */
export function GlobalSearch({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [mode, setMode] = useState('auto');
  const [since, setSince] = useState('');
  const [observationType, setObservationType] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const ready = text.trim() === query && query.length >= SEARCH_MIN_CHARS;
  const search = useSearch(projectId, { query, type, mode, since, observationType }, open && ready);

  useEffect(() => {
    const handle = setTimeout(() => setQuery(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [text]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.isComposing) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 font-sans text-sm text-on-surface-variant hover:bg-surface-container-high">
          <Search className="h-4 w-4" /> Search <kbd className="ml-auto text-xs">⌘K / Ctrl K</kbd>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl" onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); }}>
        <DialogTitle>Search {projectName}</DialogTitle>
        <DialogDescription>Find decisions, plans, skills and captured conversations.</DialogDescription>
        <input ref={input} type="search" aria-label="Search project" placeholder="Search project memory…" maxLength={512}
          className={control} value={text} onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); results.current?.querySelector('a')?.focus(); } }} />
        <div className="flex flex-wrap gap-2">
          <select aria-label="Search mode" className={control} value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="auto">Automatic</option><option value="semantic">Semantic</option><option value="fts">Full text</option>
          </select>
          <select aria-label="Result type" className={control} value={type} onChange={(event) => { setType(event.target.value); setObservationType(''); }}>
            {TYPES.map((value) => <option key={value} value={value}>{value === 'all' ? 'All types' : `${value[0]!.toUpperCase()}${value.slice(1)}s`}</option>)}
          </select>
          <select aria-label="Created within" className={control} onChange={(event) => setSince(event.target.value ? String(Math.floor(Date.now() / 1000) - Number(event.target.value) * DAY_SECONDS) : '')}>
            <option value="">Any time</option><option value="1">Past day</option><option value="7">Past week</option><option value="30">Past month</option>
          </select>
          {type === 'spore' && <select aria-label="Spore type" className={control} value={observationType} onChange={(event) => setObservationType(event.target.value)}>
            <option value="">All spore types</option>
            {OBSERVATION_TYPES.map((value) => <option key={value} value={value}>{formatLabel(value)}</option>)}
          </select>}
        </div>
        <div className="max-h-[50vh] overflow-y-auto" aria-live="polite" aria-busy={ready && search.isFetching}>
          {text.trim().length < SEARCH_MIN_CHARS ? <p className="text-sm text-on-surface-variant">Type at least two characters.</p>
            : !ready || search.isFetching ? <p role="status">Searching…</p>
            : search.isError ? <p role="alert">Search failed. <button type="button" className="underline" onClick={() => void search.refetch()}>Try again</button></p>
            : search.data && <>
              {mode !== 'fts' && search.data.provider_unavailable && <p role="status">Semantic search is unavailable.{search.data.mode === 'fts' ? ' Showing full-text results.' : ' Choose full text to search by words.'}</p>}
              {search.data.mode === 'semantic' && !search.data.provider_unavailable && <p className="text-sm text-on-surface-variant">Searching summaries, decisions, plans and skills. Choose full text for captured prompt and response bodies.</p>}
              {search.data.results.length === 0 && !(search.data.mode === 'semantic' && search.data.provider_unavailable) && <p>No results match this search.</p>}
              <ul ref={results} aria-label="Search results" className="space-y-1" onKeyDown={(event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                event.preventDefault();
                const links = [...event.currentTarget.querySelectorAll('a')];
                const index = links.indexOf(document.activeElement as HTMLAnchorElement);
                const next = index + (event.key === 'ArrowDown' ? 1 : -1);
                if (next < 0) input.current?.focus(); else links[Math.min(next, links.length - 1)]?.focus();
              }}>
                {search.data.results.map((hit) => <li key={`${hit.type}:${hit.id}`}>
                  <Link to={searchResultPath(projectId, hit)} onClick={() => setOpen(false)} className="block rounded-md p-3 hover:bg-surface-container focus:bg-surface-container focus:outline-2 focus:outline-primary">
                    <span className="mr-2 font-mono text-xs uppercase text-on-surface-variant">{hit.type}</span><span className="font-sans font-medium">{hit.title}</span>
                    <p className="mt-1 break-words text-sm text-on-surface-variant">{hit.preview}</p>
                  </Link>
                </li>)}
              </ul>
              {search.data.coverage.pending_blobs > 0 && <p role="status" className="mt-3 text-sm text-on-surface-variant">Indexing {search.data.coverage.pending_blobs} captured bodies. More results will become available.</p>}
            </>}
        </div>
        <p className="font-mono text-xs text-on-surface-variant">↑ ↓ to move · Enter to open · Esc to close</p>
      </DialogContent>
    </Dialog>
  );
}
