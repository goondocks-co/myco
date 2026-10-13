import { resolveMycoHome } from '@myco/paths/home.js';
import { isMemberHome, unmovedLegacyVaults } from '@myco/member/home-role.js';

import { LEGACY_MIGRATION_GUIDANCE } from '../member/migration-guidance.js';

/** Credential-less clients have no upstream on any home. */
export function credentialRequiredError(surface: 'mcp' | 'tool'): { code: string; message: string } {
  const home = resolveMycoHome();
  if (isMemberHome(home)) {
    const command = surface === 'mcp' ? 'myco mcp --credential registry' : 'myco tool call <tool> --credential registry';
    return { code: 'member_home', message: `This Myco member home requires a member credential. Run \`${command}\`. `
      + 'Run `myco member provision <agent>` to refresh a leftover MCP entry.' };
  }
  if (unmovedLegacyVaults(home).length > 0) {
    return {
      code: 'credential_required',
      message: LEGACY_MIGRATION_GUIDANCE,
    };
  }
  return {
    code: 'credential_required',
    message: 'Myco 2.0 needs a member credential for MCP and tool commands. Run `myco login <invite link>`, '
      + 'then `myco member provision <agent>` to set up your agent, and use `--credential registry`.',
  };
}
