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
 * inviting a member and Stop hosting.
 *
 * Inviting is DISABLED in this build: the one-time key it minted was a headscale
 * pre-auth key the daemon never validated, and the daemon-issued key that
 * replaces it lands with the rebuilt enrollment route. The control stays visible
 * but inert, so the capability is discoverable without appearing to work — a
 * live-looking button that 503s on click is worse than one that says why.
 *
 * The mint mutation, reveal block, and error state below are deliberately kept
 * rather than deleted: the enrollment rebuild re-enables this exact control, and
 * the reveal is the one-time-key surface it needs back.
 *
 * Rendered through `TeamHostServingCard`'s `actions` slot — the Machine-dashboard
 * mount passes nothing, so its recorded placement (decision-ef693c71 D2) renders
 * byte-identically.
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
  useHostMembers,
  useMintJoinKey,
  useRevokeHostAccess,
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
          <KeyRound className="mr-2 h-4 w-4" />
          {mint.isPending ? 'Creating invite…' : 'Invite a member'}
        </Button>
      </div>
      {minted && (
        <AccentSurface accent="sage" padded className="flex flex-col gap-2" role="status" data-testid="join-key-reveal">
          <p className="m-0 text-xs text-on-surface">
            Hand this to your teammate — the key is shown once and works once
            (expires {new Date(minted.expires).toLocaleString()}).
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

/**
 * Who can reach this host, and what invitations are outstanding.
 *
 * Minting created user-reachable state with no way to see or undo it: an
 * operator could hand out keys and had no list, no revoke, and no expiry view.
 * Revoking is effective on that member's next request — there is no restart to
 * wait for and nothing to explain about propagation.
 */
export function MemberAccessControl() {
  const [open, setOpen] = useState(false);
  const members = useHostMembers(open);
  const revoke = useRevokeHostAccess();
  const [error, setError] = useState<string | null>(null);

  const act = async (body: { member_id?: string; join_key_id?: string }) => {
    setError(null);
    try { await revoke.mutateAsync(body); } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Manage access…
      </Button>
    );
  }

  const rows = members.data;
  return (
    <AccentSurface accent="sage" padded className="flex flex-col gap-3" data-testid="member-access">
      <p className="m-0 text-xs text-on-surface-variant">
        Removing someone takes effect on their next request.
      </p>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-on-surface">Members</span>
        {(rows?.members ?? []).filter((m) => !m.revoked).length === 0 ? (
          <span className="text-xs text-on-surface-variant">Nobody has joined yet.</span>
        ) : (
          (rows?.members ?? []).filter((m) => !m.revoked).map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs">
                {m.label ?? m.machine_id}
                <span className="ml-2 font-mono text-on-surface-variant">{m.machine_id}</span>
              </span>
              <Button size="sm" variant="outline" onClick={() => act({ member_id: m.id })}>Remove</Button>
            </div>
          ))
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-on-surface">Outstanding invites</span>
        {(rows?.join_keys ?? []).filter((k) => k.state === 'active').length === 0 ? (
          <span className="text-xs text-on-surface-variant">No unused invites.</span>
        ) : (
          (rows?.join_keys ?? []).filter((k) => k.state === 'active').map((k) => (
            <div key={k.id} className="flex items-center justify-between gap-2">
              <span className="text-xs text-on-surface-variant">
                expires {new Date(k.expires_at).toLocaleString()}
              </span>
              <Button size="sm" variant="outline" onClick={() => act({ join_key_id: k.id })}>Withdraw</Button>
            </div>
          ))
        )}
      </div>

      {error && <p className="m-0 text-xs text-terracotta" data-testid="member-access-error">{error}</p>}
    </AccentSurface>
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
