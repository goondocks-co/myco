import { useState, type ReactNode } from 'react';
import { Button, CopyButton, Disclosure, ExternalLink, ItemLink, Lightbox, ReadState, StatusChip, TypeChip } from '../../design';
import { processedBodyUrl, RENDERABLE_IMAGE_TYPES, useTurnDetail, type AttachmentRow, type ResponseRow, type TurnChild, type TurnDetail, type TurnInjection, type TurnRow, type TurnCollection, type PromptAnswer, type RecordLocator, type TurnPrompt } from '../../hooks/use-sessions';
import { useTurnCollection } from '../../hooks/use-turn-collection';
import { cn } from '../../lib/cn';
import { PlanLine } from '../knowledge/PlanLine';
import { isMechanical, parseCard, type CardPair } from './card-text';
import { TextOrBlob } from './StoredText';
import { ToolUse } from './ToolCalls';
import { formatElapsed } from '../../lib/format';
import { projectPath, PLAN_SUFFIX } from '../../routes/nav';
import { displayPrompt, promptDisplay } from '@goondocks/myco-shared/prompt-text';
import { clockTime, count, dateTime, sporeTypeWord } from './words';

/** How much of a prompt the list row carries, and so what a turn shows before its body is read. */
export const PROMPT_PREVIEW_CHARS = 120;
/** A prompt longer than this shows its opening, with the rest a click away. */
const LONG_PROMPT_CHARS = 600;

/** What a turn calls where its prompt came from, in the reader's words rather than the wire's. */
const ORIGIN_LABEL: Record<string, string> = {
  user: 'From you',
  system: 'System',
  agent_dispatch: 'Sub-agent',
  hook_injected: 'Added by a hook',
};

/** A prompt's opening on one line, as the list row carries it. */
export function promptPreview(turn: Pick<TurnRow, 'preview' | 'textChars' | 'blobKey'>, agent: string | null = null): string {
  if (turn.preview === null || turn.preview === '') return turn.blobKey !== null ? 'Stored text' : '(no prompt)';
  const line = displayPrompt(turn.preview, agent).replace(/\s+/g, ' ').trim();
  const cut = line.length > PROMPT_PREVIEW_CHARS ? `${line.slice(0, PROMPT_PREVIEW_CHARS)}…` : line;
  return cut.length < line.length || (turn.textChars !== null && turn.textChars > turn.preview.length) ? (cut.endsWith('…') ? cut : `${cut}…`) : cut;
}

function TurnPages<T>({ projectId, sessionId, promptId, collection, initial, cursor, rowKey, label, children, unloaded = false, held }: {
  projectId: string; sessionId: string; promptId: string; collection: TurnCollection; initial: T[]; cursor?: string | null;
  rowKey: (row: T) => string; label: string; unloaded?: boolean; children: (rows: T[]) => ReactNode;
  /** How many rows the turn holds, when known: pages past them are not offered. */
  held?: number;
}) {
  const pages = useTurnCollection(projectId, sessionId, promptId, collection, initial, cursor, rowKey, unloaded);
  const hasMore = pages.hasMore && (held === undefined || pages.rows.length < held);
  return <>
    {unloaded && pages.pending && pages.rows.length === 0 && <p role="status" className="t-small text-muted">Reading {label}…</p>}
    {children(pages.rows)}
    {pages.error && <p role="alert" className="t-small text-bad">More {label} could not be read. The items above are still available.</p>}
    {(hasMore || pages.error) && <Button variant="secondary" className="w-fit" onClick={pages.error ? pages.retry : pages.more} disabled={pages.pending}>
      {pages.pending ? `Reading more ${label}…` : pages.error ? `Retry reading ${label}` : `Show more ${label}`}
    </Button>}
  </>;
}

function Attachments({ projectId, attachments }: { projectId: string; attachments: AttachmentRow[] }) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const images = attachments.filter((a) => RENDERABLE_IMAGE_TYPES.includes(a.mediaType));
  const files = attachments.filter((a) => !RENDERABLE_IMAGE_TYPES.includes(a.mediaType));
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap items-start gap-s3" data-testid="turn-attachments">
      {images.map((a, i) => (
        <Button key={a.attachmentId} variant="ghost" onClick={() => setLightbox(i)} className="h-auto overflow-hidden rounded-control border-line p-0" aria-label={`Open ${a.description ?? 'image'}`}>
          <img src={processedBodyUrl(projectId, { kind: 'attachment', id: a.attachmentId })} alt={a.description ?? 'An attached image'} loading="lazy" className="max-h-thumb-h max-w-thumb object-cover" />
        </Button>
      ))}
      {files.map((a) => (
        <ExternalLink key={a.attachmentId} href={processedBodyUrl(projectId, { kind: 'attachment', id: a.attachmentId })} className="t-small">Download {a.description ?? 'the attachment'}</ExternalLink>
      ))}
      {lightbox !== null && (
        <Lightbox images={images.map((a) => ({ src: processedBodyUrl(projectId, { kind: 'attachment', id: a.attachmentId }), alt: a.description ?? 'An attached image' }))} index={lightbox} onNavigate={setLightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

function Reply({ projectId, sessionId, reply }: { projectId: string; sessionId: string; reply: ResponseRow }) {
  return (
    <div className="flex flex-col gap-s1" data-testid="turn-response">
      <time dateTime={new Date(reply.createdAt).toISOString()} className="t-meta text-faint">{clockTime(reply.createdAt)}</time>
      <TextOrBlob projectId={projectId} text={reply.text} blobKey={reply.blobKey} body={{ kind: 'response', id: reply.responseId, at: reply.locator === undefined ? undefined : { ...reply.locator, sessionId } }} markdown />
    </div>
  );
}

/** The last reply in view, with those before it folded above it. */
function Replies({ projectId, sessionId, responses }: { projectId: string; sessionId: string; responses: ResponseRow[] }) {
  const inOrder = [...responses].sort((a, b) => a.orderedAt - b.orderedAt);
  const last = inOrder.at(-1);
  if (last === undefined) return null;
  const earlier = inOrder.slice(0, -1);
  return (
    <div className="flex flex-col gap-s3">
      {earlier.length > 0 && (
        <Disclosure summary={count(earlier.length, 'earlier reply', 'earlier replies')}>
          <div className="flex flex-col gap-s4">{earlier.map((reply) => <Reply key={reply.responseId} projectId={projectId} sessionId={sessionId} reply={reply} />)}</div>
        </Disclosure>
      )}
      <Reply projectId={projectId} sessionId={sessionId} reply={last} />
    </div>
  );
}

/** What Myco added to this prompt: one folded line, opening on its served spores and plans. */
function Injection({ projectId, injection }: { projectId: string; injection: TurnInjection }) {
  const served = injection.spores.length;
  const missing = injection.sporeIds.length - served;
  const planIds = injection.planIds ?? [];
  if (injection.sporeIds.length === 0 && planIds.length === 0) return null;
  return (
    <div data-testid="turn-injection">
      <Disclosure summary={`Myco added ${count(injection.sporeIds.length, 'spore')}${planIds.length > 0 ? ` and ${count(planIds.length, 'plan')}` : ''} to this prompt`}>
        <ul className="flex flex-col gap-s2" aria-label="Spores added to this prompt">
          {injection.spores.map((spore) => (
            <li key={spore.id} className="flex min-w-0 items-baseline gap-s2 t-small">
              <TypeChip>{sporeTypeWord(spore.observationType)}</TypeChip>
              <ItemLink to={`/p/${encodeURIComponent(projectId)}/spores/${encodeURIComponent(spore.id)}`} lines={1} className="text-ink-2 hover:text-ink">
                {spore.preview}
              </ItemLink>
            </li>
          ))}
          {(injection.plans ?? []).map((plan) => <li key={plan.planKey} className="t-small"><ItemLink to={projectPath(projectId, PLAN_SUFFIX + '/' + encodeURIComponent(plan.planKey))}>{plan.title ?? 'Untitled plan'}</ItemLink></li>)}
          {planIds.length > (injection.plans?.length ?? 0) && <li className="t-small text-muted">{count(planIds.length - (injection.plans?.length ?? 0), 'plan')} no longer kept</li>}
          {missing > 0 && <li className="t-small text-muted">{count(missing, 'spore')} no longer kept</li>}
        </ul>
      </Disclosure>
    </div>
  );
}

/** The prompt itself: its whole text once the body is read, its opening before; a long one shows its opening until asked. */
function PromptText({ projectId, sessionId, turn, text, blobKey, locator, agent }: { projectId: string; sessionId: string; turn: Pick<TurnRow, 'promptId' | 'preview' | 'textChars' | 'blobKey'>; text: string | null | undefined; blobKey: string | null | undefined; locator?: RecordLocator; agent: string | null }) {
  const [whole, setWhole] = useState(false);
  if (text === undefined) return <p className="whitespace-pre-wrap break-words t-body font-medium text-ink">{promptPreview(turn, agent)}</p>;
  const stored = blobKey != null;
  if (!whole && (stored || (text?.length ?? 0) > LONG_PROMPT_CHARS)) {
    return <div className="flex flex-col items-start gap-s1">
      {text === null ? <p>{promptPreview(turn, agent)}</p> : <PromptContent text={text} agent={agent} folded />}
      <Button variant="ghost" size="sm" className="-ml-s3" onClick={() => setWhole(true)}>Show the whole prompt</Button>
    </div>;
  }
  return <TextOrBlob projectId={projectId} text={text} blobKey={blobKey ?? null} body={{ kind: 'prompt', id: turn.promptId, at: locator === undefined ? undefined : { ...locator, sessionId } }} render={(value) => <PromptContent text={value} agent={agent} />} />;
}

function PromptContent({ text, agent, folded = false }: { text: string; agent: string | null; folded?: boolean }) {
  const shown = promptDisplay(text, agent);
  return <div className="flex flex-col gap-s2">
    {shown.envelopes.map((envelope, i) => envelope.text === '' ? <StatusChip key={i}>{envelope.label}</StatusChip> : <Disclosure key={i} summary={<StatusChip>{envelope.label}</StatusChip>}>
      <p className="whitespace-pre-wrap break-words t-small text-muted">{envelope.text}</p>
    </Disclosure>)}
    {shown.text !== '' && <p className={cn('whitespace-pre-wrap break-words t-body font-medium text-ink', folded && 'line-clamp-6')}>{shown.text}</p>}
  </div>;
}

function Pairs({ items, render }: { items: readonly CardPair[]; render: (item: CardPair) => ReactNode }) {
  return <ul className="flex flex-col gap-s1">{items.map((item, i) => <li key={i} className="break-words">{render(item)}</li>)}</ul>;
}

const reasoned = (item: CardPair) => <><span className="font-medium text-ink">{item.text}.</span>{item.detail !== '' && <span className="text-muted"> {item.detail}</span>}</>;

function CardRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-s3 gap-y-s1 sm:grid-term">
      <dt className="t-small text-muted">{term}</dt>
      <dd className="t-small text-ink-2">{children}</dd>
    </div>
  );
}

function CodeLines({ lines }: { lines: readonly string[] }) {
  return <ul className="flex flex-col gap-s1">{lines.map((line, i) => <li key={i} className="t-mono break-all whitespace-pre-wrap">{line}</li>)}</ul>;
}

/** What the turn's card says happened: laid out by part, or as written when it reads as no card. */
function WhatHappened({ card }: { card: string | null | undefined }) {
  const parsed = card == null ? null : parseCard(card);
  if (isMechanical(parsed?.done ?? card)) return null;
  let body: ReactNode;
  if (parsed !== null) {
    body = (
      <dl className="flex flex-col gap-s2">
        <CardRow term="Done"><span className="whitespace-pre-wrap break-words">{parsed.done}</span></CardRow>
        {parsed.outcome !== '' && <CardRow term="Outcome"><span className="whitespace-pre-wrap break-words">{parsed.outcome}</span></CardRow>}
        {parsed.decisions.length > 0 && <CardRow term="Decided"><Pairs items={parsed.decisions} render={reasoned} /></CardRow>}
        {parsed.rejected.length > 0 && <CardRow term="Rejected"><Pairs items={parsed.rejected} render={reasoned} /></CardRow>}
        {parsed.corrections.length > 0 && <CardRow term="Corrected"><Pairs items={parsed.corrections} render={(item) => <><span className="line-through">{item.text}</span>{item.detail !== '' && <> → <span className="font-medium text-ink">{item.detail}</span></>}</>} /></CardRow>}
        {parsed.errors.length > 0 && <CardRow term="Errors"><Pairs items={parsed.errors} render={(item) => <><code className="t-mono text-bad">{item.text}</code>{item.detail !== '' && <span className="text-muted"> → {item.detail}</span>}</>} /></CardRow>}
        {parsed.files.length > 0 && <CardRow term="Files"><CodeLines lines={parsed.files} /></CardRow>}
        {parsed.commands.length > 0 && <CardRow term="Commands"><CodeLines lines={parsed.commands} /></CardRow>}
        {parsed.openQuestions.length > 0 && <CardRow term="Still open"><ul className="flex flex-col gap-s1">{parsed.openQuestions.map((question, i) => <li key={i} className="break-words">{question}</li>)}</ul></CardRow>}
      </dl>
    );
  } else if (card != null && card !== '') {
    body = <p className="whitespace-pre-wrap break-words t-small text-ink-2">{card}</p>;
  } else {
    body = <p className="t-small text-muted">Myco writes this once the turn settles.</p>;
  }
  return (
    <section aria-label="What happened" className="flex flex-col gap-s2" data-testid="what-happened">
      <h2 className="t-h3 text-ink">What happened</h2>
      {body}
    </section>
  );
}

function PromptBubble({ origin, thread, at, steering = false, children }: { origin: string; thread: string | null; at?: number; steering?: boolean; children: ReactNode }) {
  const typed = origin === 'user';
  return (
    <div className={cn('flex flex-col gap-s1 rounded-card border px-s4 py-s3', typed ? 'border-line bg-surface-2' : 'border-dashed border-line-strong')}>
      {(steering || thread !== null || at !== undefined) && (
        <span className="flex flex-wrap items-center gap-x-s2 gap-y-s1 t-meta text-muted">
          {steering && <span>Steered while it ran</span>}
          {thread !== null && <StatusChip>{thread}</StatusChip>}
          {at !== undefined && <time dateTime={new Date(at).toISOString()}>{clockTime(at)}</time>}
        </span>
      )}
      {children}
    </div>
  );
}

/** What a body holds besides its prompt and its card: steering prompts, replies, plans and tool use, each read a page at a time. */
function TurnContent({ projectId, sessionId, promptId, agent, contexts, body, total, failed, rollup, held, deferChildren = 0 }: {
  projectId: string; sessionId: string; promptId: string; agent: string | null; contexts?: Record<string, { subagents: number }>;
  body: TurnDetail; total: number; failed: number; rollup: TurnRow['toolRollup'];
  /** How many of each the turn holds, when its row is known. */
  held?: { replies: number; children: number; plans: number };
  /** Child prompts read only on request, beyond what the body embeds. */
  deferChildren?: number;
}) {
  const [showChildren, setShowChildren] = useState(false);
  const subagents = (contexts?.[promptId] ?? body.context)?.subagents ?? 0;
  const injected = body.injection !== null && (body.injection.sporeIds.length > 0 || (body.injection.planIds ?? []).length > 0);
  const hasAnswers = (body.answers ?? []).length > 0;
  const hasTools = total > 0 || body.tools?.complete === false;
  const added = <>
    {subagents > 0 && <Contribution label={`Myco prepared ${count(subagents, 'sub-agent preamble')}`} />}
    <TurnPages projectId={projectId} sessionId={sessionId} promptId={promptId} collection="answers" initial={body.answers ?? []} cursor={body.cursors?.answers} rowKey={(row) => row.id} label="context answers">
      {(rows) => rows.map((answer) => <ContextAnswer key={answer.id} answer={answer} />)}
    </TurnPages>
    {body.injection !== null && <Injection projectId={projectId} injection={body.injection} />}
  </>;
  return <>
    {deferChildren > 0 && !showChildren
      ? <Button variant="secondary" className="w-fit" onClick={() => setShowChildren(true)}>Show child prompts ({deferChildren})</Button>
      : (
        <TurnPages projectId={projectId} sessionId={sessionId} promptId={promptId} collection="children" unloaded={deferChildren > 0} initial={body.children} cursor={body.cursors?.children} rowKey={(row) => row.prompt.promptId} label="steering prompts" held={held?.children}>
          {(rows) => rows.length > 0 && (
            <ol className="flex flex-col gap-s4 border-l-2 border-line-strong pl-s4" aria-label="Child prompts">
              {rows.map((child) => <ChildTurn key={child.prompt.promptId} projectId={projectId} sessionId={sessionId} agent={agent} contexts={contexts} child={child} />)}
            </ol>
          )}
        </TurnPages>
      )}
    <TurnPages projectId={projectId} sessionId={sessionId} promptId={promptId} collection="responses" initial={body.responses} cursor={body.cursors?.responses} rowKey={(row) => row.responseId} label="replies" held={held?.replies}>
      {(rows) => rows.length > 0 && (
        <section aria-label="Reply" className="flex flex-col gap-s2">
          <h2 className="t-h3 text-ink">Reply</h2>
          <Replies projectId={projectId} sessionId={sessionId} responses={rows} />
        </section>
      )}
    </TurnPages>
    <TurnPages projectId={projectId} sessionId={sessionId} promptId={promptId} collection="plans" initial={body.plans} cursor={body.cursors?.plans} rowKey={(row) => row.planKey} label="plans" held={held?.plans}>
      {(rows) => rows.length > 0 && <div className="flex flex-col gap-s2" data-testid="turn-plans">
        {rows.map((plan) => <PlanLine key={plan.planKey} projectId={projectId} plan={plan} now={Date.now()} />)}
      </div>}
    </TurnPages>
    {(hasTools || injected || hasAnswers || subagents > 0) && (
      <ToolUse projectId={projectId} sessionId={sessionId} promptId={promptId} total={total} failed={failed} rollup={rollup} summary={body.tools} shown={body.toolCounts} added={added} />
    )}
  </>;
}

/** A prompt sent while its parent ran, with what followed it; the parent's read carries its body. */
function ChildTurn({ projectId, sessionId, agent, contexts, child }: { projectId: string; sessionId: string; agent: string | null; contexts?: Record<string, { subagents: number }>; child: TurnChild }) {
  const prompt: TurnPrompt = child.prompt;
  const body: TurnDetail = child.body ?? {
    card: null, toolCounts: { total: child.toolCallCount, shown: child.toolCallCount },
    prompt, responses: child.responses, attachments: [], plans: [], injection: null, children: [],
    cursors: { responses: child.responsesCursor ?? null, attachments: null, plans: null, children: null, answers: null },
  };
  return (
    <li data-testid={`turn-${prompt.promptId}`} data-child="true" data-origin={prompt.origin} className="flex flex-col gap-s3">
      <PromptBubble origin={prompt.origin} thread={prompt.threadLabel} at={prompt.createdAt} steering={prompt.origin === 'user'}>
        <PromptText projectId={projectId} sessionId={sessionId} turn={{ promptId: prompt.promptId, preview: prompt.text, textChars: prompt.text?.length ?? null, blobKey: prompt.blobKey }} text={prompt.text} blobKey={prompt.blobKey} locator={prompt.locator} agent={agent} />
      </PromptBubble>
      <TurnPages projectId={projectId} sessionId={sessionId} promptId={prompt.promptId} collection="attachments" initial={body.attachments} cursor={body.cursors?.attachments} rowKey={(row) => row.attachmentId} label="attachments">
        {(rows) => <Attachments projectId={projectId} attachments={rows} />}
      </TurnPages>
      <TurnContent projectId={projectId} sessionId={sessionId} promptId={prompt.promptId} agent={agent} contexts={contexts} body={body} total={child.toolCallCount} failed={body.tools?.failed ?? 0} rollup={null} deferChildren={child.body !== undefined ? child.childCount ?? 0 : 0} />
    </li>
  );
}

export interface TurnReaderProps {
  projectId: string;
  sessionId: string;
  turn: TurnRow;
  agent?: string | null;
  contexts?: Record<string, { subagents: number }>;
  now: number;
  /** The way back to the outline, where the outline and the turn do not share the screen. */
  back?: ReactNode;
  /** The steps to the turns before and after this one in the outline. */
  steps?: ReactNode;
  /** The address of this turn. */
  link: string;
}

/**
 * The one open turn: its prompt, what happened, the reply, then its tool use. This
 * is the only turn whose body is read; a steering prompt's body comes inside its parent's.
 */
export function TurnReader({ projectId, sessionId, turn, agent = null, contexts, now, back, steps, link }: TurnReaderProps) {
  const detail = useTurnDetail(projectId, sessionId, turn.promptId, true);
  const body = detail.data;
  const elapsed = body?.metrics?.durationMs ?? null;
  return (
    <article tabIndex={-1} data-testid={`turn-${turn.promptId}`} data-origin={turn.origin} aria-label="Open turn" className="flex min-w-0 max-w-reader outline-none flex-col gap-s5">
      <div className="flex flex-wrap items-center justify-between gap-s2">
        <span className="flex flex-wrap items-center gap-x-s2 gap-y-s1 t-small text-muted">
          {back}
          <time dateTime={new Date(turn.createdAt).toISOString()}>{dateTime(turn.createdAt, now)}</time>
          {elapsed !== null && <><span aria-hidden>·</span><span>{formatElapsed(elapsed)}</span></>}
          <StatusChip>{ORIGIN_LABEL[turn.origin] ?? 'Added'}</StatusChip>
          {turn.signal === 'high' && <StatusChip className="bg-primary-bg text-primary">Key moment</StatusChip>}
        </span>
        <span className="flex flex-wrap items-center gap-s2">
          {steps}
          <CopyButton value={link} label="Copy link" variant="secondary" />
        </span>
      </div>
      <PromptBubble origin={turn.origin} thread={turn.threadLabel}>
        <PromptText key={turn.promptId} projectId={projectId} sessionId={sessionId} turn={turn} text={body === undefined ? undefined : body.prompt.text} agent={agent} blobKey={body?.prompt.blobKey} locator={body?.prompt.locator} />
      </PromptBubble>
      <ReadState data={body} pending={detail.isPending} error={detail.error} onRetry={() => { void detail.refetch(); }} label="this turn">
        {(read) => <>
          <TurnPages projectId={projectId} sessionId={sessionId} promptId={turn.promptId} collection="attachments" initial={read.attachments} cursor={read.cursors?.attachments} rowKey={(row) => row.attachmentId} label="attachments">
            {(rows) => <Attachments projectId={projectId} attachments={rows} />}
          </TurnPages>
          <WhatHappened card={read.card} />
          <TurnContent projectId={projectId} sessionId={sessionId} promptId={turn.promptId} agent={agent} contexts={contexts} body={read} total={turn.toolCallCount} failed={turn.failedTools} rollup={turn.toolRollup ?? null} held={{ replies: turn.responseCount, children: turn.childCount, plans: turn.planCount }} />
        </>}
      </ReadState>
    </article>
  );
}

function Contribution({ label }: { label: string }) {
  return <Disclosure summary={<StatusChip>{label}</StatusChip>}>
    <p className="t-small text-muted">Myco recorded preparing this context. The original text is not retained.</p>
  </Disclosure>;
}

const SKIP_WORDS: Record<string, string> = {
  capability: 'Project context is turned off', repeat: 'Context already prepared',
  'spores:disabled': 'Spore suggestions are turned off', 'spores:short_prompt': 'Prompt too short to match',
  'spores:empty': 'No relevant memories found', 'spores:repeat': 'Relevant memories already served',
  'spores:zero_max': 'Memory limit is zero', 'spores:capability': 'Project context is turned off',
  'spores:no_semantic': 'Memory search is not configured', 'spores:provider_unavailable': 'Memory search is unavailable',
  'plan-nudge:off': 'Plan reminder is turned off', 'plan-nudge:no_intent': 'No planning request',
  'plan-nudge:repeat': 'Plan reminder already served', 'instructions:off': 'Guidance is turned off',
  'instructions:empty': 'No guidance configured', spores: 'Memory lookup failed',
  'plan-nudge': 'Plan reminder failed', instructions: 'Guidance lookup failed',
};
const words = (value: string) => SKIP_WORDS[value] ?? value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_:]/g, ' ').toLowerCase();
function ContextAnswer({ answer }: { answer: PromptAnswer }) {
  const selection = selectionWords(answer);
  return <Disclosure summary={<StatusChip>{answer.failures.length > 0 ? (answer.outcome === 'empty' ? 'Myco context lookup failed' : 'Myco context partly prepared') : answer.outcome === 'empty' ? 'Myco prepared no context' : 'Myco prepared context'}</StatusChip>}>
    <div className="flex flex-col gap-s1 t-small text-muted">
      <time dateTime={new Date(answer.createdAt).toISOString()}>{clockTime(answer.createdAt)}</time>
      {answer.parts.map((part, i) => <p key={i}>{part.kind === 'plan-nudge' ? 'Plan reminder prepared' : `${count(part.sporeCount ?? 0, 'spore')} and ${count(part.planCount ?? 0, 'plan')} selected`}</p>)}
      {answer.skipped.filter((skip) => !answer.failures.some(f => skip === f.contributor)).map((skip) => <p key={skip}>{words(skip)}</p>)}
      {answer.failures.map((failure, i) => <p key={i} className="text-bad">{words(failure.contributor)} · {ERROR_WORDS[failure.error] ?? 'The request could not be completed'}</p>)}
      {selection !== null && <p>{selection}</p>}
    </div>
  </Disclosure>;
}

const ERROR_WORDS: Record<string, string> = {
  parse: 'The response could not be understood', store_quota: 'Storage is full', store_size: 'The stored item is too large',
  constraint: 'The stored records conflict', schema: 'Storage needs an update', db: 'Storage could not be read',
  revoked: 'Access was revoked', unknown: 'An unexpected problem occurred', unavailable: 'The service is unavailable',
};

function selectionWords(answer: PromptAnswer): string | null {
  const selection = answer.selection;
  const matches = (selection.sporeRawMatches ?? 0) + (selection.planRawMatches ?? 0);
  const relevant = (selection.sporeRelevant ?? 0) + (selection.planUnserved ?? 0);
  const served = selection.budgetKept ?? 0;
  if (matches === 0) return null;
  if (answer.failures.length > 0) return count(matches, 'match', 'matches') + ', lookup incomplete';
  if (relevant === 0) return count(matches, 'match', 'matches') + ', none relevant enough';
  if (served === 0) return count(matches, 'match', 'matches') + ', none selected';
  return count(matches, 'match', 'matches') + ', ' + count(served, 'item') + ' selected';
}
