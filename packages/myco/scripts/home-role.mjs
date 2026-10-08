/** Read-only membership and legacy-vault predicates shared with the npm bootstrap. */
import fs from 'node:fs';
import path from 'node:path';
export const MEMBER_DIRNAME = 'member';

/** Where a home keeps its Deployment memberships, and the record a cutover leaves. */
const DEPLOYMENTS_DIR = 'deployments';
export const CUTOVER_STATE_FILE = 'cutover.json';

/** Where Myco 1.4 keeps a home's vaults: `groves/<grove id>/myco.db`. */
const LEGACY_GROVES_DIR = 'groves';
const LEGACY_VAULT_FILE = 'myco.db';

export function isMemberHome(mycoHome) {
  const member = path.join(mycoHome, MEMBER_DIRNAME);
  if (fs.existsSync(path.join(member, CUTOVER_STATE_FILE))) return true;
  try {
    return fs.readdirSync(path.join(member, DEPLOYMENTS_DIR)).some((name) => name.endsWith('.json'));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code ?? '')) return false;
    throw error;
  }
}

/** What a person is told when a 1.4 daemon path is asked for in a member home. */
export function memberHomeDaemonRefusal(mycoHome) {
  return `${mycoHome} is a Myco 2.0 member home, so the Myco 1.4 local daemon does not run here. `
    + 'Use the Deployment through the member credential instead: `myco tool call <tool> --credential registry`, '
    + 'and `myco member provision <agent>` to give an agent the member MCP entry and hooks.';
}

/** The vault files a source names: a `myco.db`, a directory holding one, or a 1.4 home whose `groves/*` hold them. Empty files are no vault. */
export function legacyVaultFiles(source) {
  const nonEmpty = (file) => {
    try { const stat = fs.statSync(file); return stat.isFile() && stat.size > 0; }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code ?? '')) return false;
      throw error;
    }
  };
  if (nonEmpty(source)) return [path.resolve(source)];
  const direct = path.join(source, LEGACY_VAULT_FILE);
  if (nonEmpty(direct)) return [path.resolve(direct)];
  const groves = path.join(source, LEGACY_GROVES_DIR);
  let entries;
  try { entries = fs.readdirSync(groves, { withFileTypes: true }); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code ?? '')) return [];
    throw error;
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.resolve(groves, e.name, LEGACY_VAULT_FILE))
    .filter(nonEmpty)
    .sort();
}

/** The Myco 1.4 vaults of a home no cutover or membership has moved to 2.0; none for any other home. */
export function unmovedLegacyVaults(mycoHome) {
  return isMemberHome(mycoHome) ? [] : legacyVaultFiles(mycoHome);
}

/** What a person is told when this binary's daemon is asked to start in a home Myco 1.4 still serves. */
export function legacyHomeDaemonRefusal(mycoHome) {
  return `${mycoHome} holds Myco 1.4 vaults (${path.join(mycoHome, LEGACY_GROVES_DIR)}) that no cutover has moved to Myco 2.0, `
    + 'so this Myco 2.0 binary does not run a daemon here or open them. Keep Myco 1.4 serving this home, '
    + 'or move it to 2.0: `myco login <invite link>`, `myco cutover --dry-run`, then `myco cutover`.';
}
