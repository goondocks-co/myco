import { useEffect, useState } from 'react';
import { HardDrive, Clock, File as FileIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { fetchJson } from '../../lib/api';
import { formatBytes } from '../../lib/format';

interface BackupMeta {
  machine_id: string;
  file_name: string;
  size_bytes: number;
  modified_at: string;
}
interface BackupListResponse {
  backups: BackupMeta[];
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function GroveBackupSnapshot() {
  const [backups, setBackups] = useState<BackupMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<BackupListResponse>('/backups')
      .then((res) => setBackups(res.backups))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load backups'));
  }, []);

  const last = backups && backups.length > 0 ? backups[0] : null;
  const recent = backups ? backups.slice(1, 5) : [];

  return (
    <Surface level="low" className="rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-primary" />
          <SectionHeader>Backup</SectionHeader>
        </div>
        <Link to="/settings#backup" className="text-xs text-primary hover:text-primary/80">
          Backup settings →
        </Link>
      </div>
      {error ? (
        <p className="text-sm text-tertiary">{error}</p>
      ) : !backups ? (
        <p className="text-sm text-on-surface-variant">Loading…</p>
      ) : last === null ? (
        <p className="text-sm text-on-surface-variant">No backups yet.</p>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="flex items-center gap-2 text-sm text-on-surface">
              <FileIcon className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />
              <code className="font-mono truncate">{last.file_name}</code>
            </div>
            <div className="mt-1 flex gap-x-3 text-xs text-on-surface-variant">
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />{formatRelative(last.modified_at)}
              </span>
              <span>·</span>
              <span>{formatBytes(last.size_bytes)}</span>
            </div>
          </div>
          {recent.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-on-surface-variant">Recent</div>
              <ul className="mt-1 space-y-0.5">
                {recent.map((b) => (
                  <li key={b.file_name} className="flex justify-between text-xs text-on-surface-variant">
                    <span>{formatRelative(b.modified_at)}</span>
                    <span>{formatBytes(b.size_bytes)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Surface>
  );
}
