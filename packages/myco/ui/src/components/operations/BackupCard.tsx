import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CONFIG_SECTION_IDS } from '@myco/config/focus';
import { HardDrive, Download, Upload, RefreshCw, FolderOpen } from 'lucide-react';
import { fetchJson } from '../../lib/api';
import { errorMessage } from '../../lib/error';
import { formatBytes } from '../../lib/format';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';
import { ScopedField } from '../config/ScopedField';
import { OperationsScopePill, type OperationsScope } from './OperationsScopePill';

const BACKUP_SCOPE_AVAILABLE: ReadonlyArray<OperationsScope> = ['grove', 'all-groves'];
import { buildActionScope } from './scope-helpers';
import { useActiveProjectSelection } from '../../hooks/use-project-selection';
import { requestContextHeadersForSelection } from '../../lib/selection';
import { ActionConfirmDialog, actionRequiresConfirmation } from './ActionConfirmDialog';
import { RestoreBackupDialog } from './RestoreBackupDialog';
import { type BackupMeta, formatBackupDate } from './backup-format';

/* ---------- Types ---------- */

interface BackupListResponse {
  backups: BackupMeta[];
}

interface BackupCreateResponse {
  file_path: string;
  machine_id: string;
  size_bytes: number;
}

interface BackupAllResponse {
  scope: { kind: string };
  results: Array<{ grove_id: string; grove_slug: string; ok: boolean; size_bytes?: number; error?: string }>;
  summary: { ok: number; failed: number };
}

/* ---------- BackupCard ---------- */

export interface BackupCardProps {
  /**
   * When true, hide the Surface wrapper, the section header, the scope pill,
   * and the duplicate `backup.dir` ScopedField — the embedding Settings
   * Surface already provides those.
   */
  embedded?: boolean;
}

const RECENT_SHOWN = 3;

export function BackupCard({ embedded = false }: BackupCardProps = {}) {
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Backup operates on a per-Grove SQLite file — no project-narrowed dump
  // path — so the pill defaults to Grove and excludes the project option.
  const [pillScope, setPillScope] = useState<OperationsScope>('grove');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Read AND write resolve the target Grove from one selection, sent
  // explicitly on every request (keyed query also defers the first fetch
  // until a Grove is resolved).
  const selection = useActiveProjectSelection();
  const groveId = selection?.grove.id ?? null;
  const ctxHeaders = selection ? requestContextHeadersForSelection(selection) : undefined;

  const backupsQuery = useQuery({
    queryKey: ['backups', groveId],
    queryFn: () => fetchJson<BackupListResponse>('/backups', { headers: ctxHeaders }),
    enabled: !!groveId,
  });
  const backups = backupsQuery.data?.backups ?? [];
  const loaded = !!groveId && (backupsQuery.isSuccess || backupsQuery.isError);
  const recent = backups.slice(0, RECENT_SHOWN);
  const oldest = backups.length > 0 ? backups[backups.length - 1] : null;

  async function doCreateBackup() {
    setBusy(true);
    setMessage(null);
    try {
      const wireScope = buildActionScope(pillScope, selection);
      const res = await fetchJson<BackupCreateResponse & Partial<BackupAllResponse>>('/backup', {
        method: 'POST',
        headers: ctxHeaders,
        body: JSON.stringify({ scope: wireScope }),
      });
      if (res.summary) {
        setMessage({
          type: res.summary.failed > 0 ? 'error' : 'success',
          text: `Backed up ${res.summary.ok} Grove(s); ${res.summary.failed} failed`,
        });
      } else {
        setMessage({ type: 'success', text: `Backup created (${formatBytes(res.size_bytes)})` });
      }
      await backupsQuery.refetch();
    } catch (err) {
      setMessage({ type: 'error', text: `Backup failed: ${errorMessage(err)}` });
    } finally {
      setBusy(false);
    }
  }

  function handleCreateBackup() {
    const wireScope = buildActionScope(pillScope, selection);
    if (wireScope && actionRequiresConfirmation('backup', wireScope)) {
      setConfirmOpen(true);
      return;
    }
    void doCreateBackup();
  }

  const listError = backupsQuery.isError ? `Failed to load backups: ${errorMessage(backupsQuery.error)}` : null;

  const actions = (
    <div className="flex gap-2">
      <Button variant="ghost" size="sm" onClick={() => backupsQuery.refetch()}>
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
        Refresh
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setRestoreOpen(true)}
        disabled={backups.length === 0}
      >
        <Upload className="mr-1.5 h-3.5 w-3.5" />
        Restore…
      </Button>
      <Button variant="default" size="sm" onClick={handleCreateBackup} disabled={busy}>
        <Download className="mr-1.5 h-3.5 w-3.5" />
        Backup Now
      </Button>
    </div>
  );

  const body = (
    <>
      {!embedded ? (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HardDrive className="h-4 w-4 text-primary" />
            <SectionHeader>Backup &amp; Restore</SectionHeader>
            <OperationsScopePill value={pillScope} onChange={setPillScope} available={BACKUP_SCOPE_AVAILABLE} />
          </div>
          {actions}
        </div>
      ) : (
        <div className="flex items-center justify-end">{actions}</div>
      )}

      <ActionConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        action="Create backup"
        scope={buildActionScope(pillScope, selection) ?? { kind: 'all-groves' }}
        isPending={busy}
        onConfirm={async () => {
          await doCreateBackup();
          setConfirmOpen(false);
        }}
      />

      <RestoreBackupDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        backups={backups}
        groveId={groveId}
        headers={ctxHeaders}
      />

      {!embedded && (
        <ScopedField
          path="backup.dir"
          label="Backup Directory"
          commitOn="blur"
          requiresRestart
          hint="leave blank for default .myco/backups; ~ supported"
          parse={(v) => (v === '' ? (undefined as unknown as string) : v)}
        >
          {({ value, onChange, onBlur }) => (
            <div className="flex items-center gap-2">
              <FolderOpen className="h-3.5 w-3.5 text-on-surface-variant shrink-0" />
              <input
                type="text"
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value)}
                onBlur={onBlur}
                placeholder=".myco/backups"
                className="flex-1 bg-surface-container text-on-surface font-mono text-sm rounded px-3 py-1.5 outline-hidden border border-outline-variant/15 focus:border-primary/40 placeholder:text-on-surface-variant/50"
              />
            </div>
          )}
        </ScopedField>
      )}

      {(message || listError) && (
        <p className={cn('font-sans text-sm', message?.type === 'success' ? 'text-primary' : 'text-tertiary')}>
          {message?.text ?? listError}
        </p>
      )}

      {/* Status — prove backups exist without dumping the whole list. The
          full history lives in the Restore… flow. */}
      {backups.length > 0 ? (
        <div className="space-y-2">
          {recent.map((b, idx) => (
            <div
              key={b.file_name}
              className="flex items-center justify-between rounded-md bg-surface-container-lowest px-4 py-2.5"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-mono text-sm text-on-surface">{formatBackupDate(b.modified_at)}</span>
                {idx === 0 && <Badge variant="outline">Latest</Badge>}
                <Badge variant="secondary">{formatBytes(b.size_bytes)}</Badge>
                <span className="font-mono text-xs text-on-surface-variant truncate">{b.machine_id}</span>
              </div>
            </div>
          ))}
          <p className="font-sans text-xs text-on-surface-variant">
            {backups.length} backup{backups.length === 1 ? '' : 's'} kept
            {oldest ? ` · oldest ${formatBackupDate(oldest.modified_at)}` : ''}
            {' · '}
            <button
              type="button"
              onClick={() => setRestoreOpen(true)}
              className="text-primary hover:underline"
            >
              browse &amp; restore
            </button>
          </p>
        </div>
      ) : loaded && !listError ? (
        <p className="font-sans text-sm text-on-surface-variant">
          No backups yet. Click &quot;Backup Now&quot; to create one.
        </p>
      ) : null}
    </>
  );

  if (embedded) {
    return <div className="space-y-4">{body}</div>;
  }
  return (
    <Surface
      id={CONFIG_SECTION_IDS.operationsBackup}
      level="low"
      className="rounded-lg p-6 space-y-4 transition-all duration-300"
    >
      {body}
    </Surface>
  );
}
