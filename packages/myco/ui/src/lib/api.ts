import type { AppearanceValues as AppearanceConfig } from '@myco/config/appearance-values';
import { withBasePath } from './base-path';
import { requestContextHeadersFromSelection } from './selection';
import { readClientActivity } from './client-activity';

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
  // Set Content-Type whenever a body is present, regardless of method.
  const method = init?.method?.toUpperCase();
  const hasBody = init?.body !== undefined && init.body !== null;
  const needsContentType = hasBody || method === 'POST' || method === 'PUT';
  const headers = buildHeaders(path, init?.headers, needsContentType);

  const res = await fetch(withBasePath(`${API_BASE}${path}`), {
    ...init,
    headers,
  });
  checkApiVersion(res);
  if (!res.ok) {
    const body = await parseResponseBody<unknown>(res).catch(() => ({}));
    maybeReloadForStaleAuth(res.status, body);
    throw new ApiError(res.status, body);
  }
  return parseResponseBody<T>(res);
}

async function parseResponseBody<T>(res: Response): Promise<T> {
  if (res.status === 204 || res.status === 205 || res.headers.get('Content-Length') === '0') {
    return undefined as T;
  }
  if (typeof res.text === 'function') {
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }
  return res.json() as Promise<T>;
}

/**
 * The daemon mints a fresh `auth_token` on every process start and injects
 * it into the dashboard HTML via `window.__MYCO_AUTH__` (see
 * `daemon/server.ts:injectDashboardBootstrap`). When the daemon restarts
 * mid-session — auto-update, manual restart, crash-recovery — the in-page
 * token goes stale and every subsequent API call returns
 * 401 `unauthorized_context_switch`. The token can only be refreshed by
 * re-fetching the HTML, so the recovery is a page reload.
 *
 * Reload is gated on sessionStorage so a genuinely-down daemon (returning
 * 401 indefinitely) doesn't loop the page.
 */
const AUTH_RELOAD_TIMESTAMP_KEY = 'myco:auth-reload-ts';
const AUTH_RELOAD_COOLDOWN_MS = 10_000;

let reloadPageImpl: () => void = () => { window.location.reload(); };

/** Test seam: override the reload action. Restore by calling without args. */
export function __setReloadPageForTests(impl?: () => void): void {
  reloadPageImpl = impl ?? (() => { window.location.reload(); });
}

function maybeReloadForStaleAuth(status: number, body: unknown): void {
  if (status !== 401) return;
  const errorCode = apiErrorCode(body);
  if (errorCode !== 'unauthorized_context_switch') return;
  if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') return;

  try {
    const last = Number(window.sessionStorage.getItem(AUTH_RELOAD_TIMESTAMP_KEY) ?? '0');
    if (Number.isFinite(last) && Date.now() - last < AUTH_RELOAD_COOLDOWN_MS) {
      // Recently reloaded; the new token also got rejected → daemon is
      // genuinely unreachable (down, wrong port, network). Let the UI
      // show the error instead of looping the page.
      return;
    }
    window.sessionStorage.setItem(AUTH_RELOAD_TIMESTAMP_KEY, String(Date.now()));
  } catch {
    // sessionStorage write may throw under privacy modes; skip reload.
    return;
  }
  reloadPageImpl();
}

/**
 * Daemon-issued bearer token, injected into index.html by the static
 * handler in `daemon/server.ts:injectDashboardBootstrap`. Required by
 * `enforceContextSwitchAuth` whenever the request carries
 * `x-myco-grove-id` or `x-myco-project-id` headers.
 */
function getDaemonAuthToken(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const token = (window as unknown as { __MYCO_AUTH__?: string }).__MYCO_AUTH__;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
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
    const token = getDaemonAuthToken();
    if (token) headers.set('x-myco-auth', token);
  }
  // Deliberately OUTSIDE the context-free guard. `/logs/stream` is a
  // context-free path and is also the live log poller — the one query most
  // likely to run unattended. Setting this inside the guard would leave it
  // unclassified, and an unclassified request counts as interaction, so the
  // Logs page alone would pin the daemon awake forever.
  headers.set('x-myco-client-activity', readClientActivity());
  if (needsContentType) headers.set('Content-Type', 'application/json');
  if (initHeaders) {
    new Headers(initHeaders).forEach((value, key) => headers.set(key, value));
  }
  return Array.from(headers.keys()).length > 0 ? headers : undefined;
}

function isContextFreePath(path: string): boolean {
  return CONTEXT_FREE_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export async function postJson<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
  // `init` (headers) parity with putJson — the External-access controls
  // carry `x-myco-host-id`, and a POST that structurally cannot carry
  // headers was how Rotate token reached the wrong host (E1 §5.3 rev 6).
  return fetchJson(path, { ...init, method: 'POST', body: body ? JSON.stringify(body) : undefined });
}

export async function putJson<T>(path: string, body: unknown, init?: RequestInit): Promise<T> {
  return fetchJson(path, { ...init, method: 'PUT', body: JSON.stringify(body) });
}

export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  return fetchJson(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deleteJson<T>(path: string, body?: unknown): Promise<T> {
  return fetchJson(path, {
    method: 'DELETE',
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Scoped config fetchers
// ---------------------------------------------------------------------------

export function fetchMergedConfig(signal?: AbortSignal, headers?: HeadersInit): Promise<MergedConfigShape> {
  return fetchJson<MergedConfigShape>('/config/merged', { signal, headers });
}

export function fetchLocalConfig(signal?: AbortSignal, headers?: HeadersInit): Promise<Partial<MergedConfigShape>> {
  return fetchJson<Partial<MergedConfigShape>>('/config/local', { signal, headers });
}

export function writeScopedConfig(
  scope: 'project' | 'local',
  patch: Record<string, unknown>,
  clear?: string[],
  headers?: HeadersInit,
): Promise<unknown> {
  const body: Record<string, unknown> = { scope, patch };
  if (clear && clear.length > 0) body.clear = clear;
  return putJson<unknown>('/config/scoped', body, { headers });
}

export function clearLocalConfigKeys(keys: string[], headers?: HeadersInit): Promise<unknown> {
  // Unified scoped write: clear-only request. Empty patch is allowed when
  // clear is non-empty (server validates this).
  return putJson<unknown>('/config/scoped', { scope: 'local', patch: {}, clear: keys }, { headers });
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    // Include the server's error message if present so UI callers that
    // only render err.message still surface the actual failure reason.
    const detail = apiErrorMessage(body);
    super(detail ? `${detail} (API ${status})` : `API error ${status}`);
  }
}

function apiErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const error = (body as { error: unknown }).error;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function apiErrorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  if ('error' in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === 'string') {
      // Flat refusal envelope ({ error: '<code>', message: '<human text>' },
      // the host-admin/routing shape): the code is for programs — the
      // SIBLING message is the operator guidance, and returning the code
      // here rendered `daemon_home_unsafe (API 500)` at the user while the
      // actionable text was discarded (PR 4 review, C5; UI-copy doctrine).
      const sibling = 'message' in body ? (body as { message: unknown }).message : null;
      if (typeof sibling === 'string' && sibling.length > 0) return sibling;
      return error;
    }
    if (typeof error === 'object' && error !== null) {
      const message = 'message' in error ? (error as { message: unknown }).message : null;
      if (typeof message === 'string' && message.length > 0) return message;
      const code = 'code' in error ? (error as { code: unknown }).code : null;
      if (typeof code === 'string' && code.length > 0) return code;
    }
  }
  const message = 'message' in body ? (body as { message: unknown }).message : null;
  return typeof message === 'string' && message.length > 0 ? message : null;
}
