const API_BASE = '/api';

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

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API error ${status}`);
  }
}
