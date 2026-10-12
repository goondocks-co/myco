import { memo, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, Disclosure, ExternalLink, ItemLink, Lightbox, ReadState, ReadUnavailable, StatusChip, TypeChip } from '../../design';
import { processedBodyUrl, RENDERABLE_IMAGE_TYPES, useTurnDetail, type AttachmentRow, type ResponseRow, type TurnChild, type TurnDetail, type TurnInjection, type TurnRow, type TurnCollection, type PromptAnswer } from '../../hooks/use-sessions';
import { useTurnCollection } from '../../hooks/use-turn-collection';
import { cn } from '../../lib/cn';
import { PlanLine } from '../knowledge/PlanLine';
import { TextOrBlob } from './StoredText';
import { ToolCalls } from './ToolCalls';
import { formatMillis } from '../../lib/format';
import { displayPrompt } from '@goondocks/myco-shared/prompt-text';
import { ToolUsageLine } from './Usage';
import { clockTime, count, sporeTypeWord } from './words';

/** How much of a prompt the list row carries, and so what a turn shows before its body is read. */
export const PROMPT_PREVIEW_CHARS = 120;
/** A prompt longer than this shows its opening, with the rest a click away. */
const LONG_PROMPT_CHARS = 600;
/** How far ahead of the viewport a turn starts reading its body. */
const READ_AHEAD = '800px';

/** What a turn calls a prompt a person did not type, in the reader's words rather than the wire's. */
const ORIGIN_LABEL: Record<string, string> = {
  system: 'System',
  agent_dispatch: 'Sub-agent',
  hook_injected: 'Added by a hook',
};

/** A prompt's opening on one line, as the list row carries it. */
export function promptPreview(turn: Pick<TurnRow, 'preview' | 'textChars' | 'blobKey'>): string {
  if (turn.preview === null || turn.preview === '') return turn.blobKey !== null ? 'Stored text' : '(no prompt)';
  const line = turn.preview.replace(/\s+/g, ' ').trim();
  const cut = line.length > PROMPT_PREVIEW_CHARS ? `${line.slice(0, PROMPT_PREVIEW_CHARS)}…` : line;
  return cut.length < line.length || (turn.textChars !== null && turn.textChars > turn.preview.length) ? (cut.endsWith('…') ? cut : `${cut}…`) : cut;
}

/**
 * Whether an element has come within `READ_AHEAD` of the viewport; once true it
 * stays true. Where there is no IntersectionObserver it is true at once.
 */
function useSeen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || ref.current === null || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setSeen(true); observer.disconnect(); }
    }, { rootMargin: READ_AHEAD });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen];
}

function TurnPages<T>({ projectId, sessionId, promptId, collection, initial, cursor, rowKey, label, children }: {
  projectId: string; sessionId: string; promptId: string; collection: TurnCollection; initial: T[]; cursor?: string | null;
  rowKey: (row: T) => string; label: string; children: (rows: T[]) => ReactNode;
}) {
  const pages = useTurnCollection(projectId, sessionId, promptId, collection, initial, cursor, rowKey);
  return <>
    {children(pages.rows)}
    {pages.error && <p role="alert" className="t-small text-bad">More {label} could not be read. The items above are still available.</p>}
    {(pages.hasMore || pages.error) && <Button variant="secondary" className="w-fit" onClick={pages.error ? pages.retry : pages.more} disabled={pages.pending}>
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

function Replies({ projectId, responses }: { projectId: string; responses: ResponseRow[] }) {
  if (responses.length === 0) return null;
  return (
    <div className="flex flex-col gap-s4">
      {responses.map((r) => (
        <div key={r.responseId} className="flex flex-col gap-s1" data-testid="turn-response">
          <time dateTime={new Date(r.createdAt).toISOString()} className="t-meta text-faint">Reply · {clockTime(r.createdAt)}</time>
          <TextOrBlob projectId={projectId} text={r.text} blobKey={r.blobKey} body={{ kind: 'response', id: r.responseId }} markdown />
        </div>
      ))}
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
          {(injection.plans ?? []).map((plan) => <li key={plan.planKey} className="t-small"><ItemLink to={`/p/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(plan.planKey)}`}>{plan.title ?? 'Untitled plan'}</ItemLink></li>)}
          {planIds.length > (injection.plans?.length ?? 0) && <li className="t-small text-muted">{count(planIds.length - (injection.plans?.length ?? 0), 'plan')} no longer kept</li>}
          {missing > 0 && <li className="t-small text-muted">{count(missing, 'spore')} no longer kept</li>}
        </ul>
      </Disclosure>
    </div>
  );
}

/** The prompt itself: its whole text once the body is read, its opening before; a long one shows its opening until asked. */
function PromptText({ projectId, turn, text, blobKey, agent }: { projectId: string; turn: TurnRow; text: string | null | undefined; blobKey: string | null | undefined; agent: string | null }) {
  const [whole, setWhole] = useState(false);
  const shown = text == null ? text : displayPrompt(text, agent);
  if (text === undefined) return <p className="whitespace-pre-wrap break-words t-body font-medium text-ink">{promptPreview({ ...turn, preview: turn.preview === null ? null : displayPrompt(turn.preview, agent) })}</p>;
  const stored = text === null && blobKey != null;
  if (!whole && (stored || (shown?.length ?? 0) > LONG_PROMPT_CHARS)) {
    return (
      <div className="flex flex-col items-start gap-s1">
        <p className="line-clamp-6 whitespace-pre-wrap break-words t-body font-medium text-ink">{shown ?? promptPreview({ ...turn, preview: turn.preview === null ? null : displayPrompt(turn.preview, agent) })}</p>
        <Button variant="ghost" size="sm" className="-ml-s3" onClick={() => setWhole(true)}>Show the whole prompt</Button>
      </div>
    );
  }
  return <div className="font-medium text-ink"><TextOrBlob projectId={projectId} text={shown ?? null} blobKey={blobKey ?? null} body={{ kind: 'prompt', id: turn.promptId }} transform={shown == null ? (value) => displayPrompt(value, agent) : undefined} /></div>;
}

export interface TurnProps {
  projectId: string;
  sessionId: string;
  turn: TurnRow;
  /** A link named this turn: bring it into view once it mounts. */
  scrollTo?: boolean;
  agent?: string | null;
  steering?: boolean;
  initial?: TurnChild;
}

/**
 * One turn of the conversation, read inline: the prompt as a bubble, then what
 * followed it and the replies. Only the tool calls fold away. The turn's body
 * is read once the turn comes near the viewport, so a long conversation reads
 * only what the reader reaches.
 */
export const Turn = memo(function Turn({ projectId, sessionId, turn, scrollTo = false, agent = null, steering = false, initial }: TurnProps) {
  const injected = turn.origin !== 'user';
  const [ref, seen] = useSeen<HTMLLIElement>();
  const detail = useTurnDetail(projectId, sessionId, turn.promptId, seen || scrollTo);
  useEffect(() => {
    if (scrollTo && typeof ref.current?.scrollIntoView === 'function') ref.current.scrollIntoView({ block: 'start' });
  }, [scrollTo, ref]);
  const body: TurnDetail | undefined = detail.data ?? (initial === undefined ? undefined : {
    prompt: initial.prompt, responses: initial.responses, attachments: [], plans: [], injection: null, children: [],
    cursors: { responses: initial.responsesCursor ?? null, attachments: null, plans: null, children: null, answers: null },
  });
  const partial = detail.data === undefined && initial !== undefined;
  return (
    <li ref={ref} data-testid={`turn-${turn.promptId}`} data-origin={turn.origin} className="flex flex-col gap-s3">
      <div className={cn('flex flex-col gap-s1 rounded-card border px-s4 py-s3', injected ? 'border-dashed border-line-strong' : 'border-line bg-surface-2')}>
        <span className="flex flex-wrap items-center gap-x-s2 gap-y-s1 t-meta text-muted">
          {steering && <span>Steered while it ran</span>}
          {injected && <StatusChip>{ORIGIN_LABEL[turn.origin] ?? 'Added'}</StatusChip>}
          {turn.threadLabel !== null && <StatusChip>{turn.threadLabel}</StatusChip>}
          <time dateTime={new Date(turn.createdAt).toISOString()}>{clockTime(turn.createdAt)}</time>
        </span>
        <PromptText projectId={projectId} turn={turn} text={body === undefined ? undefined : body.prompt.text} agent={agent} blobKey={body?.prompt.blobKey} />
      </div>
      <div data-testid="turn-body" className="flex flex-col gap-s4 pl-s6">
        <ReadState data={body} pending={detail.isPending} error={partial ? null : detail.error} onRetry={() => { void detail.refetch(); }} label="this turn">
          {(body) => <>
            {partial && detail.error && <ReadUnavailable label="the rest of this turn" onRetry={() => { void detail.refetch(); }} />}
            <TurnPages projectId={projectId} sessionId={sessionId} promptId={turn.promptId} collection="attachments" initial={body.attachments} cursor={body.cursors?.attachments} rowKey={(row) => row.attachmentId} label="attachments">
              {(rows) => <Attachments projectId={projectId} attachments={rows} />}
            </TurnPages>
            {body.metrics && <div className="flex flex-col gap-s1 t-meta text-muted" data-testid="turn-metrics">
              <span>{body.metrics.durationMs === null ? 'No reply time recorded' : `Prompt to last reply · ${formatMillis(body.metrics.durationMs)}`}</span>
              <ToolUsageLine tools={body.metrics.tools} />
              {turn.origin === 'agent_dispatch' && <span>Sub-agent tokens not recorded</span>}
            </div>}
            {body.context?.start && <Contribution label="Myco prepared session guidance" />}
            {(body.context?.subagents ?? 0) > 0 && <Contribution label={`Myco prepared ${count(body.context!.subagents, 'sub-agent preamble')}`} />}
            <TurnPages projectId={projectId} sessionId={sessionId} promptId={turn.promptId} collection="answers" initial={body.answers ?? []} cursor={body.cursors?.answers} rowKey={(row) => row.id} label="context answers">
              {(rows) => rows.map((answer) => <ContextAnswer key={answer.id} answer={answer} />)}
            </TurnPages>
            {body.injection !== null && <Injection projectId={projectId} injection={body.injection} />}
            <TurnPages projectId={projectId} sessionId={sessionId} promptId={turn.promptId} collection="plans" initial={body.plans} cursor={body.cursors?.plans} rowKey={(row) => row.planKey} label="plans">
              {(rows) => rows.length > 0 && <div className="flex flex-col gap-s2" data-testid="turn-plans">
                {rows.map((plan) => <PlanLine key={plan.planKey} projectId={projectId} plan={plan} now={Date.now()} />)}
              </div>}
            </TurnPages>
            <ToolCalls projectId={projectId} sessionId={sessionId} promptId={turn.promptId} total={turn.toolCallCount} />
            <TurnPages projectId={projectId} sessionId={sessionId} promptId={turn.promptId} collection="children" initial={body.children} cursor={body.cursors?.children} rowKey={(row) => row.prompt.promptId} label="steering prompts">
              {(rows) => <ol className="flex flex-col gap-s4 border-l-2 border-line-strong pl-s4" aria-label="Child prompts">{rows.map((child) => <li key={child.prompt.promptId} data-testid="turn-child"><ol><Turn projectId={projectId} sessionId={sessionId} agent={agent} initial={child} steering={child.prompt.origin === 'user'} turn={{ ...child.prompt, preview: child.prompt.text, textChars: child.prompt.text?.length ?? null, toolCallCount: child.toolCallCount, responseCount: child.responses.length, childCount: 0, planCount: 0, attachmentCount: 0 }} /></ol></li>)}</ol>}
            </TurnPages>
            <TurnPages projectId={projectId} sessionId={sessionId} promptId={turn.promptId} collection="responses" initial={body.responses} cursor={body.cursors?.responses} rowKey={(row) => row.responseId} label="replies">
              {(rows) => <Replies projectId={projectId} responses={rows} />}
            </TurnPages>
          </>}
        </ReadState>
      </div>
    </li>
  );
});


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
  return <Disclosure summary={<StatusChip>{answer.failures.length > 0 ? (answer.outcome === 'empty' ? 'Myco context lookup failed' : 'Myco context partly prepared') : answer.outcome === 'empty' ? 'Myco prepared no context' : 'Myco prepared context'}</StatusChip>}>
    <div className="flex flex-col gap-s1 t-small text-muted">
      <time>{clockTime(answer.createdAt)}</time>
      {answer.parts.map((part, i) => <p key={i}>{part.kind === 'plan-nudge' ? 'Plan reminder served' : `${count(part.sporeCount ?? 0, 'spore')} and ${count(part.planCount ?? 0, 'plan')} served`}</p>)}
      {answer.skipped.map((skip) => <p key={skip}>{words(skip)}</p>)}
      {answer.failures.map((failure, i) => <p key={i} className="text-bad">{words(failure.contributor)} · {words(failure.error)}{failure.operation ? ` · ${words(failure.operation)}` : ''}</p>)}
      {Object.entries(answer.selection).map(([stage, n]) => <p key={stage}>{words(stage)}: {n}</p>)}
    </div>
  </Disclosure>;
}
