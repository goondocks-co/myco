import { useState } from 'react';
import {
  Button, buttonVariants, Card, ConfirmDialog, ErrorState, ExternalLink, Link, LoadingState, MoreMenu, StatusChip, Switch,
} from '../../../design';
import { useBackups, type BackupRow, type RestoreOutcome, type RestorePreview } from '../../../hooks/use-backups';
import { useForgetUnsettledExport, useRecovery } from '../../../hooks/use-recovery';
import { cn } from '../../../lib/cn';
import { HEALTH_ANCHORS, SETTINGS_SECTIONS } from '../../../routes/nav';
import { AdminSection, RowCard } from '../AdminFrame';
import {
  attemptWords, availableWords, backupDate, cadenceWords, countsWords, latestWords, sizeLabel, unsupported, whenLabel,
} from './words';

const RECOVERY_PROCEDURE = 'https://github.com/goondocks-co/myco/blob/main/docs/architecture/deployment-recovery.md';
const BACKUP_SETTINGS = SETTINGS_SECTIONS.find((section) => section.id === 'backups')!.to;

/** Why an action failed, in the server's own words when it gave them. */
const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Backups: the small additive export an admin makes here, each with its
 * restore behind a preview and a confirm, then automatic recovery, the
 * complete-recovery path the Deployment runs on its own clock.
 */
export function BackupsSection() {
  const backups = useBackups();
  const [confirming, setConfirming] = useState<{ row: BackupRow; preview: RestorePreview } | null>(null);
  const [adopt, setAdopt] = useState(false);
  const [adoptAsked, setAdoptAsked] = useState(false);
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null);

  const rows = backups.list.data?.backups ?? [];
  const openRestore = (row: BackupRow) => {
    setOutcome(null);
    backups.restore.reset();
    backups.preview.mutate(row.id, { onSuccess: (preview) => { setAdopt(false); setAdoptAsked(false); setConfirming({ row, preview }); } });
  };
  const actionError = backups.create.error ?? backups.pin.error ?? backups.preview.error;
  const skips = outcome === null ? [] : Object.entries(outcome.tables).filter(([, t]) => t.skipped !== undefined);

  return (
    <AdminSection
      id={HEALTH_ANCHORS.backups}
      title="Backups"
      description="A backup made here holds up to 64 MiB of records for an additive restore. It reads records while the server runs, so it is not a consistent snapshot, and it leaves out attachment and transcript files, settings and secrets."
      actions={<Button variant="primary" pending={backups.create.isPending} onClick={() => backups.create.mutate()}>Create backup</Button>}
    >
      <p className="max-w-measure t-small text-muted">
        For larger backups or a complete replacement, follow the{' '}
        <ExternalLink href={RECOVERY_PROCEDURE}>operator backup and recovery procedure</ExternalLink>.
      </p>
      {actionError !== null && <p role="alert" className="t-small text-bad">{failure(actionError)}</p>}
      {backups.list.isPending ? <LoadingState label="Reading the backups" count={2} />
        : backups.list.error !== null ? <ErrorState error={backups.list.error} onRetry={() => void backups.list.refetch()} />
        : rows.length === 0 ? <p className="t-body text-muted">No backups yet. The first one is a click away.</p>
        : (
          <RowCard label="Backups">
            {rows.map((row) => (
              <div key={row.id} className="flex flex-wrap items-center gap-x-s3 gap-y-s2 px-s4 py-s3" data-health-backup="">
                <div className="flex min-w-0 flex-1 flex-col gap-s1">
                  <span className="flex flex-wrap items-center gap-s2">
                    <span className="t-body font-medium text-ink">{backupDate(row.created_at)}</span>
                    {row.pinned === 1 && <StatusChip>Pinned</StatusChip>}
                    {!row.present && <StatusChip tone="bad">File missing</StatusChip>}
                  </span>
                  <span className="t-small text-muted">{sizeLabel(row.size_bytes)} · schema version {row.schema_version}</span>
                </div>
                <span className="flex shrink-0 items-center gap-s1">
                  {row.present && (
                    <a className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))} href={`/api/backups/${encodeURIComponent(row.id)}/artifact`} download>Download</a>
                  )}
                  <MoreMenu
                    label={`More for the backup of ${backupDate(row.created_at)}`}
                    items={[
                      { label: row.pinned === 1 ? 'Unpin' : 'Pin', disabled: backups.pin.isPending, onSelect: () => backups.pin.mutate({ id: row.id, pinned: row.pinned !== 1 }) },
                      { label: 'Restore…', tone: 'danger', disabled: !row.present || backups.preview.isPending || backups.restore.isPending, onSelect: () => openRestore(row) },
                    ]}
                  />
                </span>
              </div>
            ))}
          </RowCard>
        )}
      {outcome !== null && (
        <Card className="flex flex-col gap-s1" data-health-restored="">
          <p className="t-body text-ink">Restored: {Object.values(outcome.tables).reduce((sum, t) => sum + t.inserted, 0).toLocaleString()} records added.</p>
          {skips.map(([table, t]) => <p key={table} className="t-small text-warn">{table.replace(/_/g, ' ')}: {t.skipped}</p>)}
        </Card>
      )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => { if (!open) { setConfirming(null); backups.restore.reset(); } }}
        title={confirming === null ? 'Restore this backup?' : `Restore the backup from ${backupDate(confirming.preview.header.createdAt)}?`}
        description="Records this server already holds stay exactly as they are; only missing records are added."
        confirmLabel="Restore"
        tone="primary"
        pending={backups.restore.isPending}
        error={backups.restore.error !== null ? failure(backups.restore.error)
          : adoptAsked && !adopt ? 'Turn on the switch above to restore a backup from another Deployment.' : null}
        onConfirm={() => {
          if (confirming === null) return;
          if (confirming.preview.foreignLineage && !adopt) { setAdoptAsked(true); return; }
          backups.restore.mutate({ id: confirming.row.id, allowForeignLineage: adopt }, { onSuccess: (result) => { setOutcome(result); setConfirming(null); } });
        }}
      >
        {confirming !== null && (
          <>
            <p className="t-small text-muted" data-restore-counts="">It holds {countsWords(confirming.preview.header.counts)}</p>
            {confirming.preview.foreignLineage && (
              <div className="flex items-start gap-s3 rounded-control bg-warn-bg p-s3">
                <Switch id="restore-adopt" checked={adopt} onCheckedChange={setAdopt} />
                <label htmlFor="restore-adopt" className="t-small text-ink">
                  This backup comes from another Deployment. Restoring it makes that Deployment’s members, and their sign-in credentials, live here.
                </label>
              </div>
            )}
          </>
        )}
      </ConfirmDialog>
      <RecoveryCard />
    </AdminSection>
  );
}

/**
 * Automatic recovery, as the owner reads it: whether it is set up, when the
 * next attempt is due, what the last one did, and what data exists. Read only,
 * but for forgetting an export that never settled.
 */
function RecoveryCard() {
  const recovery = useRecovery();
  // Read at each render: a deadline is weighed against the clock when the answer arrives, not when the page opened.
  const now = Date.now();
  const held = recovery.data?.schedule ?? null;
  const schedule = held !== null && 'unreadable' in held ? null : held;
  const unreadable = held !== null && 'unreadable' in held ? held.unreadable : null;
  // The producer's answer stands on its own: an unreadable schedule hides the cadence, not the attempt.
  const attempt = recovery.data?.attempt ?? null;
  const stage = recovery.data?.stage ?? null;
  const form = recovery.data?.form ?? 'staging';
  return (
    <Card className="flex flex-col gap-s3" data-health-recovery="">
      <h3 className="t-h3 text-ink">Automatic recovery</h3>
      {recovery.isPending && <LoadingState label="Reading automatic recovery" count={1} />}
      {recovery.error !== null && unsupported(recovery.error) && (
        <p className="t-body text-muted" data-testid="recovery-unavailable">This Deployment runs no hosted recovery producer, so automatic recovery cannot run here.</p>
      )}
      {recovery.error !== null && !unsupported(recovery.error) && (
        <p className="t-body text-warn" data-testid="recovery-unreadable">Automatic recovery could not be read: {recovery.error.message}</p>
      )}
      {unreadable !== null && (
        <>
          <p className="t-body text-warn" data-testid="recovery-unreadable">{unreadable}</p>
          <p className="t-body text-muted" data-testid="recovery-latest">{attemptWords(attempt, stage, form)}</p>
        </>
      )}
      {recovery.data?.error === 'export_unsettled' && <ForgetUnsettledExport forgettableAt={recovery.data.unsettledExport?.forgettableAt ?? null} now={now} />}
      {schedule !== null && (
        <>
          <p className="t-body text-ink" data-testid="recovery-cadence">{cadenceWords(schedule, now)}</p>
          <p className="t-body text-muted" data-testid="recovery-latest">{latestWords(schedule, form)}</p>
          <p className={cn('t-body', schedule.available.state === 'staged' ? 'text-warn' : 'text-muted')} data-testid="recovery-available">
            {availableWords(schedule.available)}
          </p>
          <p className="max-w-measure t-small text-muted">
            How often it runs is “Back up every” in <Link to={BACKUP_SETTINGS}>Settings</Link>.
            {form === 'artifact'
              ? ' Restoring from an artifact is an operator command: see the '
              : ' Turning a staging into a verified artifact, and restoring from one, are operator commands: see the '}
            <ExternalLink href={RECOVERY_PROCEDURE}>recovery procedure</ExternalLink>.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * The way out of an export that never settles: every later attempt waits on
 * it and fails. Once the provider has said nothing of it for long enough to
 * take it as ended, an admin may have it forgotten, behind a confirm; until
 * then the page says when.
 */
function ForgetUnsettledExport({ forgettableAt, now }: { forgettableAt: number | null; now: number }) {
  const forget = useForgetUnsettledExport();
  const [confirming, setConfirming] = useState(false);
  const early = forgettableAt !== null && forgettableAt > now;
  const words = forget.data !== undefined
    ? (forget.data.forgotten === null ? 'No earlier export was recorded; the next attempt starts its own.' : `The export attempt ${forget.data.forgotten.attempt} requested is forgotten; the next attempt starts its own.`)
    : null;
  return (
    <div className="flex flex-col gap-s2 rounded-control bg-warn-bg p-s3" data-testid="recovery-unsettled">
      <div className="flex items-start justify-between gap-s3">
        <p className="t-small text-ink">
          The last attempt stopped because an export an earlier attempt started never said it ended, and every attempt waits on it.
          {early
            ? ` It was reported running too recently to be taken as ended; it can be forgotten ${whenLabel(forgettableAt!, now)}.`
            : ' Nothing has been heard of it for long enough to take it as ended: forget it so the next attempt starts its own.'}
        </p>
        <MoreMenu
          label="More for automatic recovery"
          items={[{ label: 'Forget the earlier export', tone: 'danger', disabled: early || forget.isPending, onSelect: () => { forget.reset(); setConfirming(true); } }]}
        />
      </div>
      {words !== null && <p className="t-small text-muted">{words}</p>}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Forget the earlier export?"
        description="Only do this if that export is no longer running. The next attempt then starts an export of its own."
        confirmLabel="Forget it"
        pending={forget.isPending}
        error={forget.error === null ? null : `It was not forgotten: ${forget.error.message}`}
        onConfirm={() => forget.mutate(undefined, { onSuccess: () => setConfirming(false) })}
      />
    </div>
  );
}
