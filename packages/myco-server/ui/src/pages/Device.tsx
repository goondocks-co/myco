import { useRef, useState } from 'react';
import { Button, buttonVariants, Card, FactRow, FactsPanel, Input } from '../design';
import { useMe } from '../hooks/use-me';
import { ApiError, postJson, SignedOutError } from '../lib/api';
import { pendingDeviceCode } from '../lib/pending-device';

interface Preview { machineName: string; os: string; ip: string; scope: string; expiresAt: number }

function refusal(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403 || error.status === 404 && error.code === 'not_found') return 'You cannot approve this sign-in. Only the owner can add an admin machine.';
    if (error.code === 'expired_token' || error.code === 'request_finished' || error.code === 'invalid_user_code' || error.code === 'approval_refused') return 'This code has expired, was already used, or does not match. Run myco login again for a new code.';
    if (error.status === 429) return 'Too many attempts. Wait a moment and try again.';
  }
  return 'This server could not complete the request. Try again.';
}

/** A human approves the machine they requested only after comparing its code and connection details. */
export function Device() {
  const me = useMe();
  const [code, setCode] = useState(() => {
    const named = new URLSearchParams(window.location.search).get('code');
    return named ?? pendingDeviceCode() ?? '';
  });
  const [preview, setPreview] = useState<(Preview & { code: string }) | null>(null);
  const revision = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState<'approved' | 'denied' | null>(null);
  const check = async () => {
    const checkedCode = code;
    const version = ++revision.current;
    setPending(true); setError(null); setPreview(null);
    try {
      const details = await postJson<Preview>('/api/device/preview', { user_code: checkedCode });
      if (version === revision.current) setPreview({ ...details, code: checkedCode });
    }
    catch (e) { if (version === revision.current) setError(refusal(e)); }
    finally { if (version === revision.current) setPending(false); }
  };
  const decide = async (decision: 'approve' | 'deny') => {
    if (preview === null || preview.code !== code) return;
    setPending(true); setError(null);
    try {
      await postJson(`/api/device/${decision}`, { user_code: preview.code });
      setFinished(decision === 'approve' ? 'approved' : 'denied');
      pendingDeviceCode(null);
    } catch (e) { setError(refusal(e)); }
    finally { setPending(false); }
  };
  return <main className="flex min-h-screen items-center justify-center bg-bg p-gutter">
    <Card className="flex w-full max-w-measure flex-col gap-s4 p-s5">
      <h1 className="t-display text-ink">Sign in a machine</h1>
      {finished ? <p role="status" className="t-body text-ink">{finished === 'approved' ? 'Approved. Return to your terminal to finish signing in.' : 'Denied. This machine will not be signed in.'}</p>
        : me.error instanceof SignedOutError ? <>
          <p className="t-body text-muted">Sign in with your GitHub account to approve your machine.</p>
          <a href="/auth/login" onClick={() => { pendingDeviceCode(code); }} className={buttonVariants({ variant: 'primary' })}>Sign in with GitHub</a>
        </> : me.isPending ? <p role="status">Checking your sign-in…</p>
          : me.error ? <p role="alert">This server is not answering. Reload to try again.</p>
            : !me.data?.member ? <p role="alert">Your GitHub account is not connected to a member of this server.</p>
              : <>
                <form onSubmit={e => { e.preventDefault(); void check(); }} className="flex flex-col gap-s3">
                  <label className="t-body text-ink" htmlFor="device-code">Code from your terminal</label>
                  <Input id="device-code" value={code} maxLength={9} autoComplete="off"
                    onChange={e => { ++revision.current; setCode(e.target.value.toUpperCase()); setPreview(null); setPending(false); }} />
                  <Button type="submit" pending={pending} disabled={!code.trim()}>Check machine</Button>
                </form>
                {preview && preview.code === code && <>
                  <FactsPanel>
                    <FactRow term="Machine">{preview.machineName}</FactRow>
                    <FactRow term="Operating system">{preview.os}</FactRow>
                    <FactRow term="IP address">{preview.ip}</FactRow>
                    <FactRow term="Code">{preview.code}</FactRow>
                    <FactRow term="Access">Your membership: capture sessions and use project memory.{me.data.member.role === 'admin' ? ' This machine can also run Myco’s work and administer the server.' : ''}</FactRow>
                  </FactsPanel>
                  <p className="t-body text-muted">Approve only if you started this sign-in and the code matches your terminal. Someone else asking you to approve their code can gain access as you.</p>
                  {me.data.member.role === 'admin' && !me.data.owner && <p role="alert" className="t-body text-muted">Only the owner can approve an admin machine. Ask the owner for an invite link for your membership, then run myco login with that link.</p>}
                  <div className="flex gap-s3">
                    <Button variant="primary" disabled={me.data.member.role === 'admin' && !me.data.owner} pending={pending} onClick={() => void decide('approve')}>Approve this machine</Button>
                    <Button pending={pending} onClick={() => void decide('deny')}>Deny</Button>
                  </div>
                </>}
              </>}
      {error && <p role="alert" className="t-body text-bad">{error}</p>}
    </Card>
  </main>;
}
