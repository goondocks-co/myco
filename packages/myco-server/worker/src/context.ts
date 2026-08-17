export interface RouteContext {
  projectId: string;
  machineId: string | null;
  tokenId: string;
  body: string;
  bodyBytes: number;
  now: number;
}
