import { useState } from 'react';
import { JOIN_PATH } from '@goondocks/myco-shared/member-protocol';
import { CommandBlock, Link } from '../design';

/** The invitation key a join link carries in its fragment, which a browser never sends to the server. */
function keyFromFragment(): string {
  return window.location.hash.startsWith('#') ? window.location.hash.slice(1).trim() : '';
}

/**
 * `/join#<key>`: where an invitation link opens in a browser. The invitation
 * is redeemed by `myco login` on the machine joining, not here, so the page
 * hands over the exact command. It reads nothing from the server, needs no
 * sign-in, and the key never leaves the fragment.
 */
export function Join() {
  const [key] = useState(keyFromFragment);
  const link = `${window.location.origin}${JOIN_PATH}#${key}`;
  return (
    <div className="min-h-screen bg-bg text-ink">
      <main className="mx-auto flex w-full max-w-narrow flex-col gap-s6 p-gutter pt-s12">
        <span aria-hidden className="grid size-s10 place-items-center rounded-control bg-primary-bg t-body font-semibold text-primary">M</span>
        <div className="flex flex-col gap-s2">
          <h1 className="t-display text-ink">Connect a machine to Myco</h1>
          <p className="t-body text-ink-2">
            This link is an invitation to the Myco at <span className="font-medium text-ink">{window.location.origin.replace(/^[a-z]+:\/\//, '')}</span>. It connects a
            machine, where your agents run, not this browser.
          </p>
        </div>
        {key === '' ? (
          <div role="alert" className="flex flex-col gap-s2 rounded-card border border-line bg-surface-1 p-s5">
            <h2 className="t-h3 text-ink">This link carries no invitation</h2>
            <p className="t-small text-muted">
              An invitation link ends in <code className="t-mono text-ink-2">{JOIN_PATH}#</code> and a key. Ask whoever sent it for the whole link.
            </p>
          </div>
        ) : (
          <>
            <CommandBlock caption="On the machine you want to connect, run:" command={`myco login ${link}`} />
            <ul className="flex list-disc flex-col gap-s2 pl-s5 t-small text-muted">
              <li>The link works once and then expires. If it is refused, ask whoever sent it for a fresh one.</li>
              <li>If the invitation names a project, run the command from inside that project&rsquo;s folder.</li>
              <li>Keep the link private until it is used: whoever holds it can join.</li>
            </ul>
          </>
        )}
        <p className="t-small text-muted">
          Already connected? <Link to="/">Open the dashboard</Link>
        </p>
      </main>
    </div>
  );
}
