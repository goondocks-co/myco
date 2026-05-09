import { Database, AlertCircle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';
import { formatBytes, formatTimeAgo } from '../../lib/format';
import {
  useMaintenanceSummary,
  type GroveMaintenanceSummary,
  type MaintenanceSummary,
} from '../../hooks/use-maintenance-summary';
import { OperationsCard, OperationsRow } from './OperationsCard';

function isOverdue(iso: string | null, hours: number): boolean {
  if (!iso) return true;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return true;
  return Date.now() - ms > hours * 60 * 60 * 1000;
}

function flagSummary(
  summary: MaintenanceSummary,
): { label: string; icon: typeof CheckCircle2; tone: 'ok' | 'warn' | 'error' } {
  const { flags } = summary;
  if (flags.error_count > 0 || flags.integrity_issues > 0) {
    return { label: 'Issues detected', icon: ShieldAlert, tone: 'error' };
  }
  if (flags.backup_overdue > 0 || flags.optimize_overdue > 0) {
    return { label: 'Maintenance overdue', icon: AlertCircle, tone: 'warn' };
  }
  return { label: 'All Groves healthy', icon: CheckCircle2, tone: 'ok' };
}

function GroveRow({ row, thresholds }: {
  row: GroveMaintenanceSummary;
  thresholds: MaintenanceSummary['thresholds'];
}) {
  const backupOverdue = !row.error && isOverdue(row.last_backup_at, thresholds.backup_overdue_hours);
  const optimizeOverdue = !row.error && isOverdue(row.last_optimize_at, thresholds.optimize_overdue_hours);
  const integrityIssues = row.last_integrity_check?.status === 'issues';

  return (
    <OperationsRow
      primary={
        <>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-on-surface truncate">{row.grove.name}</span>
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] uppercase">
              {row.grove.mode}
            </Badge>
            {row.error && (
              <Badge variant="outline" className="border-tertiary px-1.5 py-0 text-[10px] uppercase text-tertiary">
                error
              </Badge>
            )}
          </div>
          {row.error ? (
            <p className="font-sans text-xs text-tertiary truncate" title={row.error}>
              {row.error}
            </p>
          ) : (
            <p className="font-sans text-xs text-on-surface-variant">
              {row.project_count} project{row.project_count === 1 ? '' : 's'}
              {' · '}
              {formatBytes(row.db_size_bytes)}
              {row.embedding_pending === null ? (
                <> · <span className="text-tertiary">embedding signal unavailable</span></>
              ) : row.embedding_pending > 0 ? (
                <> · <span className="text-secondary">{row.embedding_pending} pending</span></>
              ) : null}
            </p>
          )}
        </>
      }
      meta={
        <>
          <span className={cn('text-on-surface-variant', backupOverdue && 'text-secondary')}>
            backup: {row.last_backup_at ? formatTimeAgo(row.last_backup_at) : 'never'}
          </span>
          <span className={cn('text-on-surface-variant', optimizeOverdue && 'text-secondary')}>
            optimize: {row.last_optimize_at ? formatTimeAgo(row.last_optimize_at) : 'never'}
          </span>
          <span className={cn(
            'text-on-surface-variant',
            integrityIssues && 'text-tertiary',
          )}>
            integrity:{' '}
            {row.last_integrity_check
              ? `${row.last_integrity_check.status} · ${formatTimeAgo(row.last_integrity_check.at)}`
              : 'never'}
          </span>
        </>
      }
    />
  );
}

export function GrovesOverviewCard() {
  const { data, isLoading, isError, error } = useMaintenanceSummary();
  const errorObj = isError ? (error instanceof Error ? error : new Error('unknown error')) : null;

  const status = data ? flagSummary(data) : null;
  const StatusIcon = status?.icon;

  return (
    <OperationsCard
      title="Groves Overview"
      scope="all-groves"
      loading={isLoading}
      error={errorObj}
      empty={!!data && data.groves.length === 0}
      emptyText="No Groves are registered yet."
      meta={
        status && StatusIcon && (
          <div className={cn(
            'flex items-center gap-1.5 font-sans text-xs',
            status.tone === 'ok' && 'text-primary',
            status.tone === 'warn' && 'text-secondary',
            status.tone === 'error' && 'text-tertiary',
          )}>
            <StatusIcon className="h-3.5 w-3.5" />
            {status.label}
          </div>
        )
      }
    >
      {data && (
        <>
          <div className="flex flex-wrap gap-4 font-sans text-xs">
            <span className="flex items-center gap-1.5">
              <Database className="h-3.5 w-3.5 text-on-surface-variant" />
              <span className="text-on-surface-variant">Groves</span>
              <span className="font-mono text-on-surface">{data.groves.length}</span>
            </span>
            {data.flags.backup_overdue > 0 && (
              <span className="text-secondary">
                {data.flags.backup_overdue} backup overdue
              </span>
            )}
            {data.flags.optimize_overdue > 0 && (
              <span className="text-secondary">
                {data.flags.optimize_overdue} optimize overdue
              </span>
            )}
            {data.flags.integrity_issues > 0 && (
              <span className="text-tertiary">
                {data.flags.integrity_issues} integrity issue{data.flags.integrity_issues === 1 ? '' : 's'}
              </span>
            )}
          </div>

          <div className="space-y-2">
            {data.groves.map((row) => (
              <GroveRow key={row.grove.id} row={row} thresholds={data.thresholds} />
            ))}
          </div>
        </>
      )}
    </OperationsCard>
  );
}
