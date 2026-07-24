/**
 * `team-write` route class — the served grove's team config/secrets, reached
 * by a member through their own daemon (server-mode design spec §6).
 *
 * These routes are registered on EVERY daemon, but only ever answer for real
 * on the ONE machine that is a Team Host: elsewhere `deps.hostServe` is
 * `null` (or undesignated) and every handler refuses `not_serving`. On a
 * member daemon, `host/routing.ts`'s `team-write` stamp proxies the request
 * to the host BEFORE it reaches this module at all — the member's own copy
 * of this handler never actually runs for an attached project.
 *
 *   GET/PUT   /api/team/config              — served grove's grove-tier config
 *   PUT/DELETE /api/team/secrets/:provider   — write-only, masked-echo-only
 *   POST      /api/team/mcp-token/rotate     — Task 10's external-MCP token seam
 *   GET       /api/team/external-mcp         — external MCP toggle/port/tokenHash status
 *   PUT       /api/team/external-mcp/toggle  — enable (mint-if-absent + bind + funnel on) /
 *                                               disable (funnel off + unbind) Task 10's listener
 *
 * The per-task table's team-write routes (`GET/PUT
 * /api/team/agent-tasks/:id/config`, spec §6.3) live in the sibling module
 * `team-agent-tasks.ts` — they reuse `resolveServedGroveIdOrRefusal`/
 * `isRefusal` exported below rather than duplicating the derivation.
 *
 * Config writes funnel through the SAME `handlePutGroveConfig` /
 * `updateTierConfigRaw` pipeline `PUT /api/grove-config` uses (single-write-path
 * rule) — this module adds no parallel YAML writer. Secrets never touch YAML:
 * they go straight to the served grove's `secrets.env` via `writeSecret`,
 * under the PROVIDER-STANDARD env name `KEYED_CLOUD_PROVIDER_ENV` declares
 * (`agent/harness/provider-health.ts`) — the SAME mapping `missingKeyReason`/
 * `probeProviderAvailable` read at dispatch time, so a key written here is
 * guaranteed to be a key a real scheduled run can actually find.
 */
import crypto from 'node:crypto';
import path from 'node:path';

import { loadMachineConfig, saveMachineConfig } from '../../config/loader.js';
import {
  deleteSecrets,
  readSecrets,
  writeSecret,
  writeSecretIfAbsent,
} from '@myco/config/secrets.js';
import { normalizeRawSecretInput } from '@myco/daemon/api/secret-input.js';
import { ExternalMcpSchema } from '../../config/schema.js';
import { resolveGroveDir, resolveMycoHome } from '../../grove/paths.js';
import { KEYED_CLOUD_PROVIDER_ENV } from '../../agent/harness/provider-health.js';
import { EXTERNAL_MCP_DEFAULT_PORT, HOST_EXTERNAL_MCP_TOKEN_SECRET } from '../../constants.js';
import type { HostServeRuntime, ServedGroveKeyHealth } from '../host-serve.js';
import { resolveServedGroveKeyHealthIsolated } from '../host-serve.js';
import type { FunnelRunner } from '../external-listener.js';
import { handleGetGroveConfig, handlePutGroveConfig } from './config.js';
import { errorBody } from './error-envelope.js';
import type { RouteRegistrar, RouteRequest, RouteResponse } from '../router.js';
import {
  LifecycleLock,
  type LockHandle,
} from '@myco/utils/lifecycle-lock.js';
import {
  physicalPathIdentity,
  physicalPathLockIdentities,
} from '@myco/utils/physical-path-identity.js';
import { resolvePerUserLocksDir } from '@myco/utils/user-lock-root.js';

const SECRET_PREVIEW_PREFIX_CHARS = 8;
const SECRET_PREVIEW_SUFFIX_CHARS = 4;
const EXTERNAL_MCP_ACTIVATION_LOCK_RETRIES = 8;
const externalMcpActivationQueues = new Map<string, Promise<void>>();

class ExternalMcpActivationBusyError extends Error {
  constructor() {
    super('Another external MCP activation is already in progress.');
    this.name = 'ExternalMcpActivationBusyError';
  }
}

class ExternalMcpBindError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'ExternalMcpBindError';
  }
}

function requireFunnelSuccess(
  result: Awaited<ReturnType<FunnelRunner>>,
  operation: string,
): void {
  if (!result.ok) throw new Error(`${operation}: ${result.detail}`);
}

function externalMcpActivationLockPaths(mycoHome: string): string[] {
  const lockDir = path.join(resolvePerUserLocksDir(), 'external-mcp-activation');
  return physicalPathLockIdentities(mycoHome)
    .map((identity) => {
      const key = crypto.createHash('sha256')
        .update(`external-mcp-activation\0${identity}`)
        .digest('hex');
      return path.join(lockDir, `${key}.lock`);
    })
    .sort();
}

function releaseExternalMcpActivationLocks(locks: LockHandle[]): void {
  for (const lock of locks.reverse()) lock.release();
}

async function withExternalMcpActivationFileLocks<T>(
  mycoHome: string,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < EXTERNAL_MCP_ACTIVATION_LOCK_RETRIES; attempt += 1) {
    const paths = externalMcpActivationLockPaths(mycoHome);
    const locks: LockHandle[] = [];
    try {
      for (const lockPath of paths) {
        const result = LifecycleLock.acquire(lockPath, {
          command: 'myco external-mcp activation',
        });
        if (!result.acquired) throw new ExternalMcpActivationBusyError();
        locks.push(result.lock);
      }
    } catch (error) {
      releaseExternalMcpActivationLocks(locks);
      throw error;
    }

    const freshPaths = externalMcpActivationLockPaths(mycoHome);
    if (freshPaths.length !== paths.length
      || freshPaths.some((lockPath, index) => lockPath !== paths[index])) {
      releaseExternalMcpActivationLocks(locks);
      continue;
    }

    try {
      return await fn();
    } finally {
      releaseExternalMcpActivationLocks(locks);
    }
  }
  throw new Error('External MCP activation lock identity did not stabilize.');
}

async function withExternalMcpActivation<T>(
  mycoHome: string,
  fn: () => Promise<T>,
): Promise<T> {
  const queueKey = physicalPathIdentity(mycoHome);
  const previous = externalMcpActivationQueues.get(queueKey) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = previous.then(() => current, () => current);
  externalMcpActivationQueues.set(queueKey, tail);
  await previous.catch(() => {});
  try {
    return await withExternalMcpActivationFileLocks(mycoHome, fn);
  } finally {
    releaseQueue();
    if (externalMcpActivationQueues.get(queueKey) === tail) {
      externalMcpActivationQueues.delete(queueKey);
    }
  }
}

/** First-8+last-4 masking — the ONE shape every team-write secret response
 *  echoes (server-mode design spec §5/§6: masked echo only, never the raw
 *  value). Mirrors the same pattern already duplicated at
 *  `daemon/api/provider-secrets.ts` and `myco-team/host/cli.ts`; kept local
 *  rather than shared across those because the format itself, not the
 *  function, is the load-bearing contract the leak-guard test pins. */
function maskSecret(secret: string): string {
  if (secret.length <= SECRET_PREVIEW_PREFIX_CHARS + SECRET_PREVIEW_SUFFIX_CHARS) {
    return '*'.repeat(secret.length);
  }
  return `${secret.slice(0, SECRET_PREVIEW_PREFIX_CHARS)}${'*'.repeat(secret.length - SECRET_PREVIEW_PREFIX_CHARS - SECRET_PREVIEW_SUFFIX_CHARS)}${secret.slice(-SECRET_PREVIEW_SUFFIX_CHARS)}`;
}

/** Non-cryptographic change-detection hash — mirrors the worker's proven
 *  `getMcpTokenHash` (`packages/myco-team/worker/src/mcp/auth.ts`, cited by
 *  server-mode design spec §7): NEVER the raw token, just enough signal for a
 *  UI to notice "the token changed" without the value ever appearing in a
 *  response — including over the flat-trust overlay this route is reached
 *  through. */
function nonSecretTokenHash(token: string): string {
  let hash = 0;
  for (let i = 0; i < token.length; i += 1) {
    hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8);
}

type KeyedCloudProvider = keyof typeof KEYED_CLOUD_PROVIDER_ENV;

function isKeyedCloudProvider(value: string): value is KeyedCloudProvider {
  return Object.prototype.hasOwnProperty.call(KEYED_CLOUD_PROVIDER_ENV, value);
}

/** The env name a NEW key is written under — the first (provider-standard)
 *  entry in `KEYED_CLOUD_PROVIDER_ENV`. Additional entries are read-only
 *  legacy aliases a real dispatch also checks, never a second write target. */
function providerWriteEnvKey(provider: KeyedCloudProvider): string {
  return KEYED_CLOUD_PROVIDER_ENV[provider]![0];
}

function unknownProviderResponse(): RouteResponse {
  return {
    status: 400,
    body: errorBody(
      'unknown_provider',
      `provider must be one of: ${Object.keys(KEYED_CLOUD_PROVIDER_ENV).join(', ')}`,
    ),
  };
}

/**
 * The listener control surface the enable/disable toggle drives, structurally
 * matching `daemon/external-listener.ts`'s `ExternalMcpListener` (imported
 * only as a type there — this module never constructs a listener itself,
 * `daemon/main.ts` owns the one live instance and threads it in here).
 */
export interface ExternalMcpListenerControl {
  bind(port: number): Promise<{ ok: true; port: number } | { ok: false; error: string }>;
  unbind(): Promise<void>;
  readonly isBound: boolean;
  readonly port: number;
}

export interface TeamConfigRouteDeps {
  /** This machine's resolved host-serve runtime, or `null` when this machine
   *  is not a Team Host (or is disabled/misconfigured) — every handler below
   *  refuses `not_serving` in that case, never guesses a Grove. */
  hostServe: HostServeRuntime | null;
  mycoHome?: string;
  /**
   * Fired after a successful `PUT /api/team/config` write with the touched
   * dot-paths and the served grove id, so the daemon can run the SAME
   * config-write-reaction pipeline `PUT /api/grove-config` fires (live-config
   * refresh, notifications) — mirrors `ConfigRouteDeps.onScopedWrite`.
   */
  onConfigWrite?: (touchedPaths: string[], groveId: string) => Promise<void> | void;
  /**
   * Task 10's external MCP toggle wiring — the live listener to bind/unbind
   * and the injectable Funnel runner. Optional so the config/token-mint
   * logic stays unit-testable without standing up a real listener; every
   * production daemon (`daemon/main.ts`) threads both through.
   */
  externalMcp?: {
    listener: ExternalMcpListenerControl;
    runFunnel: FunnelRunner;
  };
}

/** The served grove id, or the `not_serving` refusal when this machine isn't
 *  designated to serve one. Every handler below starts here — deriving the
 *  Grove from `hostServe.servedGroveId` (never a request header) is what
 *  makes "team config" mean THE served grove regardless of which project a
 *  caller's request happens to carry in context. Exported so sibling
 *  team-write modules (`team-agent-tasks.ts`) share the SAME derivation
 *  rather than re-implementing it. */
export function resolveServedGroveIdOrRefusal(deps: TeamConfigRouteDeps): string | RouteResponse {
  const groveId = deps.hostServe?.servedGroveId;
  if (!groveId) {
    return {
      status: 404,
      body: errorBody('not_serving', 'This host is not designated to serve any Grove.'),
    };
  }
  return groveId;
}

export function isRefusal(value: string | RouteResponse): value is RouteResponse {
  return typeof value !== 'string';
}

// ---------------------------------------------------------------------------
// GET/PUT /api/team/config
// ---------------------------------------------------------------------------

/** GET /api/team/config — the served grove's config, plus its key-health
 *  status (server-mode design spec §5's "no team key configured" signal,
 *  computed via the env-isolated wrapper since this route is polled). */
export async function handleGetTeamConfig(deps: TeamConfigRouteDeps): Promise<RouteResponse> {
  const groveIdOrRefusal = resolveServedGroveIdOrRefusal(deps);
  if (isRefusal(groveIdOrRefusal)) return groveIdOrRefusal;
  const groveId = groveIdOrRefusal;
  const mycoHome = deps.mycoHome ?? resolveMycoHome();

  const base = await handleGetGroveConfig(groveId);
  const keyHealth: ServedGroveKeyHealth = resolveServedGroveKeyHealthIsolated(
    loadMachineConfig(mycoHome),
    mycoHome,
  );
  const body = (base.body ?? {}) as Record<string, unknown>;
  return { ...base, body: { ...body, keyHealth: keyHealth.kind } };
}

/** PUT /api/team/config — patches the served grove's config through the
 *  SAME single write path `PUT /api/grove-config` uses. Returns the touched
 *  leaf paths + served grove id so the caller can fire config-write reactions. */
export async function handlePutTeamConfig(
  deps: TeamConfigRouteDeps,
  body: unknown,
): Promise<{ response: RouteResponse; touchedPaths: string[]; groveId: string | null }> {
  const groveIdOrRefusal = resolveServedGroveIdOrRefusal(deps);
  if (isRefusal(groveIdOrRefusal)) return { response: groveIdOrRefusal, touchedPaths: [], groveId: null };
  const groveId = groveIdOrRefusal;

  const { response, touchedPaths } = await handlePutGroveConfig(groveId, body);
  return { response, touchedPaths, groveId: touchedPaths.length > 0 ? groveId : null };
}

// ---------------------------------------------------------------------------
// PUT/DELETE /api/team/secrets/:provider
// ---------------------------------------------------------------------------

interface TeamSecretResponseBody {
  provider: string;
  maskedValue: string | null;
}

/** PUT /api/team/secrets/:provider — stores the raw value in the served
 *  grove's `secrets.env` under the provider-standard env name; echoes ONLY
 *  the masked (first-8+last-4) form. Never returns the raw value. */
export async function handlePutTeamSecret(
  deps: TeamConfigRouteDeps,
  provider: string | undefined,
  body: unknown,
): Promise<RouteResponse> {
  const groveIdOrRefusal = resolveServedGroveIdOrRefusal(deps);
  if (isRefusal(groveIdOrRefusal)) return groveIdOrRefusal;
  if (!provider || !isKeyedCloudProvider(provider)) return unknownProviderResponse();

  const payload = (body ?? {}) as { secret?: unknown; api_key?: unknown };
  const raw = typeof payload.secret === 'string'
    ? payload.secret
    : typeof payload.api_key === 'string'
      ? payload.api_key
      : undefined;
  const envKey = providerWriteEnvKey(provider);
  const normalized = normalizeRawSecretInput(
    envKey,
    raw,
    { status: 400, body: errorBody('missing_secret', 'secret is required') },
  );
  if (!normalized.ok) return normalized.response;
  const secret = normalized.value;

  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const groveDir = resolveGroveDir(groveIdOrRefusal, mycoHome);
  writeSecret(groveDir, envKey, secret);

  const responseBody: TeamSecretResponseBody = { provider, maskedValue: maskSecret(secret) };
  return { body: responseBody };
}

/** DELETE /api/team/secrets/:provider — removes every known env alias for
 *  the provider from the served grove's `secrets.env` (not just the
 *  write-canonical name), so a key stored under a legacy/hand-edited name
 *  can't linger and keep the provider looking configured. */
export async function handleDeleteTeamSecret(
  deps: TeamConfigRouteDeps,
  provider: string | undefined,
): Promise<RouteResponse> {
  const groveIdOrRefusal = resolveServedGroveIdOrRefusal(deps);
  if (isRefusal(groveIdOrRefusal)) return groveIdOrRefusal;
  if (!provider || !isKeyedCloudProvider(provider)) return unknownProviderResponse();

  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const groveDir = resolveGroveDir(groveIdOrRefusal, mycoHome);
  deleteSecrets(groveDir, KEYED_CLOUD_PROVIDER_ENV[provider] ?? []);

  const responseBody: TeamSecretResponseBody = { provider, maskedValue: null };
  return { body: responseBody };
}

// ---------------------------------------------------------------------------
// POST /api/team/mcp-token/rotate
// ---------------------------------------------------------------------------

/**
 * POST /api/team/mcp-token/rotate — the thin, tested seam Task 10's external
 * read-only MCP listener consumes (server-mode design spec §7): mint a FRESH
 * server-side ≥122-bit token (always new — never reuses the previous value),
 * store it beside the serve bearer in MACHINE `secrets.env` (never the
 * Grove — this token gates the machine's external listener, not a Grove
 * capability). Any team member (bearer-holding, over the overlay) may rotate
 * it (flat-trust model, spec §7).
 *
 * Returns the raw token ONE TIME, in this response, alongside the non-secret
 * change-detection hash — a token that is never revealed is unusable, since
 * the rotating member must hand it to the external agent they're
 * configuring. This is the deliberate, sole reveal surface for a rotate
 * (mirrored by `handlePutExternalMcpToggle`'s enable branch, the other
 * mint moment); `tests/daemon/api/key-leak-guard.test.ts` pins both as the
 * ONLY places the raw value may ever appear.
 */
export async function handleRotateExternalMcpToken(deps: TeamConfigRouteDeps): Promise<RouteResponse> {
  const groveIdOrRefusal = resolveServedGroveIdOrRefusal(deps);
  if (isRefusal(groveIdOrRefusal)) return groveIdOrRefusal;

  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  try {
    return await withExternalMcpActivation(mycoHome, async () => {
      const token = crypto.randomBytes(32).toString('hex');
      writeSecret(mycoHome, HOST_EXTERNAL_MCP_TOKEN_SECRET, token);
      return { body: { token, tokenHash: nonSecretTokenHash(token) } };
    });
  } catch (error) {
    if (error instanceof ExternalMcpActivationBusyError) {
      return {
        status: 409,
        body: errorBody('external_mcp_busy', error.message),
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// GET /api/team/external-mcp, PUT /api/team/external-mcp/toggle
// ---------------------------------------------------------------------------

interface ExternalMcpStatusBody {
  enabled: boolean;
  port: number;
  /** Non-secret change-detection hash, or null when no token has ever been
   *  minted (enabled has never succeeded). Never the raw token. */
  tokenHash: string | null;
  /** Whether THIS daemon process currently has the listener bound — absent
   *  (`null`) when no live listener was threaded into these deps (see
   *  `TeamConfigRouteDeps.externalMcp`). */
  bound: boolean | null;
}

/** GET /api/team/external-mcp — current toggle/port/tokenHash/bound status.
 *  Never echoes the raw token (leak-guard pin: the ONLY reveal surfaces are
 *  the rotate and enable-toggle responses, never this route). */
export async function handleGetExternalMcp(deps: TeamConfigRouteDeps): Promise<RouteResponse> {
  const groveIdOrRefusal = resolveServedGroveIdOrRefusal(deps);
  if (isRefusal(groveIdOrRefusal)) return groveIdOrRefusal;

  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const machine = loadMachineConfig(mycoHome);
  const existingToken = readSecrets(mycoHome)[HOST_EXTERNAL_MCP_TOKEN_SECRET];

  const body: ExternalMcpStatusBody = {
    enabled: machine.daemon.external_mcp.enabled,
    port: machine.daemon.external_mcp.port,
    tokenHash: existingToken && existingToken.trim() ? nonSecretTokenHash(existingToken.trim()) : null,
    bound: deps.externalMcp ? deps.externalMcp.listener.isBound : null,
  };
  return { body };
}

interface ExternalMcpTogglePutBody {
  enabled?: unknown;
  /** Optional port override on enable; defaults to the persisted/schema-default port. */
  port?: unknown;
}

/**
 * PUT /api/team/external-mcp/toggle — enable or disable the external MCP
 * listener (server-mode design spec §7).
 *
 * Enable: bind the listener → turn Funnel on → persist the live port →
 * mint-if-absent (never rotates an existing token — only
 * `POST /api/team/mcp-token/rotate` does that). The token write is the final
 * fallible state transition, so a failed activation has no durable token
 * whose one-time reveal could be consumed.
 * The raw token is returned ONLY when THIS call freshly minted it (first
 * enable, or enable after a secrets wipe) — a re-enable of an already-token'd
 * listener returns `tokenHash` only, never the raw value (Task 10 Fix Round
 * 1: re-enable is an idempotent bind, not a reveal; a member who lost the
 * token uses rotate, the deliberate reveal surface for that case).
 *
 * Disable: Funnel off → unbind → persist `enabled: false` (the port setting
 * is preserved so a later re-enable reuses it unless overridden).
 *
 * Both branches persist through `saveMachineConfig` (the one write path for
 * machine-tier config) so a restart with the toggle left on re-binds
 * (`daemon/main.ts`) before Funnel traffic could reach a dead port. The
 * ENABLE branch persists the ACTUALLY-bound port (`bindResult.port`), never
 * the raw request value — `bind(0)` (an ephemeral port, real callers never
 * request it but tests do) would otherwise persist `0`, a port nothing is
 * listening on.
 */
export async function handlePutExternalMcpToggle(
  deps: TeamConfigRouteDeps,
  body: unknown,
): Promise<RouteResponse> {
  const groveIdOrRefusal = resolveServedGroveIdOrRefusal(deps);
  if (isRefusal(groveIdOrRefusal)) return groveIdOrRefusal;

  const payload = (body ?? {}) as ExternalMcpTogglePutBody;
  if (typeof payload.enabled !== 'boolean') {
    return { status: 400, body: errorBody('invalid_input', '"enabled" (boolean) is required') };
  }

  const mycoHome = deps.mycoHome ?? resolveMycoHome();

  // Range-validate BEFORE any side effect (mint, bind, persist, Funnel) —
  // the SAME bounds `ExternalMcpSchema` enforces on load, so a bad port can
  // never be persisted via this route and then silently coerced/rejected on
  // the next daemon boot. `port: 0` (below the schema's 1024 floor) is
  // rejected here, never reaches `bind`.
  let requestedPortOverride: number | undefined;
  if (payload.port !== undefined) {
    const parsedPort = ExternalMcpSchema.shape.port.safeParse(payload.port);
    if (!parsedPort.success) {
      return {
        status: 400,
        body: errorBody('invalid_port', 'port must be an integer between 1024 and 65535'),
      };
    }
    requestedPortOverride = parsedPort.data;
  }

  try {
    return await withExternalMcpActivation(mycoHome, async () => {
      const machine = loadMachineConfig(mycoHome);
      const requestedPort = requestedPortOverride
        ?? machine.daemon.external_mcp.port
        ?? EXTERNAL_MCP_DEFAULT_PORT;

      function persist(enabled: boolean, port: number): void {
        saveMachineConfig({
          ...machine,
          daemon: { ...machine.daemon, external_mcp: { enabled, port } },
        }, mycoHome);
      }

      const listenerWasBound = deps.externalMcp?.listener.isBound ?? false;
      const previousListenerPort = deps.externalMcp?.listener.port ?? 0;

      const failWithCompensation = async (
        error: unknown,
        funnelRestorations: Array<{ port: number; on: boolean }>,
      ): Promise<never> => {
        const compensationErrors: unknown[] = [];
        if (deps.externalMcp) {
          try {
            if (listenerWasBound) {
              const rebound = await deps.externalMcp.listener.bind(previousListenerPort);
              if (!rebound.ok) throw new Error(rebound.error);
            } else {
              await deps.externalMcp.listener.unbind();
            }
          } catch (compensationError) {
            compensationErrors.push(compensationError);
          }
          for (const restoration of funnelRestorations) {
            try {
              const result = await deps.externalMcp.runFunnel(
                restoration.port,
                restoration.on,
              );
              requireFunnelSuccess(result, 'Could not restore Tailscale Funnel');
            } catch (compensationError) {
              compensationErrors.push(compensationError);
            }
          }
        }
        try {
          saveMachineConfig(machine, mycoHome);
        } catch (compensationError) {
          compensationErrors.push(compensationError);
        }
        if (compensationErrors.length > 0) {
          const message = error instanceof Error ? error.message : String(error);
          const primaryErrors = error instanceof AggregateError
            ? [...error.errors]
            : [error];
          throw new AggregateError(
            [...primaryErrors, ...compensationErrors],
            `${message}; external MCP activation compensation also failed`,
          );
        }
        throw error;
      };

      if (!payload.enabled) {
        const port = machine.daemon.external_mcp.port;
        let funnel: Awaited<ReturnType<FunnelRunner>> | undefined;
        let funnelDisabled = false;
        try {
          funnel = deps.externalMcp
            ? await deps.externalMcp.runFunnel(port, false)
            : undefined;
          if (funnel) {
            requireFunnelSuccess(funnel, 'Could not disable Tailscale Funnel');
            funnelDisabled = true;
          }
          if (deps.externalMcp) await deps.externalMcp.listener.unbind();
          persist(false, port);
          return { body: { enabled: false, port, funnel } };
        } catch (error) {
          if (!funnelDisabled) throw error;
          return await failWithCompensation(error, [
            { port, on: machine.daemon.external_mcp.enabled },
          ]);
        }
      }

      let boundPort = requestedPort;
      let funnel: Awaited<ReturnType<FunnelRunner>> | undefined;
      let funnelAttempted = false;

      const enableFunnelRestorations = (): Array<{ port: number; on: boolean }> => {
        if (!funnelAttempted) return [];
        if (!listenerWasBound) return [{ port: boundPort, on: false }];
        if (boundPort === previousListenerPort) {
          return [{
            port: previousListenerPort,
            on: machine.daemon.external_mcp.enabled,
          }];
        }
        return [
          { port: boundPort, on: false },
          {
            port: previousListenerPort,
            on: machine.daemon.external_mcp.enabled,
          },
        ];
      };

      try {
        if (deps.externalMcp) {
          const bindResult = await deps.externalMcp.listener.bind(requestedPort);
          if (!bindResult.ok) {
            throw new ExternalMcpBindError(bindResult.error);
          }
          boundPort = bindResult.port;
          funnelAttempted = true;
          funnel = await deps.externalMcp.runFunnel(boundPort, true);
          requireFunnelSuccess(funnel, 'Could not enable Tailscale Funnel');
        }
        persist(true, boundPort);
      } catch (error) {
        try {
          return await failWithCompensation(error, enableFunnelRestorations());
        } catch (compensatedError) {
          if (error instanceof ExternalMcpBindError && compensatedError === error) {
            return {
              status: 500,
              body: errorBody(
                'bind_failed',
                `Could not bind the external MCP listener: ${error.detail}`,
              ),
            };
          }
          throw compensatedError;
        }
      }

      let candidate: string | undefined;
      let token: string;
      let freshlyMinted: boolean;
      try {
        const result = writeSecretIfAbsent(
          mycoHome,
          HOST_EXTERNAL_MCP_TOKEN_SECRET,
          () => {
            candidate = crypto.randomBytes(32).toString('hex');
            return candidate;
          },
        );
        token = result.value;
        freshlyMinted = result.minted;
      } catch (error) {
        let committed: string | undefined;
        try {
          committed = readSecrets(mycoHome)[HOST_EXTERNAL_MCP_TOKEN_SECRET]?.trim();
        } catch (inspectionError) {
          const message = error instanceof Error ? error.message : String(error);
          return await failWithCompensation(
            new AggregateError(
              [error, inspectionError],
              `${message}; external MCP token commit state could not be inspected`,
            ),
            enableFunnelRestorations(),
          );
        }
        if (candidate !== undefined && committed === candidate) {
          token = committed;
          freshlyMinted = true;
        } else if (!committed) {
          return await failWithCompensation(error, enableFunnelRestorations());
        } else {
          throw error;
        }
      }

      const responseBody: {
        enabled: true;
        port: number;
        tokenHash: string;
        funnel: unknown;
        token?: string;
      } = {
        enabled: true,
        port: boundPort,
        tokenHash: nonSecretTokenHash(token),
        funnel,
      };
      if (freshlyMinted) responseBody.token = token;

      return { body: responseBody };
    });
  } catch (error) {
    if (error instanceof ExternalMcpActivationBusyError) {
      return {
        status: 409,
        body: errorBody('external_mcp_busy', error.message),
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTeamConfigRoutes(server: RouteRegistrar, deps: TeamConfigRouteDeps): void {
  server.registerRoute('GET', '/api/team/config', async () => handleGetTeamConfig(deps));

  server.registerRoute('PUT', '/api/team/config', async (req: RouteRequest) => {
    const { response, touchedPaths, groveId } = await handlePutTeamConfig(deps, req.body);
    if ((!response.status || response.status < 400) && groveId) {
      await deps.onConfigWrite?.(touchedPaths, groveId);
    }
    return response;
  });

  server.registerRoute('PUT', '/api/team/secrets/:provider', async (req: RouteRequest) =>
    handlePutTeamSecret(deps, req.params.provider, req.body));

  server.registerRoute('DELETE', '/api/team/secrets/:provider', async (req: RouteRequest) =>
    handleDeleteTeamSecret(deps, req.params.provider));

  server.registerRoute('POST', '/api/team/mcp-token/rotate', async () =>
    handleRotateExternalMcpToken(deps));

  server.registerRoute('GET', '/api/team/external-mcp', async () =>
    handleGetExternalMcp(deps));

  server.registerRoute('PUT', '/api/team/external-mcp/toggle', async (req: RouteRequest) =>
    handlePutExternalMcpToggle(deps, req.body));
}
