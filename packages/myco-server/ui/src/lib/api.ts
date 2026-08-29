/** A refusal or failure answered by the server, carrying the status and the parsed body when there was one. */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`server answered ${status}`);
    this.name = 'ApiError';
  }
}

/** The server answered 401: there is no dashboard session. */
export class SignedOutError extends ApiError {
  constructor() {
    super(401, null);
    this.name = 'SignedOutError';
  }
}

async function bodyOf(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: 'same-origin' });
  if (res.status === 401) throw new SignedOutError();
  const body = await bodyOf(res);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'GET', headers: { accept: 'application/json' }, signal });
}

export function postJson<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** `GET /api/status`. */
export interface StatusResponse {
  schema: { expected: number; found: number | null; matches: boolean };
  capabilities: Capability[];
  projects: ProjectReceipt[];
}

export interface Capability {
  capability: string;
  label: string;
  present: boolean;
  operatorNames: string[];
}

export interface ProjectReceipt {
  projectId: string;
  lastActivityAt: number | null;
  sessionCount: number;
}

/** `GET /api/projects`. */
export interface ProjectSummary {
  projectId: string;
  name: string;
  createdAt: number;
  sessionCount: number;
  lastActivityAt: number | null;
  archivedAt: number | null;
  archivedBy: string | null;
}

/** An archived project refuses capture and stays readable. A row from an older fixture without the field reads as live. */
export const isArchived = (p: Pick<ProjectSummary, 'archivedAt'>): boolean => p.archivedAt != null;

export interface ProjectsResponse {
  projects: ProjectSummary[];
}
