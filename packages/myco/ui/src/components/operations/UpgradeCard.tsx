import { useState, useCallback, useEffect } from 'react';
import { ArrowUpCircle, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';
import { errorMessage as toErrorMessage } from '../../lib/error';
import { ApiError } from '../../lib/api';
import { RELEASE_CHANNELS } from '../../lib/constants';
import { withBasePath } from '../../lib/base-path';
import {
  useUpgradeStatus,
  useUpgradeCheck,
  useUpgradeApply,
  useUpgradeChannel,
} from '../../hooks/use-upgrade-status';

/* ---------- Constants ---------- */

/** Interval for polling /health after upgrade apply (ms). */
const HEALTH_POLL_INTERVAL_MS = 500;

/** Max time to wait for the new daemon after upgrade apply (ms). */
const HEALTH_POLL_TIMEOUT_MS = 60_000;

/* ---------- Types ---------- */

type ApplyState = 'idle' | 'applying' | 'restarting' | 'staging' | 'error';

/* ---------- Helpers ---------- */

function formatLastCheck(iso: string | undefined | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function upgradeBadgeLabel(
  packageCount: number,
  latestVersion: string | undefined,
): string | null {
  if (packageCount <= 0) return null;
  if (packageCount === 1 && latestVersion) return latestVersion;
  return `${packageCount} packages`;
}

/* ---------- UpgradeCard ---------- */

export function UpgradeCard() {
  const { data: status } = useUpgradeStatus();
  const checkMutation = useUpgradeCheck();
  const applyMutation = useUpgradeApply();
  const channelMutation = useUpgradeChannel();

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
        const res = await fetch(withBasePath('/health'));
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
      const applyResponse = await applyMutation.mutateAsync();
      // The daemon spawns a detached update script and SIGTERMs itself.
      // Poll /health AND verify the running version matches the target
      // before reloading. A first /health 200 isn't enough: launchd's
      // KeepAlive can briefly bring the old binary back, and a daemon
      // started before the npm install finishes can answer /health at
      // the OLD version. Without the version check the reload can race
      // an in-flight respawn cycle and land on a connection-refused
      // screen.
      const targetVersion = applyResponse.version;
      setApplyState('restarting');
      const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
      await new Promise<void>((resolve, reject) => {
        const check = async () => {
          if (Date.now() > deadline) {
            reject(new Error('timeout'));
            return;
          }
          try {
            const res = await fetch(withBasePath('/health'));
            if (res.ok) {
              const body = await res.json().catch(() => null) as { version?: string } | null;
              if (body?.version === targetVersion) {
                resolve();
                return;
              }
            }
          } catch { /* daemon still down — keep polling */ }
          setTimeout(check, HEALTH_POLL_INTERVAL_MS);
        };
        // Wait a beat for the daemon to actually die before polling
        setTimeout(check, HEALTH_POLL_INTERVAL_MS);
      });
      window.location.reload();
    } catch (err) {
      // 422 means the background staging job hasn't completed yet — this is a
      // transient, recoverable state. Show a retry-friendly message instead of
      // a hard error so the button stays usable.
      if (err instanceof ApiError && err.status === 422) {
        setApplyState('staging');
        setErrorMessage(null);
        return;
      }
      setApplyState('error');
      const msg = toErrorMessage(err) === 'timeout'
        ? 'Daemon did not restart within the expected time. Check the terminal.'
        : toErrorMessage(err);
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
  const revertAvailable = status.revert_available === true;
  const actionAvailable = updateAvailable || revertAvailable;
  const activeChannel = status.channel ?? 'stable';
  const installedPackages = (status.packages ?? []).filter((pkg) => pkg.installed);
  const pendingPackages = installedPackages.filter((pkg) => pkg.update_available);
  const pendingCount = pendingPackages.length;
  const latestBadge = upgradeBadgeLabel(pendingCount, pendingPackages[0]?.latest_version ?? undefined);
  const runtimeSummary =
    'This machine runs the managed Myco binary at ~/.myco/bin/myco. Switching channels swaps that same binary in place — Beta installs the latest prerelease, Stable steps back to the latest stable release.';

  return (
    <Surface level="low" className="p-6 space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ArrowUpCircle
            className={cn('h-4 w-4', actionAvailable ? 'text-secondary' : 'text-primary')}
          />
          <SectionHeader>Upgrade</SectionHeader>
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
        {actionAvailable ? (
          <Button
            variant="default"
            size="sm"
            onClick={handleApply}
            disabled={isApplying}
          >
            {isApplying ? (
              <>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {applyState === 'restarting' ? 'Restarting…' : (revertAvailable && !updateAvailable ? 'Reverting…' : 'Upgrading…')}
              </>
            ) : (
              <>
                <ArrowUpCircle className="mr-1.5 h-3.5 w-3.5" />
                {revertAvailable && !updateAvailable
                  ? 'Revert to Stable & Restart'
                  : pendingCount > 1 ? `Upgrade ${pendingCount} Packages & Restart` : 'Upgrade & Restart'}
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
          {installedPackages.map((pkg) => {
            const showRevert = pkg.revert_available && !pkg.update_available;
            return (
              <div
                key={pkg.id}
                className="flex items-center justify-between gap-3 rounded-md border border-outline/20 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="font-sans text-sm text-on-surface">{pkg.display_name}</div>
                  <div className="font-mono text-xs text-on-surface-variant">
                    {pkg.installed_version ?? 'not installed'}
                    {(pkg.update_available || showRevert) && pkg.latest_version ? ` → ${pkg.latest_version}` : ''}
                  </div>
                </div>
                <Badge variant={pkg.update_available || showRevert ? 'warning' : 'secondary'}>
                  {pkg.update_available ? 'Upgrade available' : showRevert ? 'Revert pending' : 'Installed'}
                </Badge>
              </div>
            );
          })}
          <p className="font-sans text-xs text-on-surface-variant">
            {runtimeSummary}
          </p>
        </div>
      )}

      {/* Staging state — transient 422 race: background staging not yet complete */}
      {applyState === 'staging' && (
        <div className="flex items-start gap-2 text-on-surface-variant">
          <RefreshCw className="h-4 w-4 mt-0.5 shrink-0 animate-spin" />
          <span className="font-sans text-sm">
            Upgrade is staging — try again in a moment.
          </span>
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
