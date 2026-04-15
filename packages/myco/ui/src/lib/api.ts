import type { AppearanceValues as AppearanceConfig } from '@myco/config/appearance-values';

const API_BASE = '/api';

// ---------------------------------------------------------------------------
// Appearance / scoped-config types
// ---------------------------------------------------------------------------

export type AppearanceValues = AppearanceConfig;

export interface MergedConfigShape {
  appearance: AppearanceConfig;
  [key: string]: unknown;
}

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  // Only set Content-Type for methods with a body (POST, PUT)
  const method = init?.method?.toUpperCase();
  const needsContentType = method === 'POST' || method === 'PUT';
  const headers = needsContentType
    ? { 'Content-Type': 'application/json', ...init?.headers }
    : init?.headers;

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }
  return res.json();
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  return fetchJson(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}

export async function putJson<T>(path: string, body: unknown): Promise<T> {
  return fetchJson(path, { method: 'PUT', body: JSON.stringify(body) });
}

export async function deleteJson<T>(path: string): Promise<T> {
  return fetchJson(path, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Scoped config fetchers (used by AppearanceProvider)
// ---------------------------------------------------------------------------

export function fetchMergedConfig(signal?: AbortSignal): Promise<MergedConfigShape> {
  return fetchJson<MergedConfigShape>('/config/merged', { signal });
}

export function fetchLocalConfig(signal?: AbortSignal): Promise<Partial<MergedConfigShape>> {
  return fetchJson<Partial<MergedConfigShape>>('/config/local', { signal });
}

export function writeScopedConfig(
  scope: 'project' | 'local',
  patch: Record<string, unknown>,
): Promise<unknown> {
  return putJson<unknown>('/config/scoped', { scope, patch });
}

export function clearLocalConfigKeys(keys: string[]): Promise<unknown> {
  return postJson<unknown>('/config/local/clear', { keys });
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    // Include the server's error message if present so UI callers that
    // only render err.message still surface the actual failure reason.
    const detail = typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error: unknown }).error)
      : null;
    super(detail ? `${detail} (API ${status})` : `API error ${status}`);
  }
}
