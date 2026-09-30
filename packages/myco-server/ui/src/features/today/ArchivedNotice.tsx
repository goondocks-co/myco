import { useState } from 'react';
import { Button, Card, HealthDot } from '../../design';
import { refusalText } from '../../hooks/use-access';
import { useIsAdmin } from '../../hooks/use-me';
import { useProjectActions } from '../../hooks/use-projects';
import { ago } from './words';

/** An archived project says so first: new capture is refused until it is unarchived, and everything captured stays readable. */
export function ArchivedNotice({ projectId, archivedAt, now }: { projectId: string; archivedAt: number | null; now: number }) {
  const admin = useIsAdmin();
  const actions = useProjectActions();
  const [error, setError] = useState<string | null>(null);
  return (
    <Card className="flex flex-wrap items-center gap-x-s4 gap-y-s2 bg-warn-bg" data-testid="archived-banner">
      <HealthDot tone="warn" label="Archived" />
      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <p className="t-body font-medium text-ink">
          {admin ? 'This project is archived: agents can’t send it anything until you unarchive it.' : 'This project is archived: agents can’t send it anything until an admin unarchives it.'}
        </p>
        <p className="t-small text-ink-2">
          {archivedAt === null ? 'Everything captured before stays readable.' : `Archived ${ago(archivedAt, now)}. Everything captured before stays readable.`}
        </p>
        {error !== null && <p role="alert" className="t-small font-medium text-ink">{error}</p>}
      </div>
      {admin && (
        <Button
          size="sm"
          pending={actions.unarchive.isPending}
          onClick={() => { setError(null); actions.unarchive.mutate(projectId, { onError: (err) => setError(refusalText(err)) }); }}
        >
          Unarchive
        </Button>
      )}
    </Card>
  );
}
