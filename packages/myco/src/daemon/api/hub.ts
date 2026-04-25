import { DEFAULT_HUB_URL } from '../../constants/hub.js';
import type { MycoConfig } from '../../config/schema.js';
import { normalizeHubUrl } from '../hub-registration.js';
import type { RouteHandler, RouteResponse } from '../router.js';

const HUB_STATUS_TIMEOUT_MS = 1200;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface HubStatusResponse {
  configured: boolean;
  url: string;
  running: boolean;
  error: string | null;
}

export interface HubStatusDeps {
  liveConfig: { current: Pick<MycoConfig, 'hub'> };
}

export function createHubStatusHandler(deps: HubStatusDeps): RouteHandler {
  return async (): Promise<RouteResponse> => {
    const url = resolveHubUrl(deps.liveConfig.current);
    const status = await checkHubStatus(url);

    return {
      body: {
        configured: true,
        url,
        ...status,
      } satisfies HubStatusResponse,
    };
  };
}

export function resolveHubUrl(config?: Pick<MycoConfig, 'hub'>): string {
  return normalizeHubUrl(process.env.MYCO_HUB_URL ?? config?.hub?.url ?? DEFAULT_HUB_URL);
}

export async function checkHubStatus(url: string): Promise<Pick<HubStatusResponse, 'running' | 'error'>> {
  if (!isSupportedHubUrl(url)) {
    return { running: false, error: 'unsupported_hub_url' };
  }

  try {
    const res = await fetch(new URL('/health', url).toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(HUB_STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return { running: false, error: `http_${res.status}` };

    const body = await res.json().catch(() => null) as { mycoHub?: unknown } | null;
    if (body?.mycoHub !== true) return { running: false, error: 'not_myco_hub' };

    return { running: true, error: null };
  } catch (error) {
    return { running: false, error: error instanceof Error ? error.name : 'hub_unreachable' };
  }
}

function isSupportedHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return LOOPBACK_HOSTS.has(parsed.hostname) || parsed.hostname.startsWith('127.');
  } catch {
    return false;
  }
}
