/**
 * The address the Team Host listener binds — loopback, explicitly.
 *
 * `daemon/server.ts` binds the team listener on it; an omitted host would bind
 * every interface and put the team surface on the LAN: a second door beside
 * the Funnel, reachable without the operator ever publishing one. The Funnel
 * proxy (`team-host/funnel.ts`) targets the same loopback address.
 */
export const TEAM_LISTEN_ADDRESS = '127.0.0.1';
