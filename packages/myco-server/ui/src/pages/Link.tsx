import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { PageContainer } from '../components/ui/page-container';
import { useMe } from '../hooks/use-me';
import { ApiError, postJson, SignedOutError } from '../lib/api';
import { clearPendingLink, holdPendingLink, readPendingLink } from '../lib/pending-link';

type Member = { id: string; label: string | null };
type Preview = { preview: { member: Member } };
type Linked = { linked: true; member: Member };

const REFUSALS: Record<string, string> = {
  link_denied: 'This link has expired or was already used. Run `myco member link-github` again for a fresh one.',
  identity_taken: 'This GitHub account is already connected to another member.',
  member_linked: 'That member already has a GitHub account connected. Changing it needs the server operator.',
  member_revoked: 'That member has been removed from this server.',
};

/** Reads the key from the URL fragment once, holds it for this tab, and clears it from the address bar. */
function takeKeyFromFragment(): string | null {
  const fragment = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  if (fragment.length > 0) {
    holdPendingLink(fragment);
    window.history.replaceState(null, '', window.location.pathname);
    return fragment;
  }
  return readPendingLink();
}

/** `/link`: connect the signed-in GitHub account to the member that minted the key. Lives outside the member gate: its visitor is not a member yet. */
export function LinkPage() {
  const [key] = useState<string | null>(takeKeyFromFragment);
  const me = useMe();
  const [preview, setPreview] = useState<Member | null>(null);
  const [outcome, setOutcome] = useState<{ kind: 'linked'; member: Member } | { kind: 'refused'; text: string } | null>(null);
  const signedIn = me.data !== undefined;
  const signedOut = me.error instanceof SignedOutError;

  useEffect(() => {
    if (!signedIn || key === null || preview !== null || outcome !== null) return;
    postJson<Preview>('/auth/link', { key })
      .then((r) => setPreview(r.preview.member))
      .catch((err: unknown) => {
        clearPendingLink();
        setOutcome({ kind: 'refused', text: refusalText(err) });
      });
  }, [signedIn, key, preview, outcome]);

  const confirm = async () => {
    if (key === null) return;
    try {
      const r = await postJson<Linked>('/auth/link', { key, confirm: true });
      setOutcome({ kind: 'linked', member: r.member });
    } catch (err: unknown) {
      setOutcome({ kind: 'refused', text: refusalText(err) });
    } finally {
      clearPendingLink();
    }
  };

  return (
    <PageContainer variant="narrow" className="flex min-h-screen flex-col items-center justify-center gap-4 text-center">
      <h1 className="font-serif text-2xl text-on-surface">Connect your GitHub account</h1>
      {key === null && <p className="font-sans text-sm text-on-surface-variant">There is no link to complete here. Run <code className="font-mono">myco member link-github</code> on a machine that has joined this server.</p>}
      {key !== null && signedOut && (
        <>
          <p className="max-w-md font-sans text-sm text-on-surface-variant">Sign in with the GitHub account you want to connect; you will come back here.</p>
          <a href="/auth/login" className="rounded-md bg-primary px-4 py-2 font-sans text-sm text-on-primary transition-opacity hover:opacity-90">Sign in with GitHub</a>
        </>
      )}
      {key !== null && me.isPending && <p className="font-sans text-sm text-on-surface-variant">Checking your sign-in…</p>}
      {key !== null && signedIn && outcome === null && preview === null && <p className="font-sans text-sm text-on-surface-variant">Checking the link…</p>}
      {key !== null && signedIn && outcome === null && preview !== null && (
        <>
          <p className="max-w-md font-sans text-sm text-on-surface">
            Connect <strong>@{me.data!.login || me.data!.sub}</strong> to the member <strong>{preview.label ?? preview.id}</strong> <span className="font-mono text-xs text-on-surface-variant">({preview.id})</span>?
          </p>
          <p className="max-w-md font-sans text-xs text-on-surface-variant">Only continue if you ran <code className="font-mono">myco member link-github</code> yourself, moments ago. The account is fixed once connected.</p>
          <button type="button" onClick={() => void confirm()} className="rounded-md bg-primary px-4 py-2 font-sans text-sm text-on-primary transition-opacity hover:opacity-90">
            Connect this account
          </button>
        </>
      )}
      {outcome?.kind === 'linked' && (
        <>
          <p className="font-sans text-sm text-on-surface">Connected to <strong>{outcome.member.label ?? outcome.member.id}</strong>.</p>
          <RouterLink to="/projects" className="rounded-md bg-primary px-4 py-2 font-sans text-sm text-on-primary transition-opacity hover:opacity-90">Open Projects</RouterLink>
        </>
      )}
      {outcome?.kind === 'refused' && <p className="max-w-md font-sans text-sm text-tertiary">{outcome.text}</p>}
    </PageContainer>
  );
}

function refusalText(err: unknown): string {
  if (err instanceof ApiError) {
    const code = (err.body as { error?: unknown } | null)?.error;
    if (typeof code === 'string' && REFUSALS[code]) return REFUSALS[code];
    return `The server refused (${err.status}).`;
  }
  return 'Could not reach the server.';
}
