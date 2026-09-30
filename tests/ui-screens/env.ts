/** The environment the global setup hands to every screens worker. */
export const SCREENS_ENV = {
  url: 'MYCO_SCREENS_URL',
  ownerCookie: 'MYCO_SCREENS_OWNER_COOKIE',
  memberCookie: 'MYCO_SCREENS_MEMBER_COOKIE',
  /** A GitHub sign-in no member is linked to: it reaches the not-a-member page. */
  strangerCookie: 'MYCO_SCREENS_STRANGER_COOKIE',
  /** `1` when the checks run against the seeded fixture, `0` against a real deployment. */
  fixture: 'MYCO_SCREENS_FIXTURE',
  /** `1` when the launcher served the design specimen under `/specimen/`. */
  specimen: 'MYCO_SCREENS_SPECIMEN',
  pid: 'MYCO_SCREENS_PID',
  /** The fixture's project names, as JSON, for the checks that assert the fixture rendered. */
  projectNames: 'MYCO_SCREENS_PROJECT_NAMES',
  /** The fixture's projects, as JSON `{ projectId, name }` pairs, for the checks that open a project's pages. */
  projects: 'MYCO_SCREENS_PROJECTS',
  /** The fixture's "now", in epoch milliseconds, as the launcher seeded it. */
  now: 'MYCO_SCREENS_NOW',
} as const;

/** The line the launcher prints once the fixture is seeded. */
export interface LaunchInfo {
  url: string;
  ownerCookie: string;
  memberCookie: string;
  strangerCookie: string;
  specimen: boolean;
  projects: Array<{ projectId: string; name: string }>;
  now: number;
}

export function screensEnv(name: keyof typeof SCREENS_ENV): string {
  const value = process.env[SCREENS_ENV[name]];
  if (value === undefined || value === '') throw new Error(`${SCREENS_ENV[name]} is unset; run the checks through tests/ui-screens/playwright.config.ts`);
  return value;
}

/** The time of day, in UTC, the fixture's "now" always falls at: noon in the fixture's time zone in summer, 11:00 in winter. */
const FIXTURE_HOUR_UTC = 16;

/**
 * The fixture's "now": the latest 16:00 UTC at or before `realNow`. Every
 * seeded time is set back from it and the browser's clock is held at it, so
 * relative times and day groups read the same on every run. It follows the real
 * date, and so never falls more than a day behind the server's own clock: the
 * reads the server windows by its own time (capture recency, Needs you) keep
 * finding the seeded rows on any day the checks run. Sign-in cookies and member
 * tokens take the real time, since the server checks them against its own clock.
 */
export function fixtureNowAt(realNow: number): number {
  const date = new Date(realNow);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), FIXTURE_HOUR_UTC);
  return today <= realNow ? today : today - 24 * 3_600_000;
}

/** The fixture's "now" as the launcher seeded it, read from the environment it handed every worker. */
export function fixtureNow(): number {
  const seeded = Number(screensEnv('now'));
  if (!Number.isSafeInteger(seeded)) throw new Error(`${SCREENS_ENV.now} is not an instant`);
  return seeded;
}

/** The browser's time zone and locale on fixture runs, so dates format the same on every machine. */
export const FIXTURE_TIMEZONE = 'America/Detroit';
export const FIXTURE_LOCALE = 'en-US';
