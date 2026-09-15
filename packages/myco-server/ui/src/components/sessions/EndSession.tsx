import { useState } from 'react';
import { CircleStop } from 'lucide-react';
import { useEndSession, type SessionRow } from '../../hooks/use-sessions';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Button } from '../ui/button';

/** End an open session now. Capture is not stopped: a newer captured turn from a person reopens it. */
export function EndSession({ projectId, session }: { projectId: string; session: SessionRow }) {
  const [open, setOpen] = useState(false);
  const ending = useEndSession(projectId, session.sessionId);
  const keptOpen = ending.data?.outcome === 'open';
  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
      <CircleStop className="mr-2 h-3.5 w-3.5" /> End session
    </Button>
    <ConfirmDialog open={open} onOpenChange={(next) => {
      if (ending.isPending) return;
      setOpen(next);
      ending.reset();
    }} title="End this session?"
      description="Mark this session as ended now. Capture is not stopped: a newer captured turn from a person reopens the session, and it shows as open again. Once ended, its title and summary are requested the way any ended session's are."
      meta={[{ label: 'Session ID', value: session.sessionId }, { label: 'Session', value: session.label }]}
      confirmLabel="End session" isPending={ending.isPending}
      errorMessage={ending.error
        ? 'The session could not be ended. Retry to end it.'
        : keptOpen ? 'A newer captured turn arrived first, so the session is still open. End it again to end it after that turn.' : null}
      onConfirm={() => {
        if (ending.isPending) return;
        ending.mutate(undefined, { onSuccess: (answer) => { if (answer.outcome !== 'open') setOpen(false); } });
      }} />
  </>;
}
