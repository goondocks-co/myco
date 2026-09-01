import { useState } from 'react';
import { Panel } from '../ui/panel';
import { useBackups, type BackupRow, type RestoreOutcome, type RestorePreview } from '../../hooks/use-backups';

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50';

const sizeLabel = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const dateLabel = (ms: number): string => new Date(ms).toLocaleString();

/**
 * The Deployment's backups: create, pin, and a preview-confirmed restore. The
 * artifact carries relational rows alone — object-store bytes and the
 * operator-entered settings and secrets stay outside it, and this panel says so.
 */
export function BackupPanel() {
  const backups = useBackups();
  const [confirming, setConfirming] = useState<{ row: BackupRow; preview: RestorePreview } | null>(null);
  const [adopt, setAdopt] = useState(false);
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const rows = backups.list.data?.backups ?? [];
  const openConfirm = async (row: BackupRow) => {
    setPreviewError(null);
    setOutcome(null);
    try {
      setConfirming({ row, preview: await backups.preview(row.id) });
      setAdopt(false);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    }
  };
  const runRestore = () => {
    if (confirming === null) return;
    backups.restore.mutate(
      { id: confirming.row.id, allowForeignLineage: adopt },
      { onSuccess: (result) => { setOutcome(result); setConfirming(null); } },
    );
  };
  const skips = outcome === null ? [] : Object.entries(outcome.tables).filter(([, t]) => t.skipped !== undefined);
  const actionError = backups.create.error ?? backups.restore.error ?? backups.pin.error;

  return (
    <Panel
      title="Backup"
      eyebrow="Server"
      actions={(
        <button type="button" className={button} disabled={backups.create.isPending} onClick={() => backups.create.mutate()}>
          {backups.create.isPending ? 'Backing up…' : 'Create backup'}
        </button>
      )}
    >
      <p className="mb-3 font-sans text-xs text-on-surface-variant">
        A backup holds this server's records. Attachment and transcript bytes stay in the object store,
        and settings and secrets are re-entered on Settings after restoring onto a fresh deployment.
      </p>
      {backups.list.isPending && <p className="font-sans text-sm text-on-surface-variant">Loading…</p>}
      {backups.list.error !== null && <p className="font-sans text-sm text-terra">Backups could not be listed.</p>}
      {!backups.list.isPending && rows.length === 0 && backups.list.error === null && (
        <p className="font-sans text-sm text-on-surface-variant">No backups yet. The first one is a click away.</p>
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 rounded-md border border-outline-variant/30 px-3 py-2">
              <span className="font-sans text-sm text-on-surface">{dateLabel(row.created_at)}</span>
              <span className="font-mono text-xs text-on-surface-variant">{sizeLabel(row.size_bytes)} · schema v{row.schema_version}</span>
              {row.pinned === 1 && <span className="rounded bg-surface-container-high px-1.5 py-0.5 font-sans text-xs text-ochre">pinned</span>}
              {!row.present && <span className="rounded bg-surface-container-high px-1.5 py-0.5 font-sans text-xs text-terra">artifact missing</span>}
              <span className="grow" />
              <button type="button" className={button} disabled={backups.pin.isPending}
                onClick={() => backups.pin.mutate({ id: row.id, pinned: row.pinned !== 1 })}>
                {row.pinned === 1 ? 'Unpin' : 'Pin'}
              </button>
              {row.present && <a className={button} href={`/api/backups/${row.id}/artifact`} download>Download</a>}
              <button type="button" className={button} disabled={!row.present || backups.restore.isPending} onClick={() => { void openConfirm(row); }}>
                Restore…
              </button>
            </li>
          ))}
        </ul>
      )}
      {previewError !== null && <p className="mt-2 font-sans text-sm text-terra">{previewError}</p>}
      {actionError !== null && <p className="mt-2 font-sans text-sm text-terra">{actionError.message}</p>}
      {confirming !== null && (
        <div className="mt-3 rounded-md border border-outline-variant/50 bg-surface-container-low p-3">
          <p className="font-sans text-sm text-on-surface">
            Restore the backup from {dateLabel(confirming.preview.header.createdAt)}? Rows this server already
            holds stay exactly as they are; only missing rows are added.
          </p>
          <p className="mt-1 font-mono text-xs text-on-surface-variant">
            {Object.entries(confirming.preview.header.counts).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(' · ')}
          </p>
          {confirming.preview.foreignLineage && (
            <label className="mt-2 flex items-center gap-2 font-sans text-sm text-ochre">
              <input type="checkbox" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} />
              This backup names another deployment. Restoring it makes that deployment's members — and their sign-in credentials — live here.
            </label>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" className={button} disabled={backups.restore.isPending || (confirming.preview.foreignLineage && !adopt)} onClick={runRestore}>
              {backups.restore.isPending ? 'Restoring…' : 'Confirm restore'}
            </button>
            <button type="button" className={button} onClick={() => setConfirming(null)}>Cancel</button>
          </div>
        </div>
      )}
      {outcome !== null && (
        <div className="mt-3 rounded-md border border-outline-variant/50 p-3">
          <p className="font-sans text-sm text-on-surface">
            Restored: {Object.values(outcome.tables).reduce((sum, t) => sum + t.inserted, 0)} rows added.
          </p>
          {skips.map(([table, t]) => (
            <p key={table} className="mt-1 font-sans text-xs text-ochre">{table}: {t.skipped}</p>
          ))}
        </div>
      )}
    </Panel>
  );
}
