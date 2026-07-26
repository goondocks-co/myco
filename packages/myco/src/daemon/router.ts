import type { IncomingHttpHeaders } from 'node:http';
import type { MycoRequestContext } from '@myco/grove/request-context.js';

export interface RouteRequest {
  body: unknown;
  query: Record<string, string>;
  params: Record<string, string>;
  pathname: string;
  headers?: IncomingHttpHeaders;
  requestContext?: MycoRequestContext;
  /**
   * True when the request arrived on the overlay listener rather than
   * localhost — a remote member, not the operator at their own dashboard.
   *
   * Route stamps classify what a route IS; they cannot constrain what a handler
   * READS. A handler that enumerates or selects data independently of
   * `requestContext` needs this to narrow itself, because the stamp gate above
   * it has already let the request through.
   */
  isOverlay?: boolean;
}

export interface RouteResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (req: RouteRequest) => Promise<RouteResponse>;

/**
 * Minimal surface a route-registrar module needs from the daemon server. Shared
 * by the per-domain registrars under `daemon/routes/` so the registration shape
 * lives in one place as more route groups are extracted from `main.ts`.
 */
export interface RouteRegistrar {
  registerRoute(method: string, routePath: string, handler: RouteHandler): void;
}

interface RouteEntry {
  method: string;
  pattern: string;
  handler: RouteHandler;
  type: 'exact' | 'param' | 'prefix';
  segments?: string[];
}

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
  query: Record<string, string>;
  pathname: string;
}

export class Router {
  private routes: RouteEntry[] = [];

  add(method: string, pattern: string, handler: RouteHandler): void {
    const type = pattern.includes(':') ? 'param'
               : pattern.endsWith('/*') ? 'prefix'
               : 'exact';
    const segments = type === 'param' ? pattern.split('/') : undefined;
    this.routes.push({ method, pattern, handler, type, segments });
  }

  /**
   * Match a request against registered routes.
   * Priority: exact > parameterized > prefix. Within parameterized routes,
   * first-registered wins if multiple patterns match at the same depth.
   */
  match(method: string, rawUrl: string): RouteMatch | undefined {
    const url = new URL(rawUrl, 'http://localhost');
    const pathname = url.pathname;
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });

    // Priority: exact > param > prefix
    let paramMatch: RouteMatch | undefined;
    let prefixMatch: RouteMatch | undefined;

    for (const route of this.routes) {
      if (route.method !== method) continue;

      if (route.type === 'exact' && route.pattern === pathname) {
        return { handler: route.handler, params: {}, query, pathname };
      }

      if (route.type === 'param' && !paramMatch && route.segments) {
        const parts = pathname.split('/');
        if (parts.length === route.segments.length) {
          const params: Record<string, string> = {};
          let matched = true;
          for (let i = 0; i < route.segments.length; i++) {
            if (route.segments[i].startsWith(':')) {
              params[route.segments[i].slice(1)] = parts[i];
            } else if (route.segments[i] !== parts[i]) {
              matched = false;
              break;
            }
          }
          if (matched) {
            paramMatch = { handler: route.handler, params, query, pathname };
          }
        }
      }

      if (route.type === 'prefix' && !prefixMatch) {
        const prefix = route.pattern.slice(0, -1); // Remove trailing *
        if (pathname.startsWith(prefix)) {
          prefixMatch = { handler: route.handler, params: {}, query, pathname };
        }
      }
    }

    return paramMatch ?? prefixMatch;
  }
}
