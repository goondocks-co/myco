/** Shared backup list types + date grouping/formatting helpers. */

export interface BackupMeta {
  machine_id: string;
  file_name: string;
  size_bytes: number;
  modified_at: string;
}

export function formatBackupDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Group backups by ISO date so the list reads "today / yesterday / older"
 * rather than a flat run of 20+ entries. Server returns them newest-first.
 */
export function groupBackupsByDay(backups: BackupMeta[]): Map<string, BackupMeta[]> {
  const out = new Map<string, BackupMeta[]>();
  for (const b of backups) {
    const day = new Date(b.modified_at).toISOString().slice(0, 10);
    const arr = out.get(day) ?? [];
    arr.push(b);
    out.set(day, arr);
  }
  return out;
}

export function backupDayLabel(isoDay: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
  if (isoDay === today) return 'Today';
  if (isoDay === yesterday) return 'Yesterday';
  return new Date(isoDay).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}
