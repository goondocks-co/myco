import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Button, Disclosure, ExternalLink, focusRing, Lightbox, Skeleton, StatusChip, TypeChip } from '../../design';
import { blobUrl, RENDERABLE_IMAGE_TYPES, useTurnDetail, type AttachmentRow, type ResponseRow, type TurnChild, type TurnInjection, type TurnRow } from '../../hooks/use-sessions';
import { cn } from '../../lib/cn';
import { PlanCard } from '../../components/sessions/PlanCard';
import { TextOrBlob } from './StoredText';
import { ToolCalls } from './ToolCalls';
import { clockTime, count, sporeTypeWord } from './words';

/** How much of a prompt a folded turn shows. */
export const PROMPT_PREVIEW_CHARS = 120;

/** What a turn calls a prompt a person did not type, in the reader's words rather than the wire's. */
const ORIGIN_LABEL: Record<string, string> = {
  system: 'System',
  agent_dispatch: 'Sub-agent',
  hook_injected: 'Added by a hook',
};

/** The one line a folded turn shows for its prompt. */
export function promptPreview(turn: Pick<TurnRow, 'preview' | 'textChars' | 'blobKey'>): string {
  if (turn.preview === null || turn.preview === '') return turn.blobKey !== null ? 'Stored text' : '(no prompt)';
  const line = turn.preview.replace(/\s+/g, ' ').trim();
  const cut = line.length > PROMPT_PREVIEW_CHARS ? `${line.slice(0, PROMPT_PREVIEW_CHARS)}…` : line;
  return cut.length < line.length || (turn.textChars !== null && turn.textChars > turn.preview.length) ? (cut.endsWith('…') ? cut : `${cut}…`) : cut;
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
          <img src={blobUrl(projectId, a.blobKey)} alt={a.description ?? 'An attached image'} loading="eager" className="max-h-[140px] max-w-[200px] object-cover" />
        </Button>
      ))}
      {files.map((a) => (
        <ExternalLink key={a.attachmentId} href={blobUrl(projectId, a.blobKey)} className="t-small">Download {a.description ?? 'the attachment'}</ExternalLink>
      ))}
      {lightbox !== null && (
        <Lightbox images={images.map((a) => ({ src: blobUrl(projectId, a.blobKey), alt: a.description ?? 'An attached image' }))} index={lightbox} onNavigate={setLightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

function Responses({ projectId, responses }: { projectId: string; responses: ResponseRow[] }) {
  if (responses.length === 0) return null;
  return (
    <div className="flex flex-col gap-s4">
      {responses.map((r) => (
        <div key={r.responseId} className="flex flex-col gap-s1" data-testid="turn-response">
          <time dateTime={new Date(r.createdAt).toISOString()} className="t-meta text-faint">Reply · {clockTime(r.createdAt)}</time>
          <TextOrBlob projectId={projectId} text={r.text} blobKey={r.blobKey} markdown />
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
      <TextOrBlob projectId={projectId} text={child.prompt.text} blobKey={child.prompt.blobKey} markdown />
      <ToolCalls projectId={projectId} sessionId={sessionId} promptId={child.prompt.promptId} total={child.toolCallCount} />
      <Responses projectId={projectId} responses={child.responses} />
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
              <RouterLink to={`/p/${encodeURIComponent(projectId)}/spores/${encodeURIComponent(spore.id)}`} className={cn('min-w-0 truncate rounded-chip text-ink-2 hover:text-ink hover:underline', focusRing)}>
                {spore.preview}
              </RouterLink>
            </li>
          ))}
          {missing > 0 && <li className="t-small text-muted">{count(missing, 'spore')} no longer kept</li>}
        </ul>
      </Disclosure>
    </div>
  );
}

function TurnBody({ projectId, sessionId, turn }: { projectId: string; sessionId: string; turn: TurnRow }) {
  const detail = useTurnDetail(projectId, sessionId, turn.promptId, true);
  if (detail.isPending) return <div role="status" aria-label="Loading the turn" className="flex flex-col gap-s2 py-s3"><Skeleton className="h-s4 w-3/4" /><Skeleton className="h-s4 w-1/2" /></div>;
  if (detail.error) return <p className="py-s3 t-small text-bad">This turn could not be read.</p>;
  const body = detail.data;
  // A short prompt is already whole in its summary; the body repeats it only when there is more to read.
  const promptAlreadyShown = body.prompt.text !== null && body.prompt.text.replace(/\s+/g, ' ').trim().length <= PROMPT_PREVIEW_CHARS;
  return (
    <div data-testid="turn-body" className="flex flex-col gap-s4 pb-s2 pl-s6 pt-s4">
      {!promptAlreadyShown && (
        <div className="rounded-card border border-line bg-surface-1 px-s4 py-s3">
          <TextOrBlob projectId={projectId} text={body.prompt.text} blobKey={body.prompt.blobKey} markdown />
        </div>
      )}
      <Attachments projectId={projectId} attachments={body.attachments} />
      {body.injection !== null && <Injection projectId={projectId} injection={body.injection} />}
      {body.plans.length > 0 && (
        <div className="flex flex-col gap-s2" data-testid="turn-plans">
          {body.plans.map((plan) => <PlanCard key={plan.planKey} projectId={projectId} sessionId={sessionId} plan={plan} inTurn />)}
        </div>
      )}
      <ToolCalls projectId={projectId} sessionId={sessionId} promptId={turn.promptId} total={turn.toolCallCount} />
      {body.children.map((child) => <SteeringChild key={child.prompt.promptId} projectId={projectId} sessionId={sessionId} child={child} />)}
      <Responses projectId={projectId} responses={body.responses} />
    </div>
  );
}

export interface TurnProps {
  projectId: string;
  sessionId: string;
  turn: TurnRow;
  defaultOpen?: boolean;
  /** A link named this turn: bring it into view once it mounts. */
  scrollTo?: boolean;
}

/** One turn of the conversation: the prompt as a bubble with what followed it counted, opening on the prompt in full, the work it led to and the replies. */
export function Turn({ projectId, sessionId, turn, defaultOpen = false, scrollTo = false }: TurnProps) {
  const injected = turn.origin !== 'user';
  const el = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (scrollTo && typeof el.current?.scrollIntoView === 'function') el.current.scrollIntoView({ block: 'start' });
  }, [scrollTo]);
  const facts = [
    turn.toolCallCount > 0 ? count(turn.toolCallCount, 'tool call') : null,
    turn.planCount > 0 ? count(turn.planCount, 'plan') : null,
    turn.attachmentCount > 0 ? count(turn.attachmentCount, 'attachment') : null,
  ].filter((fact): fact is string => fact !== null);
  return (
    <li ref={el} data-testid={`turn-${turn.promptId}`} data-origin={turn.origin}>
      <Disclosure
        wide
        defaultOpen={defaultOpen}
        summaryClassName={cn('rounded-card border px-s4 py-s3', injected ? 'border-dashed border-line-strong bg-transparent' : 'border-line bg-surface-2')}
        summary={(
          <>
            <span className="line-clamp-2 t-body font-medium text-ink">{promptPreview(turn)}</span>
            <span className="mt-s1 flex flex-wrap items-center gap-x-s2 gap-y-s1 t-meta text-muted">
              {injected && <StatusChip>{ORIGIN_LABEL[turn.origin] ?? 'Added'}</StatusChip>}
              {turn.threadLabel !== null && <StatusChip>{turn.threadLabel}</StatusChip>}
              <time dateTime={new Date(turn.createdAt).toISOString()}>{clockTime(turn.createdAt)}</time>
              {facts.map((fact) => <span key={fact}><span aria-hidden className="mr-s2">·</span>{fact}</span>)}
            </span>
          </>
        )}
      >
        <TurnBody projectId={projectId} sessionId={sessionId} turn={turn} />
      </Disclosure>
    </li>
  );
}
