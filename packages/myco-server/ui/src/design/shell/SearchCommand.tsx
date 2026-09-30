import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { OBSERVATION_TYPES, formatLabel } from '../../components/spores/labels';
import { SEARCH_DEBOUNCE_MS, SEARCH_MIN_CHARS, SEARCH_TYPES, searchResultPath, useSearch, type SearchResult } from '../../hooks/use-search';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';
import { Button } from '../primitives/Button';
import { TypeChip } from '../primitives/Chip';
import { Dialog, DialogContent } from '../primitives/Dialog';
import { SearchInput } from '../primitives/Input';
import { Select, type SelectOption } from '../primitives/Select';

const DAY_SECONDS = 86_400;

const TYPE_WORD: Record<string, string> = { session: 'Session', spore: 'Spore', plan: 'Plan', prompt: 'Prompt', response: 'Response', skill: 'Skill' };

/** The kinds of result the filter offers. Skills are read from the catalogue Myco ships, not from a page here. */
const TYPE_OPTIONS: readonly SelectOption[] = [
  { value: 'all', label: 'Everything' },
  ...SEARCH_TYPES.filter((type) => type !== 'skill').map((type) => ({ value: type, label: `${TYPE_WORD[type]}s` })),
];

const MODE_OPTIONS: readonly SelectOption[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'semantic', label: 'Semantic' },
  { value: 'fts', label: 'Full text' },
];

const SINCE_OPTIONS: readonly SelectOption[] = [
  { value: 'any', label: 'Any time' },
  { value: '1', label: 'Past day' },
  { value: '7', label: 'Past week' },
  { value: '30', label: 'Past month' },
];

const SPORE_TYPE_OPTIONS: readonly SelectOption[] = [
  { value: 'all', label: 'Every spore type' },
  ...OBSERVATION_TYPES.map((type) => ({ value: type, label: formatLabel(type) })),
];

/** Opens and closes the search on ⌘K and Ctrl K, from anywhere on the page. */
export function useSearchShortcut(toggle: () => void): void {
  const latest = useRef(toggle);
  latest.current = toggle;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.isComposing) {
        event.preventDefault();
        latest.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

export interface SearchCommandProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project searched; null when there is none to search yet. */
  project: { projectId: string; name: string } | null;
}

/**
 * The ⌘K search: one wide field over the project picked in the nav, with its
 * filters beneath and the results led by what they say. Mount it keyed by the
 * project, so a change of project discards the query and any answer still on
 * its way.
 */
export function SearchCommand({ open, onOpenChange, project }: SearchCommandProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={project === null ? 'Search' : `Search ${project.name}`}
        description={project === null ? undefined : 'Decisions, plans and conversations captured in this project.'}
        className="top-[10vh] max-h-[80vh] max-w-[640px] translate-y-0"
        onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); }}
      >
        {project === null
          ? <p className="t-body text-muted">There is no project to search yet.</p>
          : <SearchBody projectId={project.projectId} inputRef={input} onPicked={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function SearchBody({ projectId, inputRef, onPicked }: { projectId: string; inputRef: RefObject<HTMLInputElement | null>; onPicked: () => void }) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [mode, setMode] = useState('auto');
  const [sinceDays, setSinceDays] = useState('any');
  const [since, setSince] = useState('');
  const [observationType, setObservationType] = useState('all');
  const results = useRef<HTMLUListElement>(null);
  const ready = text.trim() === query && query.length >= SEARCH_MIN_CHARS;
  const search = useSearch(projectId, { query, type, mode, since, observationType: observationType === 'all' ? '' : observationType }, ready);

  useEffect(() => {
    const handle = setTimeout(() => setQuery(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [text]);

  const moveIn = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    results.current?.querySelector('a')?.focus();
  };
  const moveWithin = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const links = [...event.currentTarget.querySelectorAll('a')];
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) inputRef.current?.focus();
    else links[Math.min(next, links.length - 1)]?.focus();
  };

  return (
    <>
      <SearchInput
        ref={inputRef}
        label="Search this project"
        placeholder="Search decisions, plans and conversations"
        hint="Esc"
        maxLength={512}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={moveIn}
        className="[&_input]:h-[44px] [&_input]:t-body"
      />
      <div className="grid grid-cols-2 gap-s2 sm:flex sm:flex-wrap">
        <Select label="Result type" value={type} onValueChange={(value) => { setType(value); setObservationType('all'); }} options={TYPE_OPTIONS} className="sm:w-[152px]" />
        <Select label="Search mode" value={mode} onValueChange={setMode} options={MODE_OPTIONS} className="sm:w-[152px]" />
        <Select
          label="Created within"
          value={sinceDays}
          onValueChange={(value) => {
            setSinceDays(value);
            setSince(value === 'any' ? '' : String(Math.floor(Date.now() / 1000) - Number(value) * DAY_SECONDS));
          }}
          options={SINCE_OPTIONS}
          className="sm:w-[152px]"
        />
        {type === 'spore' && <Select label="Spore type" value={observationType} onValueChange={setObservationType} options={SPORE_TYPE_OPTIONS} className="sm:w-[176px]" />}
      </div>
      <div className="-mx-s2 min-h-[120px] overflow-y-auto px-s2" aria-live="polite" aria-busy={ready && search.isFetching}>
        {text.trim().length < SEARCH_MIN_CHARS ? <p className="py-s3 t-small text-muted">Type at least two characters.</p>
          : !ready || search.isFetching ? <p role="status" className="py-s3 t-small text-muted">Searching…</p>
          : search.isError ? (
            <div role="alert" className="flex items-center gap-s3 py-s3 t-small text-bad">
              Search failed.
              <Button size="sm" onClick={() => void search.refetch()}>Try again</Button>
            </div>
          )
          : search.data && (
            <>
              {mode !== 'fts' && search.data.provider_unavailable && (
                <p role="status" className="pb-s2 t-small text-muted">
                  Semantic search is unavailable.{search.data.mode === 'fts' ? ' Showing full-text results.' : ' Choose full text to search by words.'}
                </p>
              )}
              {search.data.mode === 'semantic' && !search.data.provider_unavailable && (
                <p className="pb-s2 t-small text-muted">Searching summaries, decisions and plans. Choose full text for captured prompt and response bodies.</p>
              )}
              {search.data.results.length === 0 && !(search.data.mode === 'semantic' && search.data.provider_unavailable) && (
                <p className="py-s3 t-body text-muted">No results match this search.</p>
              )}
              <ul ref={results} aria-label="Search results" className="flex flex-col" onKeyDown={moveWithin}>
                {search.data.results.map((hit) => (
                  <li key={`${hit.type}:${hit.id}`}>
                    <ResultRow projectId={projectId} hit={hit} onPicked={onPicked} />
                  </li>
                ))}
              </ul>
              {search.data.coverage.pending_blobs > 0 && (
                <p role="status" className="pt-s3 t-small text-muted">
                  Indexing {search.data.coverage.pending_blobs} captured bodies. More results will become available.
                </p>
              )}
            </>
          )}
      </div>
      <p className="hidden border-t border-line pt-s3 t-meta text-faint sm:block">↑ ↓ to move · Enter to open · Esc to close</p>
    </>
  );
}

function ResultRow({ projectId, hit, onPicked }: { projectId: string; hit: SearchResult; onPicked: () => void }) {
  const to = searchResultPath(projectId, hit);
  const kind = TYPE_WORD[hit.type] ?? hit.type;
  // A prompt or response is titled by its kind alone; what it says leads instead.
  const titled = hit.title.trim() !== '' && hit.title.trim().toLowerCase() !== kind.toLowerCase();
  const body = (
    <>
      <span className="line-clamp-1 t-body font-medium text-ink">{titled ? hit.title : hit.preview}</span>
      <span className="flex min-w-0 items-start gap-s2">
        <TypeChip className="mt-[1px]">{kind}</TypeChip>
        {titled && <span className="line-clamp-2 min-w-0 break-words t-small text-muted">{hit.preview}</span>}
      </span>
    </>
  );
  const row = 'flex flex-col gap-s1 rounded-control px-s3 py-s3';
  if (to === null) return <div className={row}>{body}</div>;
  return (
    <RouterLink to={to} onClick={onPicked} className={cn(row, 'transition-colors duration-120 hover:bg-surface-2 focus-visible:bg-surface-2', focusRing, 'focus-visible:-outline-offset-2')}>
      {body}
    </RouterLink>
  );
}
