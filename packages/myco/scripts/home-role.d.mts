export const MEMBER_DIRNAME: "member";
export const CUTOVER_STATE_FILE: "cutover.json";
export function isMemberHome(mycoHome: string): boolean;
export function memberHomeDaemonRefusal(mycoHome: string): string;
export function legacyVaultFiles(source: string): string[];
export function unmovedLegacyVaults(mycoHome: string): string[];
export function legacyHomeDaemonRefusal(mycoHome: string): string;
