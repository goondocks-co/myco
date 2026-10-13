import { resolveMycoHome } from '@myco/paths/home.js';
import { isMemberHome, memberHomeDaemonRefusal, unmovedLegacyVaults, legacyHomeDaemonRefusal } from '@myco/member/home-role.js';
import { markAdoptFailed } from '@myco/upgrade/adopt-failed.js';
import { getPluginVersion } from '@myco/version.js';

/** The daemon command acknowledges a legacy adopter without starting a runtime. */
export function main(platform: NodeJS.Platform = process.platform): void {
  const home = resolveMycoHome();
  if (isMemberHome(home)) {
    console.error(memberHomeDaemonRefusal(home));
    return;
  }
  if (unmovedLegacyVaults(home).length > 0) {
    console.error(legacyHomeDaemonRefusal(home));
    markAdoptFailed(home, platform, getPluginVersion(), process.env.LOCALAPPDATA);
    return;
  }
  console.error('Myco 2.0 has no local daemon. Run `myco login <invite link>`, then `myco member provision <agent>` to set up your agent.');
}
