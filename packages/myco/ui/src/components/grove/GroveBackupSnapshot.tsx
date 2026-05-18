import { useQuery } from '@tanstack/react-query';
import { Clock, File as FileIcon, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Panel } from '../ui/panel';
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
  const { data, error, isLoading } = useQuery<BackupListResponse, Error>({
    queryKey: ['backups'],
    queryFn: ({ signal }) => fetchJson<BackupListResponse>('/backups', { signal }),
  });
  const backups = data?.backups ?? null;
  const last = backups && backups.length > 0 ? backups[0] : null;
  const recent = backups ? backups.slice(1, 5) : [];

  const title = error
    ? 'Snapshot unavailable'
    : isLoading || !backups
      ? '—'
      : last
        ? formatRelative(last.modified_at)
        : 'No backups yet';

  return (
    <Panel
      tone="sage"
      eyebrow="Backup"
      title={title}
      actions={
        <Link
          to="/settings#backup"
          className="inline-flex items-center gap-1 text-xs font-sans text-on-surface-variant hover:text-on-surface"
        >
          Settings <ArrowRight className="h-3 w-3" />
        </Link>
      }
    >
      {error ? (
        <p className="text-sm text-terracotta m-0">{error.message}</p>
      ) : isLoading || !backups ? (
        <p className="text-sm text-on-surface-variant m-0">Loading…</p>
      ) : last === null ? (
        <p className="text-sm text-on-surface-variant m-0">
          Run <code className="font-mono">myco backup</code> to create the first snapshot.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
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
              <div className="myco-eyebrow-sm text-outline">Recent</div>
              <ul className="mt-1 m-0 p-0 list-none flex flex-col gap-0.5">
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
    </Panel>
  );
}
