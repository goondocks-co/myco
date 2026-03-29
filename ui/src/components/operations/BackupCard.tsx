import { useState, useCallback, useEffect } from 'react';
import { HardDrive, Download, Upload, RefreshCw, FolderOpen } from 'lucide-react';
import { postJson, fetchJson, putJson } from '../../lib/api';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';

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

/* ---------- Constants ---------- */

const BYTES_PER_KB = 1024;

/* ---------- Helpers ---------- */

function formatBytes(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`;
  const kb = bytes / BYTES_PER_KB;
  if (kb < BYTES_PER_KB) return `${kb.toFixed(1)} KB`;
  const mb = kb / BYTES_PER_KB;
  return `${mb.toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ---------- BackupCard ---------- */

export function BackupCard() {
  const [backups, setBackups] = useState<BackupMeta[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [preview, setPreview] = useState<RestorePreviewResponse | null>(null);

  // Backup directory config
  const [dirOverride, setDirOverride] = useState('');
  const [dirSaving, setDirSaving] = useState(false);

  useEffect(() => {
    fetchJson<{ dir: string | null }>('/backup/config')
      .then((res) => {
        setDirOverride(res.dir ?? '');
      })
      .catch(() => {});
  }, []);

  const handleSaveDir = useCallback(async () => {
    setDirSaving(true);
    try {
      await putJson('/backup/config', { dir: dirOverride || null });
      setMessage({ type: 'success', text: dirOverride ? 'Backup directory updated. Restart daemon to apply.' : 'Backup directory reset to default. Restart daemon to apply.' });
    } catch {
      setMessage({ type: 'error', text: 'Failed to save backup directory.' });
    } finally {
      setDirSaving(false);
    }
  }, [dirOverride]);

  const refreshBackups = useCallback(async () => {
    try {
      const res = await fetchJson<BackupListResponse>('/backups');
      setBackups(res.backups);
      setLoaded(true);
    } catch (err) {
      setMessage({ type: 'error', text: `Failed to load backups: ${(err as Error).message}` });
    }
  }, []);

  // Load backup list on first render
  if (!loaded && !loading) {
    setLoading(true);
    refreshBackups().finally(() => setLoading(false));
  }

  async function handleCreateBackup() {
    setMessage(null);
    setPreview(null);
    try {
      const res = await postJson<BackupCreateResponse>('/backup');
      setMessage({
        type: 'success',
        text: `Backup created: ${res.machine_id} (${formatBytes(res.size_bytes)})`,
      });
      await refreshBackups();
    } catch (err) {
      setMessage({ type: 'error', text: `Backup failed: ${(err as Error).message}` });
    }
  }

  async function handlePreview(machineId: string) {
    setMessage(null);
    setPreview(null);
    try {
      const res = await postJson<RestorePreviewResponse>('/restore/preview', { machine_id: machineId });
      setPreview(res);
    } catch (err) {
      setMessage({ type: 'error', text: `Preview failed: ${(err as Error).message}` });
    }
  }

  async function handleRestore(machineId: string) {
    setMessage(null);
    setPreview(null);
    try {
      const res = await postJson<RestoreResponse>('/restore', { machine_id: machineId });
      setMessage({
        type: 'success',
        text: `Restored ${res.total_restored} records, skipped ${res.total_skipped} duplicates`,
      });
    } catch (err) {
      setMessage({ type: 'error', text: `Restore failed: ${(err as Error).message}` });
    }
  }

  return (
    <Surface level="low" className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-primary" />
          <SectionHeader>Backup &amp; Restore</SectionHeader>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={refreshBackups}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button variant="default" size="sm" onClick={handleCreateBackup}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Backup Now
          </Button>
        </div>
      </div>

      {/* Backup directory */}
      <div className="space-y-1.5">
        <label className="font-sans text-xs text-on-surface-variant flex items-center gap-1.5">
          <FolderOpen className="h-3.5 w-3.5" />
          Backup Directory
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={dirOverride}
            onChange={(e) => setDirOverride(e.target.value)}
            placeholder=".myco/backups"
            className="flex-1 bg-surface-container text-on-surface font-mono text-sm rounded px-3 py-1.5 outline-none border border-outline-variant/15 focus:border-primary/40 placeholder:text-on-surface-variant/50"
          />
          <Button variant="ghost" size="sm" onClick={handleSaveDir} disabled={dirSaving}>
            {dirSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
        <p className="font-sans text-xs text-on-surface-variant">
          Override where backups are stored. Leave empty for default (.myco/backups).
          Supports ~ for home directory. Useful for network shares or git-tracked directories.
        </p>
      </div>

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

      {/* Backup list */}
      {backups.length > 0 ? (
        <div className="space-y-2">
          {backups.map((b) => (
            <div
              key={b.machine_id}
              className={cn(
                'flex items-center justify-between rounded-md px-4 py-3',
                'bg-surface-container-lowest transition-colors',
              )}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-mono text-sm text-on-surface truncate">{b.machine_id}</span>
                <Badge variant="secondary">{formatBytes(b.size_bytes)}</Badge>
                <span className="text-xs text-on-surface-variant">{formatDate(b.modified_at)}</span>
              </div>
              <div className="flex gap-2 flex-shrink-0 ml-3">
                <Button variant="ghost" size="sm" onClick={() => handlePreview(b.machine_id)}>
                  Preview
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleRestore(b.machine_id)}
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  Restore
                </Button>
              </div>
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
    </Surface>
  );
}
