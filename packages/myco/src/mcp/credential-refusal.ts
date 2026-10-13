import { resolveMycoHome } from '@myco/paths/home.js';
import { isMemberHome, memberHomeDaemonRefusal, unmovedLegacyVaults } from '@myco/member/home-role.js';

/** Credential-less clients have no upstream on any home. */
export function credentialRequiredError(): { code: string; message: string } {
  const home = resolveMycoHome();
  if (isMemberHome(home)) return { code: 'member_home', message: memberHomeDaemonRefusal(home) };
  if (unmovedLegacyVaults(home).length > 0) {
    return {
      code: 'credential_required',
      message: 'To move your Myco 1.4 data to Myco 2.0, run `myco login <invite link>`, '
        + 'then `myco cutover --dry-run` to preview the move, then `myco cutover`. '
        + 'After the move, run `myco member provision <agent>` to set up your agent, '
        + 'and use `--credential registry` for MCP and tool commands.',
    };
  }
  return {
    code: 'credential_required',
    message: 'Myco 2.0 needs a member credential for MCP and tool commands. Run `myco login <invite link>`, '
      + 'then `myco member provision <agent>` to set up your agent, and use `--credential registry`.',
  };
}
