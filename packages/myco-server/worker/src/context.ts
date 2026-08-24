import type { RuntimeClaims } from './auth/tokens.js';
import type { OwnerConfig } from './auth/owner/config.js';
import type { OwnerSession } from './auth/owner/cookie.js';

/** Context for a credential-free auth route: the owner configuration and outbound fetch, and deliberately no bindings. */
export interface AuthContext {
  config: OwnerConfig;
  fetchImpl: typeof fetch;
  now: number;
  /** The request's own origin, the OAuth redirect URI is built from it so one deployment never redirects to another. */
  origin: string;
}

/** Context for an owner route: the verified session and the request, after the owner has been authenticated. */
export interface OwnerContext {
  request: Request;
  session: OwnerSession;
  config: OwnerConfig;
  params: Record<string, string>;
  url: URL;
  now: number;
}

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
