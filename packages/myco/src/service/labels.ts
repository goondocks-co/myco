import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDefaultMycoHome, resolveMycoHome } from '../grove/paths.js';
import { isSandboxedServiceUnitDir, resolveServiceUnitDir } from './paths.js';

/**
 * Stable launchd/systemd label for the daemon in the default home (`~/.myco`).
 * Existing installs depend on this byte string — never change it.
 */
export const SERVICE_LABEL_PROD = 'co.goondocks.myco';

/**
 * When the unit dir is overridden via `MYCO_LAUNCH_AGENTS_DIR` (sandbox /
 * smoke-test installs), suffix the label with a short hash of the resolved
 * dir so the sandbox's `launchctl bootstrap` cannot clobber the real user's
 * daemon registration in the shared `gui/<uid>` domain. The plist file lands
 * in the sandbox, but launchctl still operates against the real session — so
 * the label must also be sandbox-distinct.
 */
function sandboxLabelSuffix(): string {
  if (!isSandboxedServiceUnitDir()) return '';
  const dir = resolveServiceUnitDir();
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  return `.sandbox-${hash}`;
}

/**
 * The launchd/systemd label for the daemon that owns `mycoHome`.
 *
 * The daemon's identity is its home, not a prod/dev variant: two independent
 * installs in two homes (`~/.myco`, `~/.myco-dev`) get distinct labels
 * automatically. The DEFAULT home (`~/.myco`) produces exactly
 * {@link SERVICE_LABEL_PROD} so existing installs keep their registration; any
 * other home appends a short stable hash of the resolved home path so the two
 * cannot clobber each other's `launchctl bootstrap` in the shared `gui/<uid>`
 * domain.
 *
 * The sandbox suffix (smoke-test / `MYCO_LAUNCH_AGENTS_DIR` installs) still
 * stacks on top — orthogonal to the home distinction.
 */
export function serviceLabel(mycoHome: string = resolveMycoHome()): string {
  return `${SERVICE_LABEL_PROD}${homeLabelSuffix(mycoHome)}${sandboxLabelSuffix()}`;
}

/**
 * Empty for the default home (so `~/.myco` → `co.goondocks.myco` byte-for-byte),
 * a short stable hash for any other home so distinct homes get distinct labels.
 */
function homeLabelSuffix(mycoHome: string): string {
  if (isDefaultMycoHome(mycoHome)) return '';
  const hash = createHash('sha256').update(path.resolve(mycoHome)).digest('hex').slice(0, 8);
  return `.${hash}`;
}

