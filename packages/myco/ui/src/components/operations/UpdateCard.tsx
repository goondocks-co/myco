import { useState, useCallback, useEffect } from 'react';
import { ArrowUpCircle, RefreshCw, CheckCircle2, AlertCircle, Shield } from 'lucide-react';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';
import { RELEASE_CHANNELS } from '../../lib/constants';
import {
  useUpdateStatus,
  useUpdateCheck,
  useUpdateApply,
  useUpdateChannel,
} from '../../hooks/use-update-status';

/* ---------- Constants ---------- */

/** Interval for polling /health after update apply (ms). */
const HEALTH_POLL_INTERVAL_MS = 500;

/** Max time to wait for the new daemon after update apply (ms). */
const HEALTH_POLL_TIMEOUT_MS = 60_000;

/* ---------- Types ---------- */

type ApplyState = 'idle' | 'applying' | 'restarting' | 'error';

/* ---------- Helpers ---------- */

function formatLastCheck(iso: string | undefined | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function updateBadgeLabel(
  packageCount: number,
  latestVersion: string | undefined,
): string | null {
  if (packageCount <= 0) return null;
  if (packageCount === 1 && latestVersion) return latestVersion;
  return `${packageCount} packages`;
}

/* ---------- UpdateCard ---------- */

export function UpdateCard() {
  const { data: status } = useUpdateStatus();
  const checkMutation = useUpdateCheck();
  const applyMutation = useUpdateApply();
  const channelMutation = useUpdateChannel();

  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Handle server-initiated restart (version sync)
  useEffect(() => {
    if (!status?.restarting) return;
    if (applyState !== 'idle') return;

    setApplyState('restarting');

    const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
    let cancelled = false;

    const poll = async () => {
      if (cancelled || Date.now() > deadline) return;
      try {
        const res = await fetch('/health');
        if (res.ok) {
          window.location.reload();
          return;
        }
      } catch { /* daemon still down */ }
      if (!cancelled) setTimeout(poll, HEALTH_POLL_INTERVAL_MS);
    };

    const timer = setTimeout(poll, HEALTH_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status?.restarting, applyState]);

  const handleApply = useCallback(async () => {
    setApplyState('applying');
    setErrorMessage(null);
    try {
      await applyMutation.mutateAsync();
      // The daemon spawns a detached update script and SIGTERMs itself.
      // Do NOT call restart() — that sends POST /restart which races with
      // the update script and can restart the OLD version.
      // Instead, poll /health directly until the new daemon is up.
      setApplyState('restarting');
      const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
      await new Promise<void>((resolve, reject) => {
        const check = async () => {
          if (Date.now() > deadline) {
            reject(new Error('timeout'));
            return;
          }
          try {
            const res = await fetch('/health');
            if (res.ok) { resolve(); return; }
          } catch { /* daemon still down — keep polling */ }
          setTimeout(check, HEALTH_POLL_INTERVAL_MS);
        };
        // Wait a beat for the daemon to actually die before polling
        setTimeout(check, HEALTH_POLL_INTERVAL_MS);
      });
      window.location.reload();
    } catch (err) {
      setApplyState('error');
      const msg = (err as Error).message === 'timeout'
        ? 'Daemon did not restart within the expected time. Check the terminal.'
        : (err as Error).message;
      setErrorMessage(msg);
    }
  }, [applyMutation]);

  const handleCheck = useCallback(() => {
    checkMutation.mutate();
  }, [checkMutation]);

  const handleChannelToggle = useCallback(
    (channel: string) => {
      channelMutation.mutate(channel);
    },
    [channelMutation],
  );

  // State 1: no data yet
  if (!status) return null;

  const isChecking = checkMutation.isPending;
  const isApplying = applyState === 'applying' || applyState === 'restarting';
  const updateAvailable = status.update_available === true;
  const activeChannel = status.channel ?? 'stable';
  const installedPackages = (status.packages ?? []).filter((pkg) => pkg.installed);
  const pendingPackages = installedPackages.filter((pkg) => pkg.update_available);
  const pendingCount = pendingPackages.length;
  const latestBadge = updateBadgeLabel(pendingCount, pendingPackages[0]?.latest_version ?? undefined);
  const runtimeScope = status.runtime_scope ?? 'machine';
  const runtimeSummary = runtimeScope === 'project'
    ? 'This project is pinned to a project-local Myco runtime. Switching back to Stable removes the local runtime and falls back to the machine install.'
    : 'This project is using the machine-installed Myco runtime. Switching to Beta installs a project-local Myco runtime for this vault.';

  // State 2: exempt (dev mode)
  if (status.exempt) {
    return (
      <Surface level="low" className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          <SectionHeader>Updates</SectionHeader>
        </div>
        <p className="font-sans text-sm text-on-surface-variant">
          Updates are disabled in development mode.{' '}
          <span className="font-mono text-xs text-outline">{status.running_version}</span>
        </p>
      </Surface>
    );
  }

  return (
    <Surface level="low" className="p-6 space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ArrowUpCircle
            className={cn('h-4 w-4', updateAvailable ? 'text-secondary' : 'text-primary')}
          />
          <SectionHeader>Updates</SectionHeader>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-outline">{status.running_version}</span>
          {updateAvailable && latestBadge && (
            <Badge variant="warning">{latestBadge}</Badge>
          )}
        </div>
      </div>

      {/* Status row */}
      <div className="flex items-center gap-3 flex-wrap">
        {updateAvailable ? (
          <Button
            variant="default"
            size="sm"
            onClick={handleApply}
            disabled={isApplying}
          >
            {isApplying ? (
              <>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {applyState === 'restarting' ? 'Restarting…' : 'Updating…'}
              </>
            ) : (
              <>
                <ArrowUpCircle className="mr-1.5 h-3.5 w-3.5" />
                {pendingCount > 1 ? `Update ${pendingCount} Packages & Restart` : 'Update & Restart'}
              </>
            )}
          </Button>
        ) : (
          <div className="flex items-center gap-1.5 text-primary">
            <CheckCircle2 className="h-4 w-4" />
            <span className="font-sans text-sm">Up to date</span>
          </div>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={handleCheck}
          disabled={isChecking || isApplying}
        >
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', isChecking && 'animate-spin')} />
          Check Now
        </Button>
      </div>

      {/* Channel toggle row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {RELEASE_CHANNELS.map((ch) => (
            <Button
              key={ch}
              variant={activeChannel === ch ? 'default' : 'ghost'}
              className="text-xs capitalize h-6 px-2"
              onClick={() => handleChannelToggle(ch)}
              disabled={channelMutation.isPending || isApplying}
            >
              {ch}
            </Button>
          ))}
        </div>
        <span className="font-sans text-xs text-on-surface-variant">
          Checked: {formatLastCheck(status.last_check)}
        </span>
      </div>

      {installedPackages.length > 0 && (
        <div className="space-y-2">
          {installedPackages.map((pkg) => (
            <div
              key={pkg.id}
              className="flex items-center justify-between gap-3 rounded-md border border-outline/20 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="font-sans text-sm text-on-surface">{pkg.display_name}</div>
                <div className="font-mono text-xs text-on-surface-variant">
                  {pkg.installed_version ?? 'not installed'}
                  {pkg.update_available && pkg.latest_version ? ` → ${pkg.latest_version}` : ''}
                </div>
              </div>
              <Badge variant={pkg.update_available ? 'warning' : 'secondary'}>
                {pkg.update_available ? 'Update available' : 'Installed'}
              </Badge>
            </div>
          ))}
          <p className="font-sans text-xs text-on-surface-variant">
            {runtimeSummary}
          </p>
        </div>
      )}

      {/* Error row */}
      {(applyState === 'error' || status.error) && (
        <div className="flex items-start gap-2 text-tertiary">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span className="font-sans text-sm">
            {errorMessage ?? status.error}
          </span>
        </div>
      )}
    </Surface>
  );
}
