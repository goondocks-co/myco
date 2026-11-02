import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, COMPACT_QUERY, EmptyState, ErrorState, LoadingState } from '../../design';
import { useConversationSearch } from '../../hooks/use-conversation-search';
import { useMediaQuery } from '../../hooks/use-media-query';
import { TURN_FILTERS, useNamedTurn, useTurnOutline, type TurnFilter, type TurnOrder, type TurnRow } from '../../hooks/use-sessions';
import { useConversationQuery } from './ConversationSearch';
import { TurnReader } from './Turn';
import { TurnRail } from './TurnRail';

/** The URL keys of the outline's filter and order; switching tabs drops them. */
export const TURN_FILTER_KEY = 'filter';
export const TURN_ORDER_KEY = 'order';

/** A session with fewer typed prompts than this, among other turns, opens on every turn. */
const FEW_TYPED_PROMPTS = 3;

const asFilter = (value: string | null): TurnFilter | null => (TURN_FILTERS as readonly string[]).includes(value ?? '') ? value as TurnFilter : null;

function inFilter(turn: TurnRow, filter: TurnFilter): boolean {
  if (filter === 'you') return turn.origin === 'user';
  if (filter === 'key') return turn.signal === 'high';
  if (filter === 'failed') return turn.failedTools > 0;
  if (filter === 'myco') return turn.mycoCalls > 0;
  return true;
}

const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export interface ConversationProps {
  projectId: string;
  sessionId: string;
  agent?: string | null;
  contexts?: Record<string, { subagents: number }>;
  /** How many turns the session holds, of every origin. */
  turnsTotal: number;
  now: number;
}

/**
 * The conversation as an outline beside one open turn; on a narrow screen, the
 * outline and then the turn. The outline reads a page at a time and only the open
 * turn's body is read. `?turn=` names the open turn, and a link to one opens the
 * outline around it.
 */
export function Conversation({ projectId, sessionId, agent = null, contexts, turnsTotal, now }: ConversationProps) {
  const [params, setParams] = useSearchParams();
  const compact = useMediaQuery(COMPACT_QUERY);
  const wanted = params.get('turn');
  const requested = asFilter(params.get(TURN_FILTER_KEY));
  const order: TurnOrder = params.get(TURN_ORDER_KEY) === 'asc' ? 'asc' : 'desc';

  // The turn the address named when the page opened; the outline stays centred on it until asked to move or filtered anew.
  const [opened, setOpened] = useState(wanted);
  const [openedUnder] = useState(requested);
  const anchor = requested === openedUnder ? opened : null;
  const anchorRead = useNamedTurn(projectId, sessionId, anchor);
  const anchorTurn = anchorRead.data?.rows[0];
  const waiting = anchor !== null && anchorRead.isPending;

  const typedAround = anchorTurn !== undefined && anchorTurn.origin === 'user' ? anchorTurn.promptId : null;
  const typed = useTurnOutline(projectId, sessionId, 'you', { order, around: typedAround, enabled: requested === null && !waiting && (anchorTurn === undefined || anchorTurn.origin === 'user') });
  const fewTyped = !typed.isPending && !typed.error && !typed.hasMore && typed.rows.length < FEW_TYPED_PROMPTS && turnsTotal > typed.rows.length;
  const filter: TurnFilter = requested ?? ((anchorTurn !== undefined && anchorTurn.origin !== 'user') || fewTyped ? 'all' : 'you');
  const around = anchorTurn !== undefined && inFilter(anchorTurn, filter) ? anchorTurn.promptId : null;
  const outline = useTurnOutline(projectId, sessionId, filter, { order, around, enabled: !waiting });

  const search = useConversationQuery();
  const searching = search.query !== '';
  const found = useConversationSearch(projectId, sessionId, search.query);

  const listed = wanted === null ? undefined : outline.rows.find((row) => row.promptId === wanted);
  const elsewhere = useNamedTurn(projectId, sessionId, wanted, wanted !== null && wanted !== anchor && listed === undefined);
  const named = listed ?? (wanted === anchor ? anchorTurn : elsewhere.data?.rows[0]);
  const namedRead = wanted === anchor ? anchorRead : elsewhere;
  const openTurn = wanted !== null ? named : compact ? undefined : outline.rows[0];
  const openId = openTurn?.promptId ?? null;

  const linkTo = (promptId: string) => {
    const copy = new URLSearchParams(params);
    copy.set('turn', promptId);
    return `?${copy}`;
  };
  const openTurnId = (promptId: string, replace: boolean) => {
    const copy = new URLSearchParams(params);
    copy.set('turn', promptId);
    setParams(copy, { replace });
  };
  const closeTurn = () => {
    const copy = new URLSearchParams(params);
    copy.delete('turn');
    setParams(copy);
  };
  const setFilter = (next: TurnFilter) => {
    setOpened(null);
    const copy = new URLSearchParams(params);
    copy.set(TURN_FILTER_KEY, next);
    copy.delete('q');
    setParams(copy, { replace: true });
  };
  const flipOrder = () => {
    const copy = new URLSearchParams(params);
    if (order === 'desc') copy.set(TURN_ORDER_KEY, 'asc'); else copy.delete(TURN_ORDER_KEY);
    setParams(copy, { replace: true });
  };

  const steps = searching ? found.hits.flatMap((hit) => hit.turn === null ? [] : [hit.turn.prompt_id]) : outline.rows.map((row) => row.promptId);
  const at = openId === null ? -1 : steps.indexOf(openId);
  const later = at < 0 ? undefined : order === 'desc' && !searching ? steps[at - 1] : steps[at + 1];
  const earlier = at < 0 ? undefined : order === 'desc' && !searching ? steps[at + 1] : steps[at - 1];

  // j and k step down and up the list on screen; the last row asks for the next page.
  const keys = useRef({ steps, at, hasMore: outline.hasMore && !searching, more: outline.more, open: openTurnId });
  keys.current = { steps, at, hasMore: outline.hasMore && !searching, more: outline.more, open: openTurnId };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== 'j' && event.key !== 'k') || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      if (document.querySelector('[role="dialog"]') !== null) return;
      const { steps: list, at: index, hasMore, more, open } = keys.current;
      if (list.length === 0) return;
      const next = Math.max(0, Math.min(list.length - 1, index + (event.key === 'j' ? 1 : -1)));
      if (hasMore && next >= list.length - 1) more();
      if (next !== index) open(list[next]!, true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // The open row stays in view inside the list, and the page returns to the turn's start.
  const listRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector('[aria-current="true"]');
    if (list != null && row != null && list.scrollHeight > list.clientHeight) {
      const a = row.getBoundingClientRect();
      const b = list.getBoundingClientRect();
      if (a.top < b.top + 30 || a.bottom > b.bottom) list.scrollTop += a.top - b.top - 60;
    }
    const reader = readerRef.current;
    if (reader != null && reader.getBoundingClientRect().top < 0 && typeof reader.scrollIntoView === 'function') reader.scrollIntoView({ block: 'start' });
  }, [openId, filter, outline.isPending]);

  const showRail = !compact || wanted === null;
  const showReader = !compact || wanted !== null;
  const back = compact ? <Button variant="secondary" size="sm" onClick={closeTurn}>← Turns</Button> : undefined;
  const address = openId === null ? '' : `${window.location.origin}${window.location.pathname}?${new URLSearchParams({ turn: openId })}`;

  return (
    <div className="grid items-start gap-s5 lg:grid-outline lg:gap-s5 min-[1180px]:grid-outline-wide min-[1180px]:gap-s8">
      {showRail && (
        <TurnRail
          ref={listRef}
          search={search}
          filter={filter}
          onFilter={setFilter}
          order={order}
          onOrder={flipOrder}
          onNewest={around !== null ? () => setOpened(null) : null}
          outline={{ ...outline, isPending: waiting || outline.isPending }}
          found={found}
          openId={openId}
          linkTo={linkTo}
          replace={!compact}
          agent={agent}
          now={now}
        />
      )}
      {showReader && (
        <div ref={readerRef} className="min-w-0 scroll-mt-s3">
          {openTurn !== undefined ? (
            <TurnReader
              key={openTurn.promptId}
              projectId={projectId}
              sessionId={sessionId}
              turn={openTurn}
              agent={agent}
              contexts={contexts}
              now={now}
              link={address}
              back={back}
              steps={(
                <>
                  <Button variant="secondary" size="sm" disabled={earlier === undefined} onClick={() => { if (earlier !== undefined) openTurnId(earlier, true); }}>← Earlier</Button>
                  <Button variant="secondary" size="sm" disabled={later === undefined} onClick={() => { if (later !== undefined) openTurnId(later, true); }}>Later →</Button>
                </>
              )}
            />
          ) : wanted !== null && namedRead.error ? (
            <div className="flex flex-col gap-s3">{back}<ErrorState error={namedRead.error} onRetry={() => { void namedRead.refetch(); }} /></div>
          ) : wanted !== null && (namedRead.isPending || namedRead.isFetching) ? (
            <div className="flex flex-col gap-s3">{back}<LoadingState shape="reading" label="Reading this turn" /></div>
          ) : wanted !== null ? (
            <div className="flex flex-col gap-s3">{back}<EmptyState title="This turn is not in this session." /></div>
          ) : null}
        </div>
      )}
    </div>
  );
}
