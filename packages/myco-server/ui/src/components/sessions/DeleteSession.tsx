import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useDeleteSession, type SessionCounts, type SessionRow } from '../../hooks/use-sessions';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Button } from '../ui/button';

export function DeleteSession({ projectId, session, counts, onDeleted }: {
  projectId: string; session: SessionRow; counts: SessionCounts; onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const deletion = useDeleteSession();
  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
      <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete session
    </Button>
    <ConfirmDialog open={open} onOpenChange={(next) => {
      if (deletion.isPending) return;
      setOpen(next);
      deletion.reset();
    }} title="Delete this session?"
      description="Permanently remove this session's conversation, captured plans, transcripts and attachments from Myco. Saved knowledge and other sessions, including child sessions, remain. New capture and re-import cannot recreate this session."
      meta={[{ label: 'Session ID', value: session.sessionId }, { label: 'Session', value: session.label }]}
      impact={[{ label: 'Prompts', value: counts.prompts }, { label: 'Tool calls', value: counts.toolCalls }, { label: 'Plans', value: counts.plans }, { label: 'Attachments', value: counts.attachments }]}
      confirmLabel="Delete permanently" isPending={deletion.isPending}
      errorMessage={deletion.error ? 'The deletion could not be confirmed. Retry to finish deleting this session.' : null}
      onConfirm={() => {
        if (deletion.isPending) return;
        deletion.mutate({ projectId, sessionId: session.sessionId }, { onSuccess: onDeleted });
      }} />
  </>;
}
