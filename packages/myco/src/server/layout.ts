/**
 * The operator's server directory, one subtree per target:
 *
 *   server/compose/     the bundle (compose.yaml, secrets/, .env)
 *   server/cloudflare/  record.json
 *
 * Each target owns its subtree, so destroying one cannot reach the other —
 * `destroy --data` removes the bundle and the Cloudflare record stands.
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
