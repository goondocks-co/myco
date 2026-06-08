import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Upload, Loader2, CheckCircle2, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { fetchJson } from '../../lib/api';
import { errorMessage } from '../../lib/error';
import { formatBytes } from '../../lib/format';
import { cn } from '../../lib/cn';
import {
  type BackupMeta,
  formatBackupDate,
  groupBackupsByDay,
  backupDayLabel,
} from './backup-format';

/* ---------- Wire types ---------- */

interface TableContentCounts {
  table: string;
  in_backup: number;
  in_db: number;
}

interface RestorePreviewResponse {
  machine_id: string;
  tables: TableContentCounts[];
  total_in_backup: number;
  total_in_db: number;
}

interface RestoreStartResponse {
  job_id: string;
  status: string;
  file_name: string;
}

interface RestoreResult {
  total_restored: number;
  total_skipped: number;
}

interface RestoreJobResponse {
  job_id: string;
  status: 'running' | 'done' | 'error';
  result: RestoreResult | null;
  error: string | null;
}

/* ---------- Props ---------- */

export interface RestoreBackupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  backups: BackupMeta[];
  groveId: string | null;
  /** Per-request tenancy headers (same selection the rest of the card uses). */
  headers: Record<string, string> | undefined;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'restoring' }
  | { kind: 'done'; result: RestoreResult }
  | { kind: 'error'; message: string };

export function RestoreBackupDialog({ open, onOpenChange, backups, groveId, headers }: RestoreBackupDialogProps) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<BackupMeta | null>(null);
  const [preview, setPreview] = useState<RestorePreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  // Reset the flow whenever the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setSelected(null);
      setPreview(null);
      setPreviewError(null);
      setPhase({ kind: 'idle' });
    }
  }, [open]);

  async function selectBackup(backup: BackupMeta) {
    setSelected(backup);
    setPreview(null);
    setPreviewError(null);
    setPhase({ kind: 'idle' });
    try {
      const res = await fetchJson<RestorePreviewResponse>('/restore/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({ file_name: backup.file_name }),
      });
      setPreview(res);
    } catch (err) {
      setPreviewError(errorMessage(err));
    }
  }

  async function pollRestore(jobId: string): Promise<RestoreJobResponse> {
    const deadlineMs = Date.now() + 30 * 60_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const job = await fetchJson<RestoreJobResponse>(
        `/restore/status?job_id=${encodeURIComponent(jobId)}`,
        { headers },
      );
      if (job.status !== 'running') return job;
      if (Date.now() > deadlineMs) {
        return { ...job, status: 'error', error: 'Restore is taking unusually long; check the server logs.' };
      }
    }
  }

  async function runRestore() {
    if (!selected) return;
    setPhase({ kind: 'restoring' });
    try {
      const start = await fetchJson<RestoreStartResponse>('/restore', {
        method: 'POST',
        headers,
        body: JSON.stringify({ file_name: selected.file_name }),
      });
      const job = await pollRestore(start.job_id);
      if (job.status === 'done' && job.result) {
        setPhase({ kind: 'done', result: job.result });
        await queryClient.invalidateQueries({ queryKey: ['backups', groveId] });
      } else {
        setPhase({ kind: 'error', message: job.error ?? 'unknown error' });
      }
    } catch (err) {
      setPhase({ kind: 'error', message: errorMessage(err) });
    }
  }

  const restoring = phase.kind === 'restoring';

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!restoring) onOpenChange(next); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Restore from backup</DialogTitle>
          <DialogDescription>
            {selected
              ? 'Review what this backup holds, then restore. Restore merges records (existing rows are kept) and never deletes.'
              : 'Pick a backup to restore. You’ll see its contents before anything happens.'}
          </DialogDescription>
        </DialogHeader>

        {selected ? (
          <DetailView
            backup={selected}
            preview={preview}
            previewError={previewError}
            phase={phase}
            onBack={() => { setSelected(null); setPreview(null); setPreviewError(null); setPhase({ kind: 'idle' }); }}
            onRestore={runRestore}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <ListView backups={backups} onSelect={selectBackup} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ---------- List view ---------- */

function ListView({ backups, onSelect }: { backups: BackupMeta[]; onSelect: (b: BackupMeta) => void }) {
  if (backups.length === 0) {
    return <p className="font-sans text-sm text-on-surface-variant">No backups available yet.</p>;
  }
  return (
    <div className="max-h-[55vh] overflow-y-auto pr-1 space-y-4">
      {Array.from(groupBackupsByDay(backups).entries()).map(([day, group]) => (
        <div key={day} className="space-y-2">
          <p className="font-sans text-[11px] uppercase tracking-wider text-on-surface-variant sticky top-0 bg-surface-container-highest py-1">
            {backupDayLabel(day)}
          </p>
          {group.map((b) => (
            <button
              key={b.file_name}
              type="button"
              onClick={() => onSelect(b)}
              className={cn(
                'w-full flex items-center justify-between rounded-md px-4 py-3 text-left',
                'bg-surface-container-lowest hover:bg-surface-container-low transition-colors',
              )}
            >
              <span className="flex items-center gap-3 min-w-0">
                <span className="font-mono text-sm text-on-surface">{formatBackupDate(b.modified_at)}</span>
                <Badge variant="secondary">{formatBytes(b.size_bytes)}</Badge>
                <span className="font-mono text-xs text-on-surface-variant truncate">{b.machine_id}</span>
              </span>
              <ChevronRight className="h-4 w-4 text-on-surface-variant shrink-0" />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---------- Detail view ---------- */

function DetailView({
  backup,
  preview,
  previewError,
  phase,
  onBack,
  onRestore,
  onClose,
}: {
  backup: BackupMeta;
  preview: RestorePreviewResponse | null;
  previewError: string | null;
  phase: Phase;
  onBack: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const restoring = phase.kind === 'restoring';
  const done = phase.kind === 'done';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          disabled={restoring}
          className="inline-flex items-center gap-1.5 font-sans text-sm text-on-surface-variant hover:text-on-surface disabled:opacity-50"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> All backups
        </button>
        <span className="flex items-center gap-2">
          <span className="font-mono text-sm text-on-surface">{formatBackupDate(backup.modified_at)}</span>
          <Badge variant="secondary">{formatBytes(backup.size_bytes)}</Badge>
        </span>
      </div>

      {/* Contents */}
      <div className="rounded-md bg-surface-container-lowest p-4">
        <p className="font-sans font-medium text-xs uppercase tracking-widest text-on-surface-variant mb-2">
          Backup contents
        </p>
        {previewError ? (
          <p className="font-sans text-sm text-tertiary">Could not read contents: {previewError}</p>
        ) : !preview ? (
          <p className="flex items-center gap-2 font-sans text-sm text-on-surface-variant">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading backup contents…
          </p>
        ) : (
          <div className="max-h-[34vh] overflow-y-auto">
            <table className="w-full font-mono text-sm" aria-label="Backup contents">
              <thead className="sticky top-0 bg-surface-container-lowest">
                <tr className="text-left text-on-surface-variant">
                  <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest" scope="col">Table</th>
                  <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest text-right" scope="col">In backup</th>
                  <th className="pb-2 font-sans font-medium text-xs uppercase tracking-widest text-right" scope="col">In database</th>
                </tr>
              </thead>
              <tbody>
                {preview.tables.map((t, idx) => (
                  <tr key={t.table} className={cn(idx % 2 === 1 ? 'bg-surface-container-low/30' : '')}>
                    <td className="py-1.5 pr-4">{t.table}</td>
                    <td className="py-1.5 pr-4 text-right text-primary">{t.in_backup}</td>
                    <td className="py-1.5 text-right text-on-surface-variant">{t.in_db}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Status + action */}
      {phase.kind === 'error' && (
        <p className="font-sans text-sm text-tertiary">Restore failed: {phase.message}</p>
      )}
      {restoring && (
        <p className="flex items-center gap-2 font-sans text-sm text-primary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Restoring… this runs in the background and can take a minute on a large backup. You can keep using Myco.
        </p>
      )}
      {done && (
        <p className="flex items-center gap-2 font-sans text-sm text-primary">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Restored {phase.result.total_restored} records, skipped {phase.result.total_skipped} already present.
        </p>
      )}

      <div className="flex justify-end gap-2">
        {done ? (
          <Button variant="default" size="sm" onClick={onClose}>Done</Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={onRestore} disabled={restoring || !!previewError}>
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            {restoring ? 'Restoring…' : 'Restore this backup'}
          </Button>
        )}
      </div>
    </div>
  );
}
