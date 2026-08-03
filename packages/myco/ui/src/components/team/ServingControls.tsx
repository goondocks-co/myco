/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Team-page-only actions for THIS machine's serving card (E1 §5.2 Tab 1):
 * Mint join key (one-time reveal + ready-to-paste `myco join …`) and Stop
 * hosting. Rendered through `TeamHostServingCard`'s `actions` slot — the
 * Machine-dashboard mount passes nothing, so its recorded placement
 * (decision-ef693c71 D2) renders byte-identically.
 */
import { useState } from 'react';
import { AlertTriangle, KeyRound, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { AccentSurface } from '../ui/accent-surface';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { CopyableField } from './CopyableField';
import { RedactedField } from './RedactedField';
import {
  useHostAdminDisable,
  useHostAdminProgress,
  useHostServePhase2,
  useMintJoinKey,
  type MintJoinKeyResponse,
} from '../../hooks/use-host-admin';

export function MintJoinKeyControl() {
  const mint = useMintJoinKey();
  const [minted, setMinted] = useState<MintJoinKeyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleMint = async () => {
    setError(null);
    try {
      setMinted(await mint.mutateAsync({}));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={handleMint} disabled={mint.isPending}>
          {mint.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
          Mint join key
        </Button>
        <span className="text-xs text-on-surface-variant">One-time key for a teammate — shown once, works once.</span>
      </div>
      {minted && (
        <AccentSurface accent="sage" padded className="flex flex-col gap-2" role="status" data-testid="join-key-reveal">
          <p className="m-0 text-xs text-on-surface">
            Hand this to your teammate — the key is shown once and works once (expires in {minted.expires}).
          </p>
          {/* The command COPIES complete (a broken paste helps nobody) but
              DISPLAYS with the key masked — rendering it cleartext directly
              above a redacted copy of the same key bought nothing (N10). */}
          <CopyableField
            label="Join command"
            value={minted.join_command}
            displayValue={minted.join_command.replace(minted.key, '••••••••')}
          />
          <RedactedField label="Key" value={minted.key} />
        </AccentSurface>
      )}
      {error && <p className="m-0 text-xs text-terracotta" data-testid="mint-key-error">{error}</p>}
    </div>
  );
}

export function DisableHostControl() {
  const disable = useHostAdminDisable();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<{ token: string; snapshot: string | null; startedAtMs: number } | null>(null);

  const progress = useHostAdminProgress(run?.token ?? null);
  const jobStatus = progress.data?.status;
  const jobGone = run !== null && progress.data === null && progress.isFetched;
  const phase2 = useHostServePhase2({
    active: run !== null && (jobStatus === 'completed' || jobGone),
    token: run?.token ?? null,
    snapshot: run?.snapshot ?? null,
    armedAt: run?.startedAtMs ?? 0,
    direction: 'disable',
  });
  const done = phase2.data?.done === true;

  const handleDisable = async () => {
    setError(null);
    try {
      const res = await disable.mutateAsync();
      setRun({ token: res.token, snapshot: res.started_at, startedAtMs: Date.now() });
      setConfirmOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (run !== null && !done && jobStatus !== 'failed') {
    return (
      <div className="flex items-center gap-2" role="status" data-testid="disable-progress">
        <Loader2 className="size-4 animate-spin text-sage" aria-hidden />
        <span className="text-xs text-on-surface-variant">
          {progress.data?.message ?? 'Stopping team hosting…'}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="ghost" onClick={() => setConfirmOpen(true)} disabled={disable.isPending}>
        Stop hosting
      </Button>
      {jobStatus === 'failed' && (
        <p className="m-0 text-xs text-terracotta" data-testid="disable-error">
          Disable did not finish — the step log in the daemon log has details; a retry converges.
        </p>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => { setConfirmOpen(open); if (!open) setError(null); }}
        title="Stop hosting this team?"
        description={'Your teammates lose access to team knowledge served from this machine until a host is enabled again. '
          + 'The team’s storage stays on this machine — re-enabling hosting picks it back up, history intact.'}
        icon={<AlertTriangle className="h-4 w-4 text-tertiary" />}
        confirmLabel="Stop hosting"
        onConfirm={handleDisable}
        isPending={disable.isPending}
        errorMessage={error}
      />
    </div>
  );
}
