import { forwardRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button, EmptyState, ErrorState, FilterPills, LoadingState, SearchInput, ShowMore, focusRing, selectedRow } from '../../design';
import type { ConversationHit } from '../../hooks/use-conversation-search';
import { SEARCH_MIN_CHARS } from '../../hooks/use-search';
import type { TurnFilter, TurnMarks, TurnOrder, TurnRow } from '../../hooks/use-sessions';
import { cn } from '../../lib/cn';
import { dayHeading } from '../today/words';
import { isMechanical } from './card-text';
import type { ConversationQuery } from './ConversationSearch';
import { promptPreview } from './Turn';
import { clockTime, count } from './words';

export const FILTER_OPTIONS: ReadonlyArray<{ value: TurnFilter; label: string }> = [
  { value: 'you', label: 'Your prompts' },
  { value: 'key', label: 'Key moments' },
  { value: 'failed', label: 'Failures' },
  { value: 'myco', label: 'Myco' },
  { value: 'all', label: 'Everything' },
];

const EMPTY_FILTER: Readonly<Record<TurnFilter, string>> = {
  you: 'No prompts a person typed. Everything shows what ran.',
  key: 'No key moments in this session yet.',
  failed: 'No tool call failed in this session.',
  myco: 'No Myco tool calls in this session.',
  all: 'Nothing captured in this session yet.',
};

const MARK_WORDS: ReadonlyArray<[keyof TurnMarks, string]> = [
  ['decisions', 'Decision'], ['rejected', 'Rejected'], ['corrections', 'Corrected'], ['errors', 'Fixed'], ['openQuestions', 'Open question'],
];

const rowFrame = cn('grid grid-timeline w-full gap-s2 border-b border-line py-s2 pl-s2 pr-s3 text-left hover:bg-surface-2', focusRing, 'focus-visible:-outline-offset-2');

/** Whether the row is a turn only the harness or the system started, drawn small and grey. */
function isBackground(origin: string): boolean {
  return origin !== 'user' && origin !== 'agent_dispatch';
}

function OutlineRow({ turn, to, open, replace, showError, agent }: { turn: TurnRow; to: string; open: boolean; replace: boolean; showError: boolean; agent: string | null }) {
  const time = <time dateTime={new Date(turn.createdAt).toISOString()} className="pt-px t-meta tabular-nums text-faint">{clockTime(turn.createdAt)}</time>;
  const prompt = promptPreview(turn, agent);
  if (isBackground(turn.origin)) {
    return (
      <Link to={to} replace={replace} aria-current={open ? 'true' : undefined} data-turn-row={turn.promptId} data-testid={`row-${turn.promptId}`} data-background="" className={cn(rowFrame, 'py-s1', open && selectedRow)}>
        {time}
        <span className="truncate t-meta text-muted">{turn.headline != null && !isMechanical(turn.headline) ? turn.headline : prompt}</span>
      </Link>
    );
  }
  const mechanical = isMechanical(turn.headline);
  const headline = mechanical ? null : turn.headline ?? null;
  const typed = turn.origin === 'user';
  const firstError = showError ? turn.toolRollup?.firstError ?? null : null;
  return (
    <Link to={to} replace={replace} aria-current={open ? 'true' : undefined} data-turn-row={turn.promptId} data-testid={`row-${turn.promptId}`} className={cn(rowFrame, open && selectedRow)}>
      {time}
      <span className="flex min-w-0 flex-col gap-px">
        {headline !== null ? (
          <>
            <span className="line-clamp-2 t-small font-medium text-ink">{headline}</span>
            <span className="truncate t-meta text-muted">{typed ? `“${prompt}”` : prompt}</span>
          </>
        ) : (
          <>
            <span className="line-clamp-2 t-small font-medium text-ink">{prompt}</span>
            {!mechanical && <span className="t-meta text-faint">Not summarized yet</span>}
          </>
        )}
        {firstError !== null && <span className="truncate t-mono text-bad" data-first-error="">{firstError}</span>}
        <span className="mt-s1 flex flex-wrap items-center gap-x-s2 gap-y-s1 t-meta text-faint">
          {turn.origin === 'agent_dispatch' && <span>Sub-agent</span>}
          {MARK_WORDS.filter(([mark]) => turn.marks?.[mark] === true).map(([mark, word]) => <span key={mark} className="font-medium text-ink-2">{word}</span>)}
          {turn.toolRollup != null && turn.failedTools > 0 && <span className="font-medium text-bad">{turn.failedTools.toLocaleString()} failed</span>}
          {turn.toolRollup != null && turn.mycoCalls > 0 && <span className="font-semibold text-primary">Myco {turn.mycoCalls.toLocaleString()}</span>}
          {turn.toolCallCount > 0 && <span className="ml-auto">{count(turn.toolCallCount, 'call')}</span>}
        </span>
      </span>
    </Link>
  );
}

/** The query marked where it first appears in the text. */
function Marked({ text, query }: { text: string; query: string }) {
  const at = query === '' ? -1 : text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark className="rounded-chip bg-warn-bg px-px text-warn">{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}

function HitRow({ hit, to, open, replace, query, agent }: { hit: ConversationHit; to: string | null; open: boolean; replace: boolean; query: string; agent: string | null }) {
  const body = (
    <>
      <time dateTime={new Date(hit.at).toISOString()} className="pt-px t-meta tabular-nums text-faint">{clockTime(hit.at)}</time>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="line-clamp-3 break-words t-small font-medium text-ink"><Marked text={hit.preview === '' ? 'Matched in this turn’s summary' : hit.preview} query={query} /></span>
        <span className="truncate t-meta text-muted">
          {hit.turn === null ? 'Not placed on a turn' : `“${promptPreview({ preview: hit.turn.preview, textChars: hit.turn.text_chars, blobKey: hit.turn.stored ? 'stored' : null }, agent)}”`}
        </span>
      </span>
    </>
  );
  if (to === null) return <div className={cn(rowFrame, 'hover:bg-transparent')}>{body}</div>;
  return <Link to={to} replace={replace} aria-current={open ? 'true' : undefined} data-turn-row={hit.turn?.prompt_id} className={cn(rowFrame, open && selectedRow)}>{body}</Link>;
}

/** Turns under the day each happened, as one list. */
function Outline({ rows, now, children }: { rows: readonly TurnRow[]; now: number; children: (turn: TurnRow) => ReactNode }) {
  const items: ReactNode[] = [];
  let day = '';
  for (const turn of rows) {
    const heading = dayHeading(turn.createdAt, now);
    if (heading !== day) {
      day = heading;
      items.push(<li key={`day-${heading}`} className="sticky top-0 z-[1] border-b border-line bg-surface-2 px-s3 py-s1 t-meta font-medium text-muted">{heading}</li>);
    }
    items.push(<li key={turn.promptId}>{children(turn)}</li>);
  }
  return <ol aria-label="Conversation">{items}</ol>;
}

export interface TurnRailProps {
  search: ConversationQuery;
  filter: TurnFilter;
  onFilter: (filter: TurnFilter) => void;
  order: TurnOrder;
  onOrder: () => void;
  /** Set while the list is centred on a linked turn: returns it to the session's newest. */
  onNewest: (() => void) | null;
  outline: { rows: readonly TurnRow[]; isPending: boolean; error: unknown; retry: () => void; hasMore: boolean; isFetchingMore: boolean; more: () => void };
  found: { hits: readonly ConversationHit[]; enabled: boolean; isPending: boolean; error: unknown; staleError: unknown; retry: () => void; hasMore: boolean; isFetchingMore: boolean; more: () => void };
  /** The open turn's id. */
  openId: string | null;
  linkTo: (promptId: string) => string;
  /** Whether stepping through turns leaves no history behind. */
  replace: boolean;
  agent: string | null;
  now: number;
}

/** Search above the filters above the outline of turns; a row or a hit opens its turn. */
export const TurnRail = forwardRef<HTMLDivElement, TurnRailProps>(function TurnRail({ search, filter, onFilter, order, onOrder, onNewest, outline, found, openId, linkTo, replace, agent, now }, listRef) {
  const { params, draft, query } = search;
  const searching = query !== '';
  return (
    <div data-turn-rail="" className="flex min-w-0 flex-col gap-s3 lg:sticky lg:top-s3 lg:max-h-[calc(100vh-var(--s-6))]">
      <div className="flex shrink-0 items-center gap-s2">
        <SearchInput label="Search this session" placeholder="Search what happened in this session" value={draft.text} onChange={(event) => draft.setText(event.target.value)} />
        {draft.text !== '' && <Button variant="ghost" size="sm" onClick={() => { draft.reset(); params.clear(); }}>Clear</Button>}
      </div>
      <FilterPills label="Show" options={FILTER_OPTIONS} value={searching ? null : filter} onChange={(next) => { if (searching) { draft.reset(); params.clear(); } onFilter(next); }} />
      <div className="flex shrink-0 items-center justify-between gap-s2 t-meta text-faint">
        {searching
          ? <span aria-live="polite">{found.enabled && !found.isPending ? `${count(found.hits.length, 'turn')}${found.hasMore ? ' so far' : ''} match` : ' '}</span>
          : <span aria-live="polite">{outline.isPending ? ' ' : `${outline.rows.length.toLocaleString()}${outline.hasMore ? '+' : ''} ${outline.rows.length === 1 && !outline.hasMore ? 'turn' : 'turns'}`}</span>}
        {!searching && (
          <span className="flex items-center gap-s1">
            {onNewest !== null && <Button variant="ghost" size="sm" onClick={onNewest}>Go to newest</Button>}
            <Button variant="ghost" size="sm" onClick={onOrder}>{order === 'desc' ? 'Newest first' : 'Oldest first'} <span aria-hidden>⇅</span></Button>
          </span>
        )}
      </div>
      <div ref={listRef} tabIndex={-1} className="min-h-0 flex-auto rounded-card border border-line bg-surface-1 outline-none lg:overflow-y-auto">
        {searching ? <SearchHits found={found} query={query} openId={openId} linkTo={linkTo} replace={replace} agent={agent} now={now} />
          : outline.isPending ? <div className="p-s3"><LoadingState label="Loading the conversation" count={3} /></div>
          : outline.error && outline.rows.length === 0 ? <div className="p-s3"><ErrorState error={outline.error} onRetry={outline.retry} /></div>
          : outline.rows.length === 0 ? <div className="p-s3"><EmptyState title={EMPTY_FILTER[filter]} /></div>
          : (
            <>
              {outline.error ? <div className="p-s3"><ErrorState error={outline.error} onRetry={outline.retry} /></div> : null}
              <Outline rows={outline.rows} now={now}>
                {(turn) => <OutlineRow turn={turn} to={linkTo(turn.promptId)} open={turn.promptId === openId} replace={replace} showError={filter === 'failed'} agent={agent} />}
              </Outline>
              {outline.hasMore && <div className="px-s3"><ShowMore shown={outline.rows.length} noun="turns" onMore={outline.more} pending={outline.isFetchingMore} hasMore /></div>}
            </>
          )}
      </div>
    </div>
  );
});

function SearchHits({ found, query, openId, linkTo, replace, agent, now }: Pick<TurnRailProps, 'found' | 'openId' | 'linkTo' | 'replace' | 'agent' | 'now'> & { query: string }) {
  if (!found.enabled) return <p role="status" className="p-s3 t-small text-muted">Search starts at {SEARCH_MIN_CHARS} characters.</p>;
  if (found.isPending) return <div className="p-s3"><LoadingState label="Searching this session" count={3} /></div>;
  if (found.error) return <div className="p-s3"><ErrorState error={found.error} onRetry={found.retry} /></div>;
  return (
    <>
      {found.staleError ? <div className="p-s3"><ErrorState error={found.staleError} onRetry={found.retry} /></div> : null}
      {found.hits.length === 0
        ? <div className="p-s3"><EmptyState title={`No turn in this session matches “${query}”.`} /></div>
        : (
          <ol aria-label="Matches">
            {found.hits.map((hit, index) => {
              const heading = dayHeading(hit.at, now);
              return (
                <li key={hit.key}>
                  {(index === 0 || dayHeading(found.hits[index - 1]!.at, now) !== heading) && <div className="sticky top-0 z-[1] border-b border-line bg-surface-2 px-s3 py-s1 t-meta font-medium text-muted">{heading}</div>}
                  <HitRow hit={hit} to={hit.turn === null ? null : linkTo(hit.turn.prompt_id)} open={hit.turn !== null && hit.turn.prompt_id === openId} replace={replace} query={query} agent={agent} />
                </li>
              );
            })}
          </ol>
        )}
      {found.hasMore && <div className="px-s3"><ShowMore shown={found.hits.length} noun="matches" onMore={found.more} pending={found.isFetchingMore} hasMore /></div>}
      <p className="px-s3 py-s2 t-meta text-faint">Turns not summarized yet are not searched.</p>
    </>
  );
}
