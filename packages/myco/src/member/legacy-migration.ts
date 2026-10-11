/** Read-only legacy capture deferral. */
import { legacyVaultFiles } from '@myco/member/home-role.js';
import { defaultMycoHome } from '@myco/paths/home.js';

/** Retained vaults require migration evidence; membership and backup presence do not prove a move. */
export function legacyMigrationPending(mycoHome: string): boolean {
  return [...new Set([mycoHome, defaultMycoHome()])].some((home) => legacyVaultFiles(home).length > 0);
}
