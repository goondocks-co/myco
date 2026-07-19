/**
 * Team Host — member-side config carve for attached projects (routing-layer §6.3).
 *
 * An attached project is served by a remote host, but its config does NOT proxy
 * wholesale: the member is authoritative for the tiers that describe THIS
 * machine and THIS checkout (machine, project, personal), and only the shared
 * `grove` tier is host-authoritative. Two facts force this handler to exist
 * rather than reusing the `serve` proxy or the plain `local` path:
 *
 *   1. A plain proxy would resolve the member's MACHINE tier from the HOST's
 *      machine tier — the cross-machine resolution parent §6 forbids (guardrail
 *      3). The merged view must be assembled member-side.
 *   2. A plain `local` fall-through would reach `resolveRouteRequestContext`,
 *      which throws `UnknownRequestContextError` (404) for an attached project —
 *      it has no local Grove registry row (routing-layer §1.1). So the config
 *      routes must be handled at the dispatch chokepoint, before that resolver.
 *
 * The chokepoint (`daemon/server.ts`) routes `config_carve` decisions here. The
 * local bearer gate has already run in the chokepoint's inbound pre-parse
 * (`resolveInboundProjectId` → `enforceContextSwitchAuth`), so this handler does
 * not re-authenticate.
 *
 * Reuse over re-implement: reads delegate to the same `handleGetConfig` /
 * `handleGetLocalConfig` the local path uses, the merged read to the new
 * `loadAttachedMergedConfig` primitive, and the scoped WRITE to the same
 * `handlePutScopedConfig` (so the one config write path, `updateConfig`, is
 * preserved) — gated first by `groveTierWriteRefusal` so a personal override of
 * a grove-homed shared-capability leaf is refused host-authoritative.
 */
import type http from 'node:http';

import {
  HOST_PROTOCOL_HEADER,
  HOST_PROTOCOL_VERSION,
  HOST_PROXY_CONNECT_TIMEOUT_MS,
  HOST_PROXY_HEADERS_TIMEOUT_MS,
  HOST_PROXY_MAX_BUFFERED_BODY_BYTES,
} from '../constants.js';
import { loadAttachedMergedConfig } from '../config/loader.js';
import { enumerateLeafPaths } from '../config/leaf-paths.js';
import { REQUEST_CONTEXT_HEADERS } from '../grove/request-context.js';
import { resolveProjectVaultDir } from '../grove/paths.js';
import { resolveAttach } from '../host/registry.js';
import { groveTierWriteRefusal, refusalJson, type RemoteTarget } from '../host/routing.js';
import type { RouteResponse } from './router.js';
import {
  handleGetConfig,
  handleGetLocalConfig,
  handlePutScopedConfig,
} from './api/config.js';
import { defaultDial, logVersionMismatchOnce, type Dialer, type ProxyLogger } from './host-proxy.js';

/** Fired once per host when the grove-tier fetch fails, so the member warns
 *  once rather than on every merged read (routing-layer §6.3 degrade). */
const warnedUnreachableHosts = new Set<string>();

/** Test seam: reset the once-per-host grove-unreachable warn de-dup. */
export function __resetAttachedConfigWarnForTests(): void {
  warnedUnreachableHosts.clear();
}

export interface AttachedConfigDeps {
  /** How the member dials the host for the grove-tier read. Injectable so tests
   *  hit a localhost fixture; production rides the same dialer the proxy uses. */
  dial: Dialer;
  logger: ProxyLogger;
}

function readHeader(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Result of a grove-tier fetch. `doc` is null on any degrade; `versionSkew`
 *  distinguishes a host protocol-version mismatch (loud, already logged) from
 *  plain unreachability, so the caller fires the RIGHT log (routing-layer §5). */
export interface FetchGroveConfigResult {
  doc: Record<string, unknown> | null;
  versionSkew: boolean;
}

/**
 * One-shot GET `/api/grove-config` against the host over the overlay, returning
 * the host's grove-tier config doc (the `config` field of its response) — or a
 * null `doc` on any failure (unreachable, non-2xx, oversized, unparseable) so the
 * caller degrades to grove-tier defaults. Never throws; the whole point is a
 * clean soft-fail. The connect+headers timeout bounds the wait so a merged read
 * never hangs on an unreachable host.
 *
 * A host `409` carrying the `x-myco-host-protocol` header is a version skew, NOT
 * unreachability: it fires the loud once-per-host version-mismatch log (shared
 * with the proxy via `logVersionMismatchOnce`) and returns `versionSkew: true`,
 * still degrading the read to defaults — a read must not hard-fail on skew, and
 * a skew never self-heals by retry.
 */
export function fetchHostGroveConfig(
  target: RemoteTarget,
  dial: Dialer = defaultDial,
  logger?: ProxyLogger,
): Promise<FetchGroveConfigResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: FetchGroveConfigResult): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const degrade = (): void => done({ doc: null, versionSkew: false });

    let dialed: http.ClientRequest | Promise<http.ClientRequest>;
    try {
      dialed = dial(target, {
        method: 'GET',
        path: '/api/grove-config',
        headers: {
          authorization: `Bearer ${target.bearer}`,
          [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
          [REQUEST_CONTEXT_HEADERS.groveId]: target.groveId,
          [REQUEST_CONTEXT_HEADERS.projectId]: target.projectId,
          accept: 'application/json',
        },
      });
    } catch {
      degrade();
      return;
    }

    // The dialer may resolve its tunnel bridge first (`Dialer` union); a dial
    // failure degrades to defaults exactly like the synchronous throw above.
    Promise.resolve(dialed).then((proxyReq) => {
    proxyReq.setTimeout(HOST_PROXY_CONNECT_TIMEOUT_MS + HOST_PROXY_HEADERS_TIMEOUT_MS, () => {
      proxyReq.destroy();
      degrade();
    });
    proxyReq.on('error', () => degrade());
    proxyReq.on('response', (proxyRes) => {
      const status = proxyRes.statusCode ?? 502;
      if (status >= 400) {
        const hostProtocol = proxyRes.headers[HOST_PROTOCOL_HEADER];
        if (status === 409 && hostProtocol !== undefined) {
          const raw = Array.isArray(hostProtocol) ? hostProtocol[0] : hostProtocol;
          const reported = Number(raw);
          if (logger) logVersionMismatchOnce(logger, target, Number.isFinite(reported) ? reported : undefined);
          proxyRes.resume();
          done({ doc: null, versionSkew: true });
          return;
        }
        proxyRes.resume();
        degrade();
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      proxyRes.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > HOST_PROXY_MAX_BUFFERED_BODY_BYTES) {
          proxyRes.destroy();
          degrade();
        } else {
          chunks.push(chunk);
        }
      });
      proxyRes.on('error', () => degrade());
      proxyRes.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { config?: unknown };
          const config = parsed?.config;
          if (config && typeof config === 'object' && !Array.isArray(config)) {
            done({ doc: config as Record<string, unknown>, versionSkew: false });
          } else {
            degrade();
          }
        } catch {
          degrade();
        }
      });
    });
    proxyReq.end();
    }).catch(() => degrade());
  });
}

/** The value-INTRODUCING leaf paths of a scoped-config PUT body (patch leaves +
 *  addToList paths). Clears/removeFromList are exempt from the grove-tier lock,
 *  mirroring the scoped-write scope gate, so stale wrong-tier residue stays
 *  deletable through the same API that created it. */
function valueIntroducingPaths(body: unknown): string[] {
  const payload = (body ?? {}) as {
    patch?: Record<string, unknown>;
    addToList?: Array<{ path?: unknown }>;
  };
  const patch = payload.patch && typeof payload.patch === 'object' && !Array.isArray(payload.patch)
    ? payload.patch
    : {};
  const addPaths = Array.isArray(payload.addToList)
    ? payload.addToList.map((op) => op?.path).filter((p): p is string => typeof p === 'string')
    : [];
  return [...enumerateLeafPaths(patch), ...addPaths];
}

async function computeResponse(
  req: http.IncomingMessage,
  pathname: string,
  vaultDir: string,
  target: RemoteTarget,
  body: unknown,
  deps: AttachedConfigDeps,
): Promise<RouteResponse> {
  if (req.method === 'GET') {
    switch (pathname) {
      case '/api/config':
        // Tolerate a fresh-attach checkout with no myco.yaml (BEHAVE-LIKE-LOCAL,
        // gated on file absence) — a malformed present file still throws → 500.
        return handleGetConfig(vaultDir, { projectTierOptional: true });
      case '/api/config/local':
        // No groveId → skips the legacy local-appearance→grove migration, which
        // would write a local grove config file for the hosted Grove.
        return handleGetLocalConfig(vaultDir);
      case '/api/config/merged': {
        let versionSkew = false;
        const config = await loadAttachedMergedConfig(vaultDir, {
          fetchGroveDoc: async () => {
            const result = await fetchHostGroveConfig(target, deps.dial, deps.logger);
            versionSkew = result.versionSkew;
            return result.doc;
          },
          onGroveUnreachable: (err) => {
            // A version skew already fired its own loud, once-per-host log inside
            // fetchHostGroveConfig — don't ALSO warn "unreachable" for it.
            if (versionSkew) return;
            if (warnedUnreachableHosts.has(target.host.host_id)) return;
            warnedUnreachableHosts.add(target.host.host_id);
            deps.logger.warn('host unreachable for grove-tier config — merged view degraded to grove defaults', {
              host_id: target.host.host_id,
              host_label: target.host.label,
              error: err instanceof Error ? err.message : undefined,
            });
          },
        });
        return { body: config };
      }
      default:
        return { status: 404, body: { error: 'not_found' } };
    }
  }

  if (req.method === 'PUT' && pathname === '/api/config/scoped') {
    // Refine Task 1.2's coarse whole-route lock: the shared-capability leaves a
    // scoped write can still reach are grove-homed personal overrides. Refuse
    // exactly those, host-authoritative; everything else writes locally.
    const refusal = groveTierWriteRefusal(valueIntroducingPaths(body));
    if (refusal) {
      const { status, body: refusalBody } = refusalJson(refusal);
      return { status, body: refusalBody };
    }
    // Fresh-attach tolerance (BEHAVE-LIKE-LOCAL): the local-scope read tolerates
    // an absent project file, and a project-scope write CREATES it from the
    // stand-in via updateConfig({ createIfMissing }) — the user's explicit
    // project-tier write. Gated on file absence inside the loader.
    return handlePutScopedConfig(vaultDir, body, { projectTierOptional: true });
  }

  return { status: 404, body: { error: 'not_found' } };
}

/**
 * Handle a `config_carve` request for an attached project. Resolves the member's
 * vault dir from the `x-myco-project-root` header, falling back to the
 * member-local `root` recorded on the attach record — the browser Settings UI
 * sends only grove/project ids (`ui/src/lib/selection.ts`), never the filesystem
 * path, and an attached project has no local Grove row to resolve it from.
 * Dispatches to the right member-side path and writes the JSON response. `body`
 * is the already-read request body for the scoped PUT (undefined for GETs).
 */
export async function handleAttachedConfigRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  target: RemoteTarget,
  body: unknown,
  deps: AttachedConfigDeps,
): Promise<void> {
  const projectRoot = readHeader(req, REQUEST_CONTEXT_HEADERS.projectRoot)
    ?? resolveAttach(target.projectId)?.ref.root;
  if (!projectRoot) {
    respondJson(res, { status: 400, body: { error: 'missing_project_root' } });
    return;
  }
  const vaultDir = resolveProjectVaultDir(projectRoot);

  try {
    const response = await computeResponse(req, pathname, vaultDir, target, body, deps);
    respondJson(res, response);
  } catch (err) {
    deps.logger.error('attached config request failed', {
      host_id: target.host.host_id,
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    respondJson(res, { status: 500, body: { error: 'attached_config_failed' } });
  }
}

function respondJson(res: http.ServerResponse, response: RouteResponse): void {
  if (res.headersSent) return;
  res.writeHead(response.status ?? 200, { 'Content-Type': 'application/json', ...response.headers });
  res.end(JSON.stringify(response.body));
}
