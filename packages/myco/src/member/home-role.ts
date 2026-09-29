/**
 * Whether a Myco home is a 2.0 member home: it holds a Deployment membership,
 * or a cutover moved it from 1.4. A member home never runs the 1.4 local
 * daemon: nothing spawns it, it refuses to start, it installs no service,
 * and it never rewrites the agents' global config. Capture and tools reach
 * the Deployment through the member credential instead, so a 1.4 hook or
 * MCP entry left anywhere on the machine is inert.
 *
 * The one predicate every such path reads (`tests/meta/member-home-daemon-gate.test.ts`).
 *
 * A home still holding Myco 1.4 vaults that no cutover or membership has
 * moved is 1.4's: this binary never runs its daemon there either, so a 1.4
 * updater that swaps this binary in sees it never come up and restores 1.4.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MEMBER_DIRNAME } from './store.js';

/** Where a home keeps its Deployment memberships, and the record a cutover leaves. */
const DEPLOYMENTS_DIR = 'deployments';
export const CUTOVER_STATE_FILE = 'cutover.json';

/** Where Myco 1.4 keeps a home's vaults: `groves/<grove id>/myco.db`. */
const LEGACY_GROVES_DIR = 'groves';
const LEGACY_VAULT_FILE = 'myco.db';

export function isMemberHome(mycoHome: string): boolean {
  const member = path.join(mycoHome, MEMBER_DIRNAME);
  if (fs.existsSync(path.join(member, CUTOVER_STATE_FILE))) return true;
  try {
    return fs.readdirSync(path.join(member, DEPLOYMENTS_DIR)).some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

/** What a person is told when a 1.4 daemon path is asked for in a member home. */
export function memberHomeDaemonRefusal(mycoHome: string): string {
  return `${mycoHome} is a Myco 2.0 member home, so the Myco 1.4 local daemon does not run here. `
    + 'Use the Deployment through the member credential instead: `myco tool call <tool> --credential registry`, '
    + 'and `myco member provision <agent>` to give an agent the member MCP entry and hooks.';
}

/** The vault files a source names: a `myco.db`, a directory holding one, or a 1.4 home whose `groves/*` hold them. Empty files are no vault. */
export function legacyVaultFiles(source: string): string[] {
  const nonEmpty = (file: string): boolean => { try { return fs.statSync(file).isFile() && fs.statSync(file).size > 0; } catch { return false; } };
  if (nonEmpty(source)) return [path.resolve(source)];
  const direct = path.join(source, LEGACY_VAULT_FILE);
  if (nonEmpty(direct)) return [path.resolve(direct)];
  const groves = path.join(source, LEGACY_GROVES_DIR);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(groves, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.resolve(groves, e.name, LEGACY_VAULT_FILE))
    .filter(nonEmpty)
    .sort();
}

/** The Myco 1.4 vaults of a home no cutover or membership has moved to 2.0; none for any other home. */
export function unmovedLegacyVaults(mycoHome: string): string[] {
  return isMemberHome(mycoHome) ? [] : legacyVaultFiles(mycoHome);
}

/** What a person is told when this binary's daemon is asked to start in a home Myco 1.4 still serves. */
export function legacyHomeDaemonRefusal(mycoHome: string): string {
  return `${mycoHome} holds Myco 1.4 vaults (${path.join(mycoHome, LEGACY_GROVES_DIR)}) that no cutover has moved to Myco 2.0, `
    + 'so this Myco 2.0 binary does not run a daemon here or open them. Keep Myco 1.4 serving this home, '
    + 'or move it to 2.0: `myco login <invite link>`, `myco cutover --dry-run`, then `myco cutover`.';
}
