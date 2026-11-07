/**
 * What the dashboard's live refresh and the server agree on, with no dependency: the marks the heartbeat
 * (`GET /api/work/now`) reports and a dashboard read may follow, the header every read the dashboard makes on its own
 * carries so it never counts as someone using the Deployment, and the request a person's presence travels on.
 */

/** What moves the heartbeat reports, and a read can follow. */
export const MARKS = ['runs', 'sessions', 'knowledge', 'recovery', 'fleet'] as const;
export type Mark = (typeof MARKS)[number];

/** The heartbeat's marks: each moves when what it names changes. */
export type Marks = Record<Mark, string>;

/** The header every read the dashboard makes on its own carries; the server leaves no activity stamp for it. */
export const AUTOMATIC_HEADER = 'x-myco-automatic';

/** The request that says a person is using the dashboard. */
export const PRESENCE_PATH = '/api/presence';
