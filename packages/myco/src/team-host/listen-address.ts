/**
 * The address the Team Host listener binds — loopback, explicitly.
 *
 * Shared by the bind (`daemon/server.ts`) and the Funnel proxy target
 * (`team-host/funnel.ts`) so the two cannot disagree about what is being
 * published. An omitted host would bind every interface and put the team
 * surface on the LAN: a second door beside the Funnel, reachable without the
 * operator ever publishing one.
 */
export const TEAM_LISTEN_ADDRESS = '127.0.0.1';
