/** The environment the global setup hands to every screens worker. */
export const SCREENS_ENV = {
  url: 'MYCO_SCREENS_URL',
  ownerCookie: 'MYCO_SCREENS_OWNER_COOKIE',
  memberCookie: 'MYCO_SCREENS_MEMBER_COOKIE',
  /** `1` when the checks run against the seeded fixture, `0` against a real deployment. */
  fixture: 'MYCO_SCREENS_FIXTURE',
  /** `1` when the launcher served the design specimen under `/specimen/`. */
  specimen: 'MYCO_SCREENS_SPECIMEN',
  pid: 'MYCO_SCREENS_PID',
} as const;

/** The line the launcher prints once the fixture is seeded. */
export interface LaunchInfo {
  url: string;
  ownerCookie: string;
  memberCookie: string;
  specimen: boolean;
  projects: Array<{ projectId: string; name: string }>;
}

export function screensEnv(name: keyof typeof SCREENS_ENV): string {
  const value = process.env[SCREENS_ENV[name]];
  if (value === undefined || value === '') throw new Error(`${SCREENS_ENV[name]} is unset; run the checks through tests/ui-screens/playwright.config.ts`);
  return value;
}
