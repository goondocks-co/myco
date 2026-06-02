import { useState, useCallback } from 'react';
import { CONFIG_SECTION_IDS } from '@myco/config/focus';
import { HardDrive, Download, Upload, RefreshCw, FolderOpen } from 'lucide-react';
import { postJson, fetchJson } from '../../lib/api';
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
import { useProjectSelection } from '../../hooks/use-project-selection';
import { ActionConfirmDialog, actionRequiresConfirmation } from './ActionConfirmDialog';

/* ---------- Types ---------- */

interface BackupMeta {
  machine_id: string;
  file_name: string;
  size_bytes: number;
  modified_at: string;
}

interface BackupListResponse {
  backups: BackupMeta[];
}

interface BackupCreateResponse {
  file_path: string;
  machine_id: string;
  size_bytes: number;
}

interface TableCounts {
  table: string;
  new: number;
  existing: number;
}

interface RestorePreviewResponse {
  machine_id: string;
  tables: TableCounts[];
  total_new: number;
  total_existing: number;
}

interface RestoreResponse {
  machine_id: string;
  tables: TableCounts[];
  total_restored: number;
  total_skipped: number;
}

/* ---------- Helpers ---------- */

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Group backup history by ISO date so the user sees a Files-style
 * "today / yesterday / older" sectioning rather than a flat list of
 * 14+ daily entries followed by 8 weeklies. Sorting + ordering done
 * server-side; this just buckets for visual scanning.
 */
function groupByDay(backups: BackupMeta[]): Map<string, BackupMeta[]> {
  const out = new Map<string, BackupMeta[]>();
  for (const b of backups) {
    const day = new Date(b.modified_at).toISOString().slice(0, 10);
    const arr = out.get(day) ?? [];
    arr.push(b);
    out.set(day, arr);
  }
  return out;
}

function dayLabel(isoDay: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const d = new Date(isoDay);
  const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
  if (isoDay === today) return 'Today';
  if (isoDay === yesterday) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

/* ---------- BackupCard ---------- */

interface BackupAllResponse {
  scope: { kind: string };
  results: Array<{ grove_id: string; grove_slug: string; ok: boolean; size_bytes?: number; error?: string }>;
  summary: { ok: number; failed: number };
}

export interface BackupCardProps {
  /**
   * When true, hide the Surface wrapper, the section header,
   * the scope pill, and the duplicate `backup.dir` ScopedField —
   * those duplicates the embedding parent already provides. The
   * Settings page passes `embedded` so its Backups Surface owns
   * the header + dir field, and BackupCard contributes only the
   * action buttons + list + preview/restore.
   */
  embedded?: boolean;
}

export function BackupCard({ embedded = false }: BackupCardProps = {}) {
  const [backups, setBackups] = useState<BackupMeta[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [preview, setPreview] = useState<RestorePreviewResponse | null>(null);
  // Backup operates on a per-Grove SQLite file — there's no
  // project-narrowed dump path. Pill defaults to Grove and excludes
  // the project option.
  const [pillScope, setPillScope] = useState<OperationsScope>('grove');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const selection = useProjectSelection();

  const refreshBackups = useCallback(async () => {
    try {
      const res = await fetchJson<BackupListResponse>('/backups');
      setBackups(res.backups);
      setLoaded(true);
    } catch (err) {
      setMessage({ type: 'error', text: `Failed to load backups: ${errorMessage(err)}` });
    }
  }, []);

  // Load backup list on first render
  if (!loaded && !loading) {
    setLoading(true);
    refreshBackups().finally(() => setLoading(false));
  }

  async function doCreateBackup() {
    setBusy(true);
    setMessage(null);
    setPreview(null);
    try {
      const wireScope = buildActionScope(pillScope, selection);
      const res = await postJson<BackupCreateResponse & Partial<BackupAllResponse>>(
        '/backup',
        { scope: wireScope },
      );
      if (res.summary) {
        setMessage({
          type: res.summary.failed > 0 ? 'error' : 'success',
          text: `Backed up ${res.summary.ok} Grove(s); ${res.summary.failed} failed`,
        });
      } else {
        setMessage({
          type: 'success',
          text: `Backup created: ${res.machine_id} (${formatBytes(res.size_bytes)})`,
        });
      }
      await refreshBackups();
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

  async function handlePreview(fileName: string) {
    setMessage(null);
    setPreview(null);
    try {
      const res = await postJson<RestorePreviewResponse>('/restore/preview', { file_name: fileName });
      setPreview(res);
    } catch (err) {
      setMessage({ type: 'error', text: `Preview failed: ${errorMessage(err)}` });
    }
  }

  async function handleRestore(fileName: string) {
    setMessage(null);
    setPreview(null);
    try {
      const res = await postJson<RestoreResponse>('/restore', { file_name: fileName });
      setMessage({
        type: 'success',
        text: `Restored ${res.total_restored} records, skipped ${res.total_skipped} duplicates`,
      });
    } catch (err) {
      setMessage({ type: 'error', text: `Restore failed: ${errorMessage(err)}` });
    }
  }

  const body = (
    <>
      {!embedded && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HardDrive className="h-4 w-4 text-primary" />
            <SectionHeader>Backup &amp; Restore</SectionHeader>
            <OperationsScopePill value={pillScope} onChange={setPillScope} available={BACKUP_SCOPE_AVAILABLE} />
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={refreshBackups}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Refresh
            </Button>
            <Button variant="default" size="sm" onClick={handleCreateBackup} disabled={busy}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Backup Now
            </Button>
          </div>
        </div>
      )}
      {embedded && (
        // Embedded mode shows the action row without the section
        // header — the parent Surface owns the header + the
        // backup.dir editor.
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={refreshBackups}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button variant="default" size="sm" onClick={handleCreateBackup} disabled={busy}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Backup Now
          </Button>
        </div>
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


      {!embedded && (
        // Standalone mode keeps the legacy backup.dir editor for
        // back-compat. Settings (`embedded`) provides its own
        // Grove-tier directory editor + retention fields.
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

      {/* Message */}
      {message && (
        <p
          className={cn(
            'font-sans text-sm',
            message.type === 'success' ? 'text-primary' : 'text-tertiary',
          )}
        >
          {message.text}
        </p>
      )}

      {/* Backup history — full list, grouped by day, newest first.
          The retention engine keeps up to `keep_daily + keep_weekly`
          files on disk; we render them all so any can be picked for
          point-in-time restore. */}
      {backups.length > 0 ? (
        <div className="space-y-4">
          {Array.from(groupByDay(backups).entries()).map(([day, group]) => (
            <div key={day} className="space-y-2">
              <p className="font-sans text-[11px] uppercase tracking-wider text-on-surface-variant">
                {dayLabel(day)}
              </p>
              {group.map((b) => (
                <div
                  key={b.file_name}
                  className={cn(
                    'flex items-center justify-between rounded-md px-4 py-3',
                    'bg-surface-container-lowest transition-colors',
                  )}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-mono text-sm text-on-surface">
                      {formatDate(b.modified_at)}
                    </span>
                    <Badge variant="secondary">{formatBytes(b.size_bytes)}</Badge>
                    <span className="font-mono text-xs text-on-surface-variant truncate">
                      {b.machine_id}
                    </span>
                  </div>
                  <div className="flex gap-2 shrink-0 ml-3">
                    <Button variant="ghost" size="sm" onClick={() => handlePreview(b.file_name)}>
                      Preview
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleRestore(b.file_name)}
                    >
                      <Upload className="mr-1.5 h-3.5 w-3.5" />
                      Restore
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : loaded ? (
        <p className="font-sans text-sm text-on-surface-variant">
          No backups yet. Click &quot;Backup Now&quot; to create one.
        </p>
      ) : null}

      {/* Restore preview */}
      {preview && (
        <Surface level="lowest" className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <SectionHeader>Restore Preview</SectionHeader>
            <Badge variant="outline">{preview.machine_id}</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-sm" aria-label="Restore preview">
              <thead>
                <tr className="text-left text-on-surface-variant">
                  <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest" scope="col">Table</th>
                  <th className="pb-2 pr-4 font-sans font-medium text-xs uppercase tracking-widest text-right" scope="col">New</th>
                  <th className="pb-2 font-sans font-medium text-xs uppercase tracking-widest text-right" scope="col">Existing</th>
                </tr>
              </thead>
              <tbody>
                {preview.tables.map((t, idx) => (
                  <tr
                    key={t.table}
                    className={cn(
                      'transition-colors hover:bg-surface-container-high/50',
                      idx % 2 === 1 ? 'bg-surface-container-low/30' : '',
                    )}
                  >
                    <td className="py-2 pr-4">{t.table}</td>
                    <td className="py-2 pr-4 text-right">
                      {t.new > 0 ? <span className="text-primary">{t.new}</span> : 0}
                    </td>
                    <td className="py-2 text-right text-on-surface-variant">{t.existing}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-4 font-sans text-sm text-on-surface-variant">
            <span>New: <strong className="text-primary">{preview.total_new}</strong></span>
            <span>Existing: <strong>{preview.total_existing}</strong></span>
          </div>
        </Surface>
      )}
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
