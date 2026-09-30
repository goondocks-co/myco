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
  /** The fixture's project names, as JSON, for the checks that assert the fixture rendered. */
  projectNames: 'MYCO_SCREENS_PROJECT_NAMES',
  /** The fixture's projects, as JSON `{ projectId, name }` pairs, for the checks that open a project's pages. */
  projects: 'MYCO_SCREENS_PROJECTS',
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

/**
 * The fixture's "now": every seeded time is set back from it, and the browser's
 * clock is held at it, so relative times and day groups read the same on every
 * run. Sign-in cookies and member tokens take the real time, since the server
 * checks them against its own clock.
 */
export const FIXTURE_NOW = Date.UTC(2026, 8, 29, 16, 0, 0);

/** The browser's time zone and locale on fixture runs, so dates format the same on every machine. */
export const FIXTURE_TIMEZONE = 'America/Detroit';
export const FIXTURE_LOCALE = 'en-US';
