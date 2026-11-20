import { countEvidence } from './evidence';
import type { SessionEvidence } from './wire';
import { useEffect, useState } from 'react';
import { CircleStop, PenLine, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog, Link, MoreMenu, type MoreMenuItem } from '../../design';
import { useRunDetail } from '../../hooks/use-work';
import { useStatus } from '../../hooks/use-status';
import {
  TITLING_OUTCOME_TEXT, TITLING_WATCH_MS, useDeleteSession, useEndSession, useTitleSession,
  type SessionCounts, type SessionRow,
} from '../../hooks/use-sessions';
import { sessionHeadingText } from '../../lib/session-text';
import { runPath } from '../../routes/nav';
import { count } from './words';

/** How often the page asks again while a new title is being written. */
const TITLING_POLL_MS = 5_000;
const isTerminal = (status: string): boolean => status === 'completed' || status === 'failed' || status === 'skipped';

type Confirming = 'retitle' | 'end' | 'delete' | null;

export interface SessionActionsProps {
  projectId: string;
  session: SessionRow;
  counts: SessionCounts;
  visibility: SessionEvidence['visibility'];
  onDeleted: () => void;
}

/**
 * An admin's actions on a session, in its ⋯ menu beside the facts' copy action: write a new title, end it
 * while it is open, and delete it. Each passes through a confirmation that says
 * what it will do. After a new title is asked for, the page watches: it reads
 * the session again every few seconds until the title moves or the run ends.
 */
export function SessionActions({ projectId, session, counts, visibility, onDeleted }: SessionActionsProps) {
  const [confirming, setConfirming] = useState<Confirming>(null);
  const status = useStatus({ enabled: confirming === 'delete' });
  const target = status.error === null ? status.data?.target : null;
  const retentionKnown = target === 'cloudflare' || target === 'bun';
  const open = session.endedAt === null;
  const heading = sessionHeadingText(session);
  const retitle = useRetitle(projectId, session);
  const ending = useEndSession(projectId, session.sessionId);
  const deletion = useDeleteSession();
  const keptOpen = ending.data?.outcome === 'open';

  const items: MoreMenuItem[] = [
    { label: 'Write a new title and summary', icon: <PenLine aria-hidden className="size-s4" />, onSelect: () => setConfirming('retitle'), disabled: retitle.busy },
    ...(open ? [{ label: 'End session', icon: <CircleStop aria-hidden className="size-s4" />, onSelect: () => setConfirming('end') }] : []),
    { label: 'Delete session', icon: <Trash2 aria-hidden className="size-s4" />, tone: 'danger', onSelect: () => setConfirming('delete') },
  ];
  const close = (pending: boolean, reset: () => void) => (next: boolean) => {
    if (pending || next) return;
    setConfirming(null);
    reset();
  };

  return (
    <>
      <MoreMenu items={items} label="Session actions" />
      {retitle.note !== null && (
        <p role="status" className="w-full t-small text-muted">
          {retitle.note}
          {retitle.runHref !== null && <> · <Link to={retitle.runHref}>see the run</Link></>}
        </p>
      )}

      <ConfirmDialog
        open={confirming === 'retitle'}
        onOpenChange={close(retitle.pending, retitle.reset)}
        title="Write a new title and summary?"
        description={`Myco reads “${heading}” again and writes its title and summary. This runs one of Myco’s tasks, which spends tokens with your model provider.`}
        confirmLabel="Write a new title and summary"
        tone="primary"
        pending={retitle.pending}
        error={retitle.failed ? TITLING_OUTCOME_TEXT.error : null}
        onConfirm={() => retitle.ask(() => setConfirming(null))}
      />

      <ConfirmDialog
        open={confirming === 'end'}
        onOpenChange={close(ending.isPending, ending.reset)}
        title="End this session?"
        description={`Marks “${heading}” as ended now. Capture isn’t stopped: a newer turn a person types opens it again. Once it’s ended, Myco titles it the way it titles any ended session.`}
        confirmLabel="End session"
        tone="primary"
        pending={ending.isPending}
        error={ending.error
          ? 'The session couldn’t be ended. Try again.'
          : keptOpen ? 'A newer turn arrived first, so the session is still open. End it again to end it after that turn.' : null}
        onConfirm={() => {
          if (ending.isPending) return;
          ending.mutate(undefined, { onSuccess: (answer) => { if (answer.outcome !== 'open') setConfirming(null); } });
        }}
      />

      <ConfirmDialog
        open={confirming === 'delete'}
        onOpenChange={close(deletion.isPending, deletion.reset)}
        title="Delete this session?"
        description={!retentionKnown ? 'Reading how this server removes stored data…'
          : `${target === 'cloudflare' ? `Removes “${heading}” from Myco now: its conversation, plans, transcripts and attachments. Its stored data is kept for at least 30 days before removal.` : `Permanently removes “${heading}”: its conversation, plans, transcripts and attachments.`} The spores learned from it, and other sessions, including sessions it started, stay. Capture and imports can’t bring it back.`}
        confirmLabel={target === 'bun' ? 'Delete permanently' : 'Delete session'}
        confirmDisabled={!retentionKnown}
        pending={deletion.isPending}
        error={deletion.error ? 'The deletion couldn’t be confirmed. Try again to finish deleting this session.'
          : status.error !== null ? 'The storage policy couldn’t be read. Close this dialog and try again.' : null}
        onConfirm={() => {
          if (deletion.isPending || !retentionKnown) return;
          deletion.mutate({ projectId, sessionId: session.sessionId }, { onSuccess: onDeleted });
        }}
      >
        <p className="t-small text-ink-2" data-delete-impact="">
          {[count(counts.prompts, 'prompt'), countEvidence({counts, visibility}, 'toolCalls', 'tool call'), count(counts.plans, 'plan'), count(counts.attachments, 'attachment')].join(' · ')}
        </p>
      </ConfirmDialog>
    </>
  );
}

/** Asks for a new title and follows the run that writes it, saying in one line how it went. */
function useRetitle(projectId: string, session: SessionRow) {
  const client = useQueryClient();
  const titling = useTitleSession(projectId, session.sessionId);
  // What the session carried when the ask was made; a change since is the title landing.
  const [asked, setAsked] = useState<{ runId: string; title: string | null; summary: string | null; at: number } | null>(null);
  const landed = asked !== null && (session.title !== asked.title || session.summary !== asked.summary);
  const expired = asked !== null && Date.now() - asked.at > TITLING_WATCH_MS;
  // A miss before the run is claimed is kept, not retried; the timer below asks again.
  const run = useRunDetail(projectId, asked?.runId ?? '', { enabled: asked !== null && !landed && !expired, retry: false });
  const runStatus = run.data?.run.status ?? null;
  const watching = asked !== null && !landed && !expired && (runStatus === null || !isTerminal(runStatus));
  const runId = asked?.runId ?? null;
  // One timer reads both again: a query's own interval pauses while the window is not focused, and a title lands whether or not the reader is looking.
  useEffect(() => {
    if (!watching || runId === null) return undefined;
    const timer = setInterval(() => {
      void client.invalidateQueries({ queryKey: ['session', projectId, session.sessionId] });
      void client.invalidateQueries({ queryKey: ['run', projectId, runId] });
    }, TITLING_POLL_MS);
    return () => clearInterval(timer);
  }, [watching, client, projectId, session.sessionId, runId]);

  const outcome = titling.data?.outcome;
  const note = landed ? 'The new title and summary are in'
    : asked !== null && runStatus === 'failed' ? TITLING_OUTCOME_TEXT.error
    : asked !== null && (expired || (runStatus !== null && isTerminal(runStatus))) ? TITLING_OUTCOME_TEXT.error
    : outcome !== undefined ? TITLING_OUTCOME_TEXT[outcome] : null;
  return {
    note,
    runHref: asked !== null && !landed ? runPath(projectId, asked.runId) : null,
    busy: titling.isPending || watching,
    pending: titling.isPending,
    failed: titling.isError || titling.data?.outcome === 'error' || titling.data?.outcome === 'ceiling',
    reset: () => titling.reset(),
    ask: (done: () => void) => {
      if (titling.isPending) return;
      setAsked(null);
      titling.mutate(undefined, {
        onSuccess: (answer) => {
          if ((answer.outcome === 'dispatched' || answer.outcome === 'queued') && answer.runId !== undefined) {
            setAsked({ runId: answer.runId, title: session.title, summary: session.summary, at: Date.now() });
          }
          if (answer.outcome !== 'error' && answer.outcome !== 'ceiling') done();
        },
      });
    },
  };
}
