import { useState } from 'react';
import { Bot, ChevronDown, ChevronRight } from 'lucide-react';
import { Lightbox } from '../ui/lightbox';
import { Skeleton } from '../ui/skeleton';
import { Surface } from '../ui/surface';
import { blobUrl, RENDERABLE_IMAGE_TYPES, useTurnDetail, type AttachmentRow, type ResponseRow, type TurnChild, type TurnRow } from '../../hooks/use-sessions';
import { formatDateTime, formatRelative } from '../../lib/format';
import { cn } from '../../lib/cn';
import { TextOrBlob } from './stored-text';
import { ToolCallList } from './ToolCallList';

/** How much of a prompt a collapsed card shows. */
export const PROMPT_PREVIEW_CHARS = 120;

/** What a card calls a prompt of each origin, in the reader's words rather than the wire's. */
const ORIGIN_LABEL: Record<string, string> = {
  user: 'Prompt',
  system: 'System',
  agent_dispatch: 'Sub-agent',
  hook_injected: 'Injected',
  unknown: 'Prompt',
};

/** The one line a collapsed card shows for its prompt. */
export function promptPreview(turn: Pick<TurnRow, 'preview' | 'textChars' | 'blobKey'>): string {
  if (turn.preview === null || turn.preview === '') return turn.blobKey !== null ? 'Stored text' : '(no prompt)';
  const line = turn.preview.replace(/\s+/g, ' ').trim();
  const cut = line.length > PROMPT_PREVIEW_CHARS ? `${line.slice(0, PROMPT_PREVIEW_CHARS)}…` : line;
  return cut.length < line.length || (turn.textChars !== null && turn.textChars > turn.preview.length) ? (cut.endsWith('…') ? cut : `${cut}…`) : cut;
}

const eyebrow = 'font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant';

function Attachments({ projectId, attachments }: { projectId: string; attachments: AttachmentRow[] }) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const images = attachments.filter((a) => RENDERABLE_IMAGE_TYPES.includes(a.mediaType));
  const files = attachments.filter((a) => !RENDERABLE_IMAGE_TYPES.includes(a.mediaType));
  if (attachments.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-start gap-3" data-testid="turn-attachments">
      {images.map((a, i) => (
        <button key={a.attachmentId} type="button" onClick={() => setLightbox(i)} className="overflow-hidden rounded-md transition-all hover:ring-2 hover:ring-primary/40" aria-label={`Open ${a.description ?? 'image'}`}>
          <img src={blobUrl(projectId, a.blobKey)} alt={a.description ?? a.attachmentId} loading="lazy" className="max-h-[140px] max-w-[200px] rounded-md object-cover" />
        </button>
      ))}
      {files.map((a) => (
        <a key={a.attachmentId} href={blobUrl(projectId, a.blobKey)} className="font-sans text-xs text-primary underline">Download {a.description ?? a.attachmentId}</a>
      ))}
      {lightbox !== null && (
        <Lightbox images={images.map((a) => ({ src: blobUrl(projectId, a.blobKey), alt: a.description ?? a.attachmentId }))} index={lightbox} onNavigate={setLightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

function Responses({ projectId, responses }: { projectId: string; responses: ResponseRow[] }) {
  if (responses.length === 0) return null;
  return (
    <div className="border-t border-[var(--ghost-border)]">
      {responses.map((r) => (
        <div key={r.responseId} className="flex gap-3 px-4 py-3" data-testid="turn-response">
          <div className="w-0.5 shrink-0 rounded-full bg-primary/30" />
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center gap-1.5">
              <Bot className="h-3 w-3 text-primary/60" />
              <span className={eyebrow}>Response</span>
              <span className="ml-auto font-mono text-[10px] text-on-surface-variant" title={formatDateTime(r.createdAt)}>{formatRelative(r.createdAt)}</span>
            </div>
            <TextOrBlob projectId={projectId} text={r.text} blobKey={r.blobKey} markdown />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A steering or interrupt prompt nested under the turn it steered. */
function SteeringChild({ projectId, sessionId, child }: { projectId: string; sessionId: string; child: TurnChild }) {
  return (
    <div className="mx-4 mt-3 border-l-2 border-primary/30 pb-3 pl-4" data-testid="turn-child">
      <div className="mb-1 font-sans text-[10px] font-medium uppercase tracking-widest text-primary/70">↳ steering{child.prompt.threadLabel !== null ? ` · ${child.prompt.threadLabel}` : ''}</div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className={eyebrow}>Prompt</span>
        <span className="shrink-0 font-mono text-xs text-on-surface-variant" title={formatDateTime(child.prompt.createdAt)}>{formatRelative(child.prompt.createdAt)}</span>
      </div>
      <TextOrBlob projectId={projectId} text={child.prompt.text} blobKey={child.prompt.blobKey} markdown />
      <ToolCallList projectId={projectId} sessionId={sessionId} promptId={child.prompt.promptId} count={child.toolCallCount} />
      <Responses projectId={projectId} responses={child.responses} />
    </div>
  );
}

function TurnBody({ projectId, sessionId, turn }: { projectId: string; sessionId: string; turn: TurnRow }) {
  const detail = useTurnDetail(projectId, sessionId, turn.promptId, true);
  if (detail.isPending) return <div className="space-y-2 px-4 pb-3"><Skeleton className="h-3 w-3/4" /><Skeleton className="h-3 w-1/2" /></div>;
  if (detail.error) return <p className="px-4 pb-3 font-sans text-xs text-tertiary">This turn could not be read.</p>;
  const body = detail.data;
  // A short prompt is already whole in the header; the body repeats it only when there is more to read.
  const promptAlreadyShown = body.prompt.text !== null && body.prompt.text.replace(/\s+/g, ' ').trim().length <= PROMPT_PREVIEW_CHARS;
  const hasPromptBody = !promptAlreadyShown || body.attachments.length > 0;
  return (
    <div data-testid="turn-body">
      {hasPromptBody && (
        <div className="px-4 pb-3">
          {!promptAlreadyShown && <TextOrBlob projectId={projectId} text={body.prompt.text} blobKey={body.prompt.blobKey} markdown />}
          <Attachments projectId={projectId} attachments={body.attachments} />
        </div>
      )}
      <ToolCallList projectId={projectId} sessionId={sessionId} promptId={turn.promptId} count={turn.toolCallCount} />
      {body.children.map((child) => <SteeringChild key={child.prompt.promptId} projectId={projectId} sessionId={sessionId} child={child} />)}
      <Responses projectId={projectId} responses={body.responses} />
    </div>
  );
}

export interface TurnCardProps {
  projectId: string;
  sessionId: string;
  turn: TurnRow;
  index: number;
  isLast: boolean;
  defaultOpen?: boolean;
}

/** One turn on the timeline spine: a numbered node, a collapsible header with the prompt's first line, and — open — the prompt in full with what followed it. */
export function TurnCard({ projectId, sessionId, turn, index, isLast, defaultOpen = false }: TurnCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const injected = turn.origin !== 'user';
  return (
    <div className="relative flex gap-2" data-testid={`turn-${turn.promptId}`} data-origin={turn.origin} style={open ? undefined : { contentVisibility: 'auto', containIntrinsicSize: 'auto 72px' }}>
      <div className="relative flex shrink-0 flex-col items-center" style={{ width: 28 }}>
        {index > 0 && <div className="absolute top-0 w-px bg-outline-variant/40" style={{ height: 14 }} />}
        <div className={cn('z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-bold transition-colors', open ? 'bg-primary text-on-primary' : 'border border-outline-variant/40 bg-surface-container-high text-on-surface-variant')}>
          {index + 1}
        </div>
        {!isLast && <div className="w-px flex-1 bg-outline-variant/40" />}
      </div>
      <Surface level="low" className={cn('mb-2 max-w-full flex-1 overflow-hidden rounded-md border', injected ? 'border-dashed border-outline-variant/30 bg-surface-container-low/60' : 'border-outline-variant/10')}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn('flex w-full items-start gap-3 overflow-hidden px-4 py-3 text-left transition-colors hover:bg-surface-container/40', open && 'bg-surface-container/20')}
        >
          {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-on-surface-variant" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-on-surface-variant" />}
          <span className="min-w-0 flex-1 overflow-hidden">
            <span className="mb-0.5 flex items-baseline justify-between gap-2">
              <span className={cn(eyebrow, 'shrink-0')}>{ORIGIN_LABEL[turn.origin] ?? 'Prompt'}</span>
              {turn.toolCallCount > 0 && <span className="shrink-0 font-mono text-[10px] text-on-surface-variant/70">{turn.toolCallCount.toLocaleString()} tool call{turn.toolCallCount !== 1 ? 's' : ''}</span>}
              {turn.threadLabel !== null && <span className="inline-flex shrink-0 items-center rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">{turn.threadLabel}</span>}
              <span className="shrink-0 font-mono text-xs text-on-surface-variant" title={formatDateTime(turn.createdAt)}>{formatRelative(turn.createdAt)}</span>
            </span>
            <span className="block truncate font-sans text-sm text-on-surface">{promptPreview(turn)}</span>
          </span>
        </button>
        {open && <TurnBody projectId={projectId} sessionId={sessionId} turn={turn} />}
      </Surface>
    </div>
  );
}
