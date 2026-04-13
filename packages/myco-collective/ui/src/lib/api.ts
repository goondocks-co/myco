import { AuthVerifyResponse, HealthResponse, ProjectsResponse, SearchResponse, SettingsResponse } from './types';

const API_BASE = '/api';
const ADMIN_TOKEN_STORAGE_KEY = 'myco-collective-admin-token';

export function getStoredAdminToken(): string {
  return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)?.trim() ?? '';
}

export function setStoredAdminToken(token: string): void {
  localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token.trim());
}

export function clearStoredAdminToken(): void {
  localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}

function buildHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  const token = getStoredAdminToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const method = init?.method?.toUpperCase();
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    const detail = typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error: unknown }).error)
      : null;
    super(detail ? `${detail} (API ${status})` : `API error ${status}`);
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: buildHeaders(init),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, body);
  }

  return response.json() as Promise<T>;
}

export function fetchHealth(): Promise<HealthResponse> {
  return fetch('/health').then(async (response) => {
    if (!response.ok) throw new ApiError(response.status, {});
    return response.json() as Promise<HealthResponse>;
  });
}

export function verifyAdminToken(): Promise<AuthVerifyResponse> {
  return requestJson<AuthVerifyResponse>('/auth/verify', { method: 'POST' });
}

export function fetchProjects(): Promise<ProjectsResponse> {
  return requestJson<ProjectsResponse>('/projects');
}

export function addProject(body: {
  name: string;
  worker_url: string;
  api_key: string;
  capabilities?: string[];
  package_version?: string;
  schema_version?: number;
}): Promise<Record<string, unknown>> {
  return requestJson<Record<string, unknown>>('/projects', { method: 'POST', body: JSON.stringify(body) });
}

export function deleteProject(projectId: string): Promise<Record<string, unknown>> {
  return requestJson<Record<string, unknown>>(`/projects/${projectId}`, { method: 'DELETE' });
}

export function configureProject(projectId: string): Promise<Record<string, unknown>> {
  return requestJson<Record<string, unknown>>(`/projects/${projectId}/configure`, { method: 'POST' });
}

export function fetchSettings(): Promise<SettingsResponse> {
  return requestJson<SettingsResponse>('/settings');
}

export function upsertSetting(body: {
  key: string;
  value: unknown;
  description?: string;
  updated_by?: string;
}): Promise<Record<string, unknown>> {
  return requestJson<Record<string, unknown>>('/settings', { method: 'PUT', body: JSON.stringify(body) });
}

export function runSearch(body: { tool: 'collective_search'; args: { query: string; project?: string; limit?: number } }): Promise<SearchResponse> {
  return requestJson<SearchResponse>('/query', { method: 'POST', body: JSON.stringify(body) });
}
