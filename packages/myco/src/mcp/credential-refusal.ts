import { resolveMycoHome } from '@myco/paths/home.js';
import { isMemberHome, memberHomeDaemonRefusal, unmovedLegacyVaults, legacyHomeDaemonRefusal } from '@myco/member/home-role.js';

/** Credential-less clients have no upstream on any home. */
export function credentialRequiredError(): { code: string; message: string } {
  const home = resolveMycoHome();
  if (isMemberHome(home)) return { code: 'member_home', message: memberHomeDaemonRefusal(home) };
  const message = 'Myco 2.0 requires an explicit member credential: use `--credential registry` '
    + 'and `myco member provision <agent>` to set up the member MCP entry and hooks.';
  return { code: 'credential_required', message: unmovedLegacyVaults(home).length > 0 ? `${message} ${legacyHomeDaemonRefusal(home)}` : message };
}
