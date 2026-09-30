import { useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import { Button, buttonVariants, Card, CommandBlock } from '../design';
import { useMe } from '../hooks/use-me';
import { ApiError, postJson, SignedOutError } from '../lib/api';
import { memberLabel } from '../lib/member-name';
import { clearPendingLink, holdPendingLink, readPendingLink } from '../lib/pending-link';
import { PROJECTS_PATH } from '../routes/nav';

type Member = { id: string; label: string | null };
type Preview = { preview: { member: Member } };
type Linked = { linked: true; member: Member };

const REFUSALS: Record<string, string> = {
  link_denied: 'This link has expired or was already used. Ask whoever gave it to you for a fresh one.',
  identity_taken: 'This GitHub account is already connected to another member.',
  member_linked: 'That member already has a GitHub account connected. Changing it needs the server operator.',
  member_revoked: 'That member has been removed from this server.',
  link_requires_admin: `This link can no longer connect an account: this server already has an admin. Ask an admin to connect your GitHub account from the ${INVITE_CONTROLS.page} page.`,
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

/** The member a link names, by their name; one whose label is only their id reads as the member the link names. */
const memberWords = (member: Member): string => memberLabel(member) ?? 'the member this link names';

/** `/link`: connect the signed-in GitHub account to the member the key names. Lives outside the member gate: its visitor is not a member yet. */
export function LinkPage() {
  const [key] = useState<string | null>(takeKeyFromFragment);
  const me = useMe();
  const [preview, setPreview] = useState<Member | null>(null);
  const [outcome, setOutcome] = useState<{ kind: 'linked'; member: Member } | { kind: 'refused'; text: string } | null>(null);
  const [pending, setPending] = useState(false);
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
    setPending(true);
    try {
      const r = await postJson<Linked>('/auth/link', { key, confirm: true });
      setOutcome({ kind: 'linked', member: r.member });
    } catch (err: unknown) {
      setOutcome({ kind: 'refused', text: refusalText(err) });
    } finally {
      setPending(false);
      clearPendingLink();
    }
  };

  let body: ReactNode = null;
  if (key === null) {
    body = (
      <>
        <p className="t-body text-muted">There is no link to complete here. Ask an admin of this server for a link from the {INVITE_CONTROLS.page} page.</p>
        <CommandBlock caption="Setting up a new server? On a machine that has joined it, run:" command="myco member link-github" />
      </>
    );
  } else if (outcome?.kind === 'linked') {
    body = (
      <>
        <p className="t-body text-ink">Connected to <strong className="font-semibold">{memberWords(outcome.member)}</strong>.</p>
        <RouterLink to={PROJECTS_PATH} className={buttonVariants({ variant: 'primary', className: 'self-center' })}>Open Projects</RouterLink>
      </>
    );
  } else if (outcome?.kind === 'refused') {
    body = <p role="alert" className="t-body text-bad">{outcome.text}</p>;
  } else if (signedOut) {
    body = (
      <>
        <p className="t-body text-muted">Sign in with the GitHub account you want to connect; you will come back here.</p>
        <a href="/auth/login" className={buttonVariants({ variant: 'primary', className: 'self-center' })}>Sign in with GitHub</a>
      </>
    );
  } else if (me.isPending) {
    body = <p role="status" className="t-body text-muted">Checking your sign-in…</p>;
  } else if (preview === null) {
    body = <p role="status" className="t-body text-muted">Checking the link…</p>;
  } else {
    body = (
      <>
        <p className="t-body text-ink">
          Connect <strong className="font-semibold">@{me.data?.login || me.data?.sub}</strong> to the member <strong className="font-semibold">{memberWords(preview)}</strong>?
        </p>
        <p className="t-small text-muted">Only continue if this link is meant for you: one you asked the Myco CLI for yourself, or one an admin of this server sent you. The account is fixed once connected.</p>
        <Button variant="primary" className="self-center" pending={pending} onClick={() => void confirm()}>Connect this account</Button>
      </>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-gutter">
      <Card className="flex w-full max-w-measure flex-col gap-s4 p-s6 text-center">
        <h1 className="t-display text-ink">Connect your GitHub account</h1>
        {body}
      </Card>
    </main>
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
