import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, File as FileIcon, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Panel } from '../ui/panel';
import { fetchJson } from '../../lib/api';
import { formatBytes, formatTimeAgo } from '../../lib/format';
import { useActiveProjectSelection } from '../../hooks/use-project-selection';
import { requestContextHeadersForSelection } from '../../lib/selection';

interface BackupMeta {
  machine_id: string;
  file_name: string;
  size_bytes: number;
  modified_at: string;
}
interface BackupListResponse {
  backups: BackupMeta[];
}

function backupTitle({
  error,
  isLoading,
  backups,
  last,
}: {
  error: Error | null;
  isLoading: boolean;
  backups: BackupMeta[] | null;
  last: BackupMeta | null;
}): string {
  if (error) return 'Snapshot unavailable';
  if (isLoading || !backups) return '—';
  if (last) return formatTimeAgo(last.modified_at);
  return 'No backups yet';
}

export function GroveBackupSnapshot() {
  // Resolve the Grove from the active selection and send it explicitly, so
  // the snapshot reads the same Grove the dashboard is scoped to (the list
  // endpoint now requires an explicit Grove and no longer falls back to the
  // boot Grove). Keyed on groveId so it shares the cache with BackupCard.
  const selection = useActiveProjectSelection();
  const groveId = selection?.grove.id ?? null;
  const ctxHeaders = useMemo(
    () => (selection ? requestContextHeadersForSelection(selection) : undefined),
    [selection],
  );
  const { data, error, isLoading } = useQuery<BackupListResponse, Error>({
    queryKey: ['backups', groveId],
    queryFn: ({ signal }) => fetchJson<BackupListResponse>('/backups', { signal, headers: ctxHeaders }),
    enabled: !!groveId,
  });
  const backups = data?.backups ?? null;
  const last = backups && backups.length > 0 ? backups[0] : null;
  const recent = backups ? backups.slice(1, 5) : [];

  return (
    <Panel
      tone="sage"
      eyebrow="Backup"
      title={backupTitle({ error: error ?? null, isLoading, backups, last })}
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
          Use <span className="text-on-surface">Backup Now</span> in Settings to create the first snapshot.
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
                <Clock className="h-3 w-3" />{formatTimeAgo(last.modified_at)}
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
                    <span>{formatTimeAgo(b.modified_at)}</span>
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
