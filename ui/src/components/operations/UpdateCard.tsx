import { useState, useCallback } from 'react';
import { ArrowUpCircle, RefreshCw, CheckCircle2, AlertCircle, Shield } from 'lucide-react';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';
import {
  useUpdateStatus,
  useUpdateCheck,
  useUpdateApply,
  useUpdateChannel,
} from '../../hooks/use-update-status';

/* ---------- Constants ---------- */

const CHANNELS = ['stable', 'beta'] as const;

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

/* ---------- UpdateCard ---------- */

export function UpdateCard() {
  const { data: status } = useUpdateStatus();
  const checkMutation = useUpdateCheck();
  const applyMutation = useUpdateApply();
  const channelMutation = useUpdateChannel();

  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
          {updateAvailable && status.latest_version && (
            <Badge variant="warning">{status.latest_version}</Badge>
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
                Update &amp; Restart
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
          {CHANNELS.map((ch) => (
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

      {/* Error row */}
      {(applyState === 'error' || status.error) && (
        <div className="flex items-start gap-2 text-tertiary">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="font-sans text-sm">
            {errorMessage ?? status.error}
          </span>
        </div>
      )}
    </Surface>
  );
}
