/**
 * The one home every member verb and hook uses for a folder (#1499).
 *
 * Identity is the Myco home: it holds the membership, and the membership is the credential. `myco login`, `myco member
 * join`, `myco member provision` and every capture hook resolve it by this one rule, from the folder they act for, so
 * a sign-in and the capture it enables never land in two homes. The rule is `resolveMycoHome`'s precedence with the
 * folder named: `MYCO_HOME`, then a `.myco/runtime.home` pin at or above the folder, then the machine pin, then
 * `~/.myco`.
 *
 * A folder pinned to a home is told so: the pin is why a command reads a home the person may not expect, and a
 * credential is never used from a home nobody named.
 */
import { resolveMycoHomeWithSource, type ResolvedMycoHome } from '../paths/home.js';

/** The home `folder` resolves to, with the rule that chose it. */
export function memberHomeFor(folder: string, env?: NodeJS.ProcessEnv): ResolvedMycoHome {
  return resolveMycoHomeWithSource({ cwd: folder, ...(env === undefined ? {} : { env }) });
}

/** What a command says when `folder`'s home comes from a pin at or above it; null when it does not. */
export function pinnedHomeLine(resolved: ResolvedMycoHome, folder: string): string | null {
  return resolved.source === 'project-pin' ? `Using ${resolved.home}: ${folder} is pinned to it by ${resolved.pinPath}.` : null;
}

/** Why `folder` has no membership to use when a pin chose its home, and what fixes it; null when no pin chose it. */
export function pinnedHomeRefusal(resolved: ResolvedMycoHome, folder: string, what: string): string | null {
  if (resolved.source !== 'project-pin') return null;
  return `${folder} is pinned to ${resolved.home} by ${resolved.pinPath}, which holds no ${what}. Sign in there with \`myco login <invite link>\` from this folder, or remove the pin to use this machine's own home.`;
}

/**
 * Whether a pin at or above `folder` sends it to a home other than this machine's own (the home with no folder named).
 * There, a member verb never picks one of that home's memberships on its own: the person names the Deployment, or the
 * pin goes. That home's credential is never used for a Deployment nobody named.
 */
export function pinnedElsewhere(resolved: ResolvedMycoHome, env?: NodeJS.ProcessEnv): boolean {
  if (resolved.source !== 'project-pin') return false;
  return resolveMycoHomeWithSource(env === undefined ? {} : { env }).home !== resolved.home;
}

/** What a member verb says when a pin sends `folder` to another home and no Deployment was named. */
export function pinnedElsewhereRefusal(resolved: ResolvedMycoHome, folder: string, deployments: readonly string[]): string {
  const held = deployments.length === 0 ? 'no membership' : `a membership of ${deployments.join(', ')}`;
  return `${folder} is pinned to ${resolved.home} by ${resolved.pinPath}, which holds ${held}, not this machine's own home. Name the Deployment to use that home's membership (for example \`myco member join <server-url> --new\`), or remove the pin to use this machine's own home.`;
}
