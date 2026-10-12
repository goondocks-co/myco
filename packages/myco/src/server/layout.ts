/** The managed Cloudflare operator record moves without overwriting an existing destination. */
import nodeFs from 'node:fs';
const { existsSync, mkdirSync, renameSync } = nodeFs;
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
  moveIfAbsent(path.join(root, 'cloudflare.json'), path.join(root, 'cloudflare', 'record.json'));
}
