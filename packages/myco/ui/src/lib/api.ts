import type { AppearanceValues as AppearanceConfig } from '@myco/config/appearance-values';
import { withBasePath } from './base-path';
import { requestContextHeadersFromSelection } from './selection';

const API_BASE = '/api';
const CONTEXT_FREE_PATHS = [
  '/groves',
  '/version',
  '/logs',
  '/logs/search',
  '/logs/stream',
];

// Injected by Vite's `define` at build time — see vite.config.ts.
declare const __MYCO_UI_VERSION__: string;
const UI_VERSION: string = typeof __MYCO_UI_VERSION__ === 'string' ? __MYCO_UI_VERSION__ : 'dev';

/** Track once-per-session so we don't spam the console on every fetch. */
let versionMismatchWarned = false;
function checkApiVersion(response: Response): void {
  if (versionMismatchWarned) return;
  const apiVersion = response.headers.get('X-Myco-Api-Version');
  if (apiVersion && apiVersion !== UI_VERSION) {
    versionMismatchWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[myco] UI version ${UI_VERSION} is talking to daemon ${apiVersion} — reload to pick up the new UI build.`,
    );
  }
}

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
  const headers = buildHeaders(path, init?.headers, needsContentType);

  const res = await fetch(withBasePath(`${API_BASE}${path}`), {
    ...init,
    headers,
  });
  checkApiVersion(res);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }
  return res.json();
}

function buildHeaders(
  path: string,
  initHeaders: HeadersInit | undefined,
  needsContentType: boolean,
): Headers | undefined {
  const headers = new Headers();
  if (!isContextFreePath(path)) {
    for (const [key, value] of Object.entries(requestContextHeadersFromSelection())) {
      headers.set(key, value);
    }
  }
  if (needsContentType) headers.set('Content-Type', 'application/json');
  if (initHeaders) {
    new Headers(initHeaders).forEach((value, key) => headers.set(key, value));
  }
  return Array.from(headers.keys()).length > 0 ? headers : undefined;
}

function isContextFreePath(path: string): boolean {
  return CONTEXT_FREE_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
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
  clear?: string[],
): Promise<unknown> {
  const body: Record<string, unknown> = { scope, patch };
  if (clear && clear.length > 0) body.clear = clear;
  return putJson<unknown>('/config/scoped', body);
}

export function clearLocalConfigKeys(keys: string[]): Promise<unknown> {
  // Unified scoped write: clear-only request. Empty patch is allowed when
  // clear is non-empty (server validates this).
  return putJson<unknown>('/config/scoped', { scope: 'local', patch: {}, clear: keys });
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
