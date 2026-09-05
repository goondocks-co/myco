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
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { COMPOSE_OVERRIDE_TEMPLATE } from './compose-template.js';

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

/**
 * Move a single-directory layout into the per-target subtrees, and give a
 * bundle written before the override file one. A no-op when neither applies.
 *
 * Every verb resolves its paths through here before its first Compose call, so
 * a bundle from an earlier version is repaired by whichever verb touches it
 * first rather than by `create` alone. An override already on disk is the
 * operator's and is left exactly as it is.
 */
export function ensureServerLayout(mycoHome: string): void {
  const root = path.join(mycoHome, 'server');
  if (!existsSync(root)) return;
  for (const name of ['compose.yaml', 'secrets', '.env']) {
    moveIfAbsent(path.join(root, name), path.join(root, 'compose', name));
  }
  moveIfAbsent(path.join(root, 'cloudflare.json'), path.join(root, 'cloudflare', 'record.json'));

  const bundle = path.join(root, 'compose');
  const override = path.join(bundle, 'compose.override.yaml');
  if (existsSync(path.join(bundle, 'compose.yaml')) && !existsSync(override)) {
    writeFileSync(override, COMPOSE_OVERRIDE_TEMPLATE, { mode: 0o600 });
  }
}
