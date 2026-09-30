import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Button, focusRing, SearchCommand, SearchInput, Select, TypeChip, type SelectOption } from '../../design';
import {
  SEARCH_DEBOUNCE_MS, SEARCH_MIN_CHARS, SEARCH_RESULT_CAP, searchResultPath, useSearch, type SearchAcrossResult, type SearchScope,
} from '../../hooks/use-search';
import { cn } from '../../lib/cn';
import { capNote, SPORE_TYPES, sporeTypePlural, sporeTypeWord } from '../knowledge/words';

const DAY_SECONDS = 86_400;

/** The kinds of result, in the order the groups list them, each named as the reader names it. */
const GROUPS = [
  { type: 'spore', one: 'Spore', many: 'Spores' },
  { type: 'plan', one: 'Plan', many: 'Plans' },
  { type: 'session', one: 'Session', many: 'Sessions' },
  { type: 'prompt', one: 'Prompt', many: 'Prompts' },
  { type: 'response', one: 'Reply', many: 'Replies' },
] as const;

/** Skills are read from the catalogue Myco ships, not from a page here, so the filter never offers them and their hits are left out. */
const TYPE_OPTIONS: readonly SelectOption[] = [
  { value: 'all', label: 'Everything' },
  ...GROUPS.map((group) => ({ value: group.type, label: group.many })),
];

const SINCE_OPTIONS: readonly SelectOption[] = [
  { value: 'any', label: 'Any time' },
  { value: '1', label: 'Past day' },
  { value: '7', label: 'Past week' },
  { value: '30', label: 'Past month' },
];

const SPORE_TYPE_OPTIONS: readonly SelectOption[] = [
  { value: 'all', label: 'Every spore type' },
  ...SPORE_TYPES.map((type) => ({ value: type, label: sporeTypePlural(type) })),
];

/** A session the capture never titled is named by the end of its id; the reader gets what it says instead. */
const ID_TITLE = /^Session [\w-]{6}$/;

export interface SearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project "This project" searches: the one the page names, else the one last opened; null when there is none yet. */
  project: { projectId: string; name: string } | null;
  /** Whether the page itself names that project: then the search starts there, else across every project. */
  scoped: boolean;
  /** A project's name by its id, or null when the dashboard does not know it. */
  projectName: (projectId: string) => string | null;
}

/**
 * ⌘K: search this project or every project. A page under a project starts on
 * that project; any other page starts on everything. Results are grouped by
 * kind and led by what they say; across projects each names its project.
 * Mount it keyed by the project, so a change of project discards the query and
 * any answer still on its way.
 */
export function Search({ open, onOpenChange, project, scoped, projectName }: SearchProps) {
  const input = useRef<HTMLInputElement>(null);
  const [everything, setEverything] = useState(!scoped || project === null);
  const scope: SearchScope = everything || project === null ? 'all' : { projectId: project.projectId };
  return (
    <SearchCommand
      open={open}
      onOpenChange={onOpenChange}
      title={scope === 'all' ? 'Search every project' : `Search ${project!.name}`}
      description="Decisions, plans and conversations your agents captured."
      initialFocus={input}
    >
      <SearchBody
        scope={scope}
        projectLabel={project?.name ?? null}
        onScope={(all) => { setEverything(all); input.current?.focus(); }}
        inputRef={input}
        onPicked={() => onOpenChange(false)}
        projectName={projectName}
      />
    </SearchCommand>
  );
}

interface SearchBodyProps {
  scope: SearchScope;
  /** The project "This project" names, or null when there is none to offer. */
  projectLabel: string | null;
  onScope: (everything: boolean) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onPicked: () => void;
  projectName: (projectId: string) => string | null;
}

function SearchBody({ scope, projectLabel, onScope, inputRef, onPicked, projectName }: SearchBodyProps) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [sinceDays, setSinceDays] = useState('any');
  const [since, setSince] = useState('');
  const [observationType, setObservationType] = useState('all');
  const results = useRef<HTMLDivElement>(null);
  const ready = text.trim() === query && query.length >= SEARCH_MIN_CHARS;
  const search = useSearch(scope, { query, type, since, observationType: observationType === 'all' ? '' : observationType }, ready);
  const all = scope === 'all';

  useEffect(() => {
    const handle = setTimeout(() => setQuery(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [text]);

  const links = () => [...(results.current?.querySelectorAll<HTMLAnchorElement>('a[data-result]') ?? [])];
  const moveIn = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    links()[0]?.focus();
  };
  const moveWithin = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const list = links();
    const index = list.indexOf(document.activeElement as HTMLAnchorElement);
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) inputRef.current?.focus();
    else list[Math.min(next, list.length - 1)]?.focus();
  };

  const shown = (search.data?.results ?? []).filter((hit) => hit.type !== 'skill');
  const groups = GROUPS.map((group) => ({ ...group, hits: shown.filter((hit) => hit.type === group.type) })).filter((group) => group.hits.length > 0);

  return (
    <>
      <SearchInput
        ref={inputRef}
        large
        label={all ? 'Search every project' : 'Search this project'}
        placeholder="Search spores, plans and sessions"
        hint="Esc"
        maxLength={512}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={moveIn}
      />
      <div className="flex flex-wrap items-center gap-s2">
        {projectLabel !== null && (
          <div role="group" aria-label="Search in" className="flex w-full min-w-0 rounded-control border border-line p-s1 sm:w-auto" data-search-scope="">
            <Button size="sm" variant={all ? 'ghost' : 'secondary'} aria-pressed={!all} onClick={() => onScope(false)} className="min-w-0 flex-1 truncate sm:flex-none">
              {projectLabel}
            </Button>
            <Button size="sm" variant={all ? 'secondary' : 'ghost'} aria-pressed={all} onClick={() => onScope(true)} className="shrink-0 max-sm:flex-1">
              Every project <span className="font-normal text-muted">· words only</span>
            </Button>
          </div>
        )}
        <div className="grid min-w-0 flex-1 basis-full grid-cols-2 gap-s2 sm:flex sm:basis-auto sm:flex-wrap">
          <Select label="Result type" value={type} onValueChange={(value) => { setType(value); setObservationType('all'); }} options={TYPE_OPTIONS} className="sm:w-select" />
          <Select
            label="Created within"
            value={sinceDays}
            onValueChange={(value) => {
              setSinceDays(value);
              setSince(value === 'any' ? '' : String(Math.floor(Date.now() / 1000) - Number(value) * DAY_SECONDS));
            }}
            options={SINCE_OPTIONS}
            className="sm:w-select"
          />
          {type === 'spore' && <Select label="Spore type" value={observationType} onValueChange={setObservationType} options={SPORE_TYPE_OPTIONS} className="sm:w-select-wide" />}
        </div>
      </div>
      <div ref={results} className="-mx-s2 overflow-y-auto px-s2" aria-busy={ready && search.isFetching} onKeyDown={moveWithin}>
        {/* A background read keeps what is shown, and the keyboard's place in it; only a search with nothing to show yet says it is searching. */}
        {text.trim().length < SEARCH_MIN_CHARS ? <p className="py-s3 t-small text-muted">Type at least two characters.</p>
          : !ready || (search.data === undefined && !search.isError) ? <p role="status" className="py-s3 t-small text-muted">Searching…</p>
          : search.data === undefined ? (
            <div role="alert" className="flex items-center gap-s3 py-s3 t-small text-bad">
              Search failed.
              <Button size="sm" onClick={() => void search.refetch()}>Try again</Button>
            </div>
          )
          : (
            <div className="flex flex-col gap-s4">
              <p role="status" className="t-meta text-muted" data-search-count="">
                {shown.length === 0 ? 'No results match this search.' : `${shown.length} ${shown.length === 1 ? 'result' : 'results'}`}
                {!all && search.data.provider_unavailable && ' · Search by meaning is unavailable, so this matched words.'}
              </p>
              {groups.map((group) => (
                <section key={group.type} aria-labelledby={`search-group-${group.type}`} className="flex flex-col gap-s1">
                  <h3 id={`search-group-${group.type}`} className="flex items-baseline gap-s2 px-s3 t-kicker text-faint">
                    {group.many}
                    <span className="font-normal tracking-normal normal-case">{group.hits.length}</span>
                  </h3>
                  <ul aria-label={group.many} className="flex flex-col">
                    {group.hits.map((hit) => (
                      <li key={`${hit.projectId}:${hit.type}:${hit.id}`}>
                        <ResultRow hit={hit} project={all ? projectName(hit.projectId) ?? 'A project' : null} onPicked={onPicked} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {search.data.results.length >= SEARCH_RESULT_CAP && <p className="t-meta text-muted">{capNote(SEARCH_RESULT_CAP)}</p>}
              {search.data.coverage.pending_blobs > 0 && (
                <p className="t-small text-muted">
                  Indexing {search.data.coverage.pending_blobs} captured bodies. More results will become available.
                </p>
              )}
            </div>
          )}
      </div>
      <p className="hidden border-t border-line pt-s3 t-meta text-faint sm:block">↑ ↓ to move · Enter to open · Esc to close</p>
    </>
  );
}

/** A hit's headline and its second line: a spore by its line and type, a plan or session by its title and what it says, a turn by what it says. */
function hitWords(hit: SearchAcrossResult): { headline: string; detail: string | null; chip: string | null } {
  const preview = hit.preview.trim();
  const title = hit.title.trim();
  if (hit.type === 'spore') return { headline: preview === '' ? `${sporeTypeWord(title)} spore` : preview, detail: null, chip: sporeTypeWord(title) };
  if (hit.type === 'session' && (title === '' || ID_TITLE.test(title))) return { headline: preview === '' ? 'Untitled session' : preview, detail: null, chip: null };
  if (hit.type === 'plan' || hit.type === 'session') return { headline: title, detail: preview === '' || preview === title ? null : preview, chip: null };
  return { headline: preview === '' ? title : preview, detail: null, chip: null };
}

function ResultRow({ hit, project, onPicked }: { hit: SearchAcrossResult; project: string | null; onPicked: () => void }) {
  const to = searchResultPath(hit.projectId, hit);
  const { headline, detail, chip } = hitWords(hit);
  const body = (
    <>
      <span className="line-clamp-2 t-body font-medium text-ink">{headline}</span>
      {detail !== null && <span className="line-clamp-1 min-w-0 break-words t-small text-muted">{detail}</span>}
      {(chip !== null || project !== null) && (
        <span className="flex min-w-0 flex-wrap items-center gap-s2 t-meta text-muted">
          {chip !== null && <TypeChip>{chip}</TypeChip>}
          {project !== null && <span data-result-project="">{project}</span>}
        </span>
      )}
    </>
  );
  const row = 'flex flex-col gap-s1 rounded-control px-s3 py-s2';
  if (to === null) return <div className={row}>{body}</div>;
  return (
    <RouterLink to={to} data-result="" onClick={onPicked} className={cn(row, 'transition-colors duration-120 hover:bg-surface-2 focus-visible:bg-surface-2', focusRing, 'focus-visible:-outline-offset-2')}>
      {body}
    </RouterLink>
  );
}
