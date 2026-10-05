import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import { Button, Disclosure, ExternalLink, ItemLink, Lightbox, Skeleton, StatusChip, TypeChip } from '../../design';
import { processedBodyUrl, RENDERABLE_IMAGE_TYPES, useTurnDetail, type AttachmentRow, type ResponseRow, type TurnChild, type TurnInjection, type TurnRow } from '../../hooks/use-sessions';
import { cn } from '../../lib/cn';
import { PlanLine } from '../knowledge/PlanLine';
import { TextOrBlob } from './StoredText';
import { ToolCalls } from './ToolCalls';
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

/** A prompt that steered the turn while it ran, nested under the turn it steered. */
function SteeringChild({ projectId, sessionId, child }: { projectId: string; sessionId: string; child: TurnChild }) {
  return (
    <div className="flex flex-col gap-s3 border-l-2 border-line-strong pl-s4" data-testid="turn-child">
      <div className="flex items-baseline gap-s2 t-meta text-muted">
        <span className="font-medium text-ink-2">Steered while it ran{child.prompt.threadLabel !== null ? ` · ${child.prompt.threadLabel}` : ''}</span>
        <time dateTime={new Date(child.prompt.createdAt).toISOString()}>{clockTime(child.prompt.createdAt)}</time>
      </div>
      <TextOrBlob projectId={projectId} text={child.prompt.text} blobKey={child.prompt.blobKey} body={{ kind: 'prompt', id: child.prompt.promptId }} />
      <ToolCalls projectId={projectId} sessionId={sessionId} promptId={child.prompt.promptId} total={child.toolCallCount} />
      <Replies projectId={projectId} responses={child.responses} />
    </div>
  );
}

/** What Myco added to this prompt: one folded line, opening on the spores it served, each a link to the spore. */
function Injection({ projectId, injection }: { projectId: string; injection: TurnInjection }) {
  const served = injection.spores.length;
  const missing = injection.sporeIds.length - served;
  if (injection.sporeIds.length === 0) return null;
  return (
    <div data-testid="turn-injection">
      <Disclosure summary={`Myco added ${count(served, 'spore')} to this prompt`}>
        <ul className="flex flex-col gap-s2" aria-label="Spores added to this prompt">
          {injection.spores.map((spore) => (
            <li key={spore.id} className="flex min-w-0 items-baseline gap-s2 t-small">
              <TypeChip>{sporeTypeWord(spore.observationType)}</TypeChip>
              <ItemLink to={`/p/${encodeURIComponent(projectId)}/spores/${encodeURIComponent(spore.id)}`} lines={1} className="text-ink-2 hover:text-ink">
                {spore.preview}
              </ItemLink>
            </li>
          ))}
          {missing > 0 && <li className="t-small text-muted">{count(missing, 'spore')} no longer kept</li>}
        </ul>
      </Disclosure>
    </div>
  );
}

/** The prompt itself: its whole text once the body is read, its opening before; a long one shows its opening until asked. */
function PromptText({ projectId, turn, text, blobKey }: { projectId: string; turn: TurnRow; text: string | null | undefined; blobKey: string | null | undefined }) {
  const [whole, setWhole] = useState(false);
  if (text === undefined) return <p className="whitespace-pre-wrap break-words t-body font-medium text-ink">{promptPreview(turn)}</p>;
  const stored = text === null && blobKey != null;
  if (!whole && (stored || (text?.length ?? 0) > LONG_PROMPT_CHARS)) {
    return (
      <div className="flex flex-col items-start gap-s1">
        <p className="line-clamp-6 whitespace-pre-wrap break-words t-body font-medium text-ink">{text ?? promptPreview(turn)}</p>
        <Button variant="ghost" size="sm" className="-ml-s3" onClick={() => setWhole(true)}>Show the whole prompt</Button>
      </div>
    );
  }
  return <div className="font-medium text-ink"><TextOrBlob projectId={projectId} text={text} blobKey={blobKey ?? null} body={{ kind: 'prompt', id: turn.promptId }} /></div>;
}

export interface TurnProps {
  projectId: string;
  sessionId: string;
  turn: TurnRow;
  /** A link named this turn: bring it into view once it mounts. */
  scrollTo?: boolean;
}

/**
 * One turn of the conversation, read inline: the prompt as a bubble, then what
 * followed it and the replies. Only the tool calls fold away. The turn's body
 * is read once the turn comes near the viewport, so a long conversation reads
 * only what the reader reaches.
 */
export const Turn = memo(function Turn({ projectId, sessionId, turn, scrollTo = false }: TurnProps) {
  const injected = turn.origin !== 'user';
  const [ref, seen] = useSeen<HTMLLIElement>();
  const detail = useTurnDetail(projectId, sessionId, turn.promptId, seen || scrollTo);
  useEffect(() => {
    if (scrollTo && typeof ref.current?.scrollIntoView === 'function') ref.current.scrollIntoView({ block: 'start' });
  }, [scrollTo, ref]);
  const body = detail.data;
  return (
    <li ref={ref} data-testid={`turn-${turn.promptId}`} data-origin={turn.origin} className="flex flex-col gap-s3">
      <div className={cn('flex flex-col gap-s1 rounded-card border px-s4 py-s3', injected ? 'border-dashed border-line-strong' : 'border-line bg-surface-2')}>
        <span className="flex flex-wrap items-center gap-x-s2 gap-y-s1 t-meta text-muted">
          {injected && <StatusChip>{ORIGIN_LABEL[turn.origin] ?? 'Added'}</StatusChip>}
          {turn.threadLabel !== null && <StatusChip>{turn.threadLabel}</StatusChip>}
          <time dateTime={new Date(turn.createdAt).toISOString()}>{clockTime(turn.createdAt)}</time>
        </span>
        <PromptText projectId={projectId} turn={turn} text={body === undefined ? undefined : body.prompt.text} blobKey={body?.prompt.blobKey} />
      </div>
      <div data-testid="turn-body" className="flex flex-col gap-s4 pl-s6">
        {body === undefined ? (
          detail.error
            ? <p className="t-small text-bad">This turn could not be read.</p>
            : (turn.responseCount > 0 || turn.toolCallCount > 0) && <div role="status" aria-label="Loading the turn" className="flex flex-col gap-s2"><Skeleton className="h-s4 w-3/4" /><Skeleton className="h-s4 w-1/2" /></div>
        ) : (
          <>
            <Attachments projectId={projectId} attachments={body.attachments} />
            {body.injection !== null && <Injection projectId={projectId} injection={body.injection} />}
            {body.plans.length > 0 && (
              <div className="flex flex-col gap-s2" data-testid="turn-plans">
                {body.plans.map((plan) => <PlanLine key={plan.planKey} projectId={projectId} plan={plan} now={Date.now()} />)}
              </div>
            )}
            <ToolCalls projectId={projectId} sessionId={sessionId} promptId={turn.promptId} total={turn.toolCallCount} />
            {body.children.map((child) => <SteeringChild key={child.prompt.promptId} projectId={projectId} sessionId={sessionId} child={child} />)}
            <Replies projectId={projectId} responses={body.responses} />
          </>
        )}
      </div>
    </li>
  );
});
