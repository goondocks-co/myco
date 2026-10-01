/**
 * The operator's server directory, one subtree per target:
 *
 *   server/compose/     a retired Compose bundle (compose.yaml, secrets/, .env), read only to name it
 *   server/cloudflare/  record.json
 *
 * Each target owns its subtree, so removing one cannot reach the other.
 *
 * The migration runs from both path resolvers, so every command sees this
 * layout on first touch. It moves, never copies, and never clobbers: with a
 * file already present at the destination, the source stays in place for the
 * operator to reconcile.
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

function moveIfAbsent(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return;
  mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch (err) {
    // A concurrent command can win the same rename; its result is this one's.
    if (!existsSync(to)) throw err;
  }
}

/** Move a single-directory layout into the per-target subtrees; a no-op when none is present. */
export function ensureServerLayout(mycoHome: string): void {
  const root = path.join(mycoHome, 'server');
  if (!existsSync(root)) return;
  for (const name of ['compose.yaml', 'secrets', '.env']) {
    moveIfAbsent(path.join(root, name), path.join(root, 'compose', name));
  }
  moveIfAbsent(path.join(root, 'cloudflare.json'), path.join(root, 'cloudflare', 'record.json'));
}

/** The directory of a Compose bundle this machine still holds, or null. The Compose target is retired; this names it. */
export function heldComposeBundle(mycoHome: string): string | null {
  ensureServerLayout(mycoHome);
  const root = path.join(mycoHome, 'server', 'compose');
  return existsSync(path.join(root, 'compose.yaml')) ? root : null;
}

/** What a verb aimed at a Compose Deployment answers: the target is retired, and what to do instead. */
export function composeRetired(bundle: string | null): string {
  const held = bundle === null ? '' : ` This machine holds one in ${bundle}; that bundle is ordinary Compose and still runs with docker compose from there.`;
  return `The Compose target is retired.${held} Run a Deployment from this binary with \`myco server create --target local\`, `
    + 'or run the plain server image (ghcr.io/goondocks-co/myco-server) under a container runtime you manage yourself.';
}
