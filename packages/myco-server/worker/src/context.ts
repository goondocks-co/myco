/** Context for a json route: the pipeline has read the body. `machineId` is the token's; the pipeline refuses a token without one before any handler runs. */
export interface RouteContext {
  projectId: string;
  machineId: string;
  tokenId: string;
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
