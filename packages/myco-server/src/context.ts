import type { OutboundFetch } from './core/adapters.js';
import type { RuntimeClaims } from './auth/tokens.js';
import type { HeldRun } from './core/runs.js';
import type { OwnerConfig } from './auth/owner/config.js';
import type { OwnerSession } from './auth/owner/cookie.js';
import type { DashboardMember } from './auth/identity-link.js';

/** Context for a credential-free auth route: the owner configuration and outbound fetch, and deliberately no bindings. */
export interface AuthContext {
  config: OwnerConfig;
  fetchImpl: OutboundFetch;
  now: number;
  /** The request's own origin, the OAuth redirect URI is built from it so one deployment never redirects to another. */
  origin: string;
}

/** Context for an owner route: the verified session, the member its account is linked to, and the request. */
export interface OwnerContext {
  request: Request;
  session: OwnerSession;
  /** The member the session's GitHub account is linked to. Every owner route runs for a member. */
  member: DashboardMember;
  config: OwnerConfig;
  params: Record<string, string>;
  url: URL;
  now: number;
}

/** Context for the two routes that serve a signed-in account ahead of membership: `member` is null for an account no member is linked to. */
export type SessionContext = Omit<OwnerContext, 'member'> & { member: DashboardMember | null };

/** Context for a json route: the pipeline has read the body. `machineId` is the token's; the pipeline refuses a token without one before any handler runs. The token's lifetime and lineage travel with it for the refresh route. */
export interface RouteContext {
  projectId: string;
  /** The member the presented credential belongs to. */
  memberId: string;
  machineId: string;
  tokenId: string;
  expiresAt: number;
  lineageRoot: string;
  lineageStartedAt: number;
  /** The runtime binding the presented credential carries. A refresh hands it to the successor unchanged; nothing admits or refuses on it. */
  runtime: RuntimeClaims;
  body: string;
  bodyBytes: number;
  now: number;
  /** The request's own origin: where a runtime this request dispatches calls back to, so one Deployment never sends its runtime to another. */
  origin: string;
}

/**
 * Context for a Deployment-scoped route: a worker's claim, lease and end.
 *
 * There is no `projectId`, and that absence is the point. A worker claims from
 * one queue across every Project the Deployment holds, so it can name no Project
 * ahead of the row it is given; the Project travels back in the answer, read off
 * the run the claim took. Nothing here resolves a Project into existence and
 * nothing is charged to a member's capture quota.
 */
export interface DeploymentContext {
  /** The member holding the presented credential; the pipeline has already admitted it as an admin. */
  memberId: string;
  machineId: string;
  tokenId: string;
  body: string;
  now: number;
  /** The server clock for lease checks after asynchronous work. */
  clock: () => number;
}

/** Context for a json route reached over a run's credential: the live run the credential dispatched, the run's own Project — the request's, whatever the header named — and the body the pipeline read. Nothing of a person travels here. */
export interface RunContext {
  projectId: string;
  run: HeldRun;
  tokenId: string;
  body: string;
  now: number;
}

/** Context for a route reached over an External Agent grant: the grant's Project, the grant, and the body the pipeline read. Nothing of a member travels here; the grant records what it found under its own name, and its volume is held by the limiter keyed on the grant and by the grant's expiry. */
export interface GrantContext {
  projectId: string;
  grantId: string;
  body: string;
  now: number;
}

/** Context for a stream route: the pipeline has not read the body; the handler streams it. */
export interface StreamContext {
  projectId: string;
  machineId: string;
  tokenId: string;
  now: number;
  /** The server clock, read at the moment of the call; `now` is the single reading taken at this request's admission. */
  clock: () => number;
  /** The declared body length; required on stream routes and bounded by the route's cap before the handler runs. */
  contentLength: number;
  /** Named captures of the route's path pattern. */
  params: Record<string, string>;
}
