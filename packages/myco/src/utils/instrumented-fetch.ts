/**
 * Cross-provider fetch wrapper with bounded headers timeout, no-progress
 * (idle) watchdog, structured chunk logging, and per-chunk event-loop
 * yields.
 *
 * Purpose: any outbound LLM / embedding HTTP call routed through this
 * factory gets the same protections, regardless of which provider SDK
 * issued it. The acute failure that motivated this — canopy-describe
 * over-pressuring gpt-oss-20b via LMStudio and pinning the daemon's main
 * loop for >60 seconds with no `/health` response — would have been
 * killed at the idle-timeout boundary and logged with a stable kind
 * (`fetch.stall`) operators can grep on.
 *
 * The body wrap also serves as a forcing function for event-loop yields:
 * `setImmediate` between every chunk hands control back to libuv so timer
 * callbacks (PowerManager tick, idle-probe sampling) and incoming TCP
 * connections (`/health`) get scheduling time even when the upstream is
 * dripping chunks in tight bursts.
 *
 * Wiring: factory function — each provider configures its own thresholds
 * (e.g., a chat completion is allowed a longer idle window than an
 * embedding call). The returned function is type-compatible with the
 * global `fetch`.
 */

import crypto from 'node:crypto';
import { LOG_KINDS } from '../constants/log-kinds.js';
import type { Logger } from '../daemon/logger.js';

/** A logger surface the wrapper actually uses — kept narrow so callers
 *  can pass any compatible object (full DaemonLogger, a mock, or null). */
export interface InstrumentedFetchLogger {
  debug?: Logger['debug'];
  warn?: Logger['warn'];
}

export interface InstrumentedFetchOptions {
  /** Component label included on every log entry so operators can tell
   *  whether the stall was an agent run vs. an embedding job vs. a
   *  control-plane call. */
  component: string;
  /** Logger to emit structured events on. If undefined, instrumentation is
   *  silent but the timeouts and yields still apply. */
  logger?: InstrumentedFetchLogger;
  /** Cap on how long we wait for response headers (the network round-trip
   *  to the upstream). Defaults to 60s. */
  responseHeadersTimeoutMs?: number;
  /** Cap on the gap between consecutive body chunks. Defaults to 30s. A
   *  stuck stream that never closes still triggers this even if the
   *  caller's wall-clock budget is much longer. */
  idleTimeoutMs?: number;
  /** Hard ceiling on total request time. Defaults to undefined — relies on
   *  the caller's signal + idleTimeoutMs. Set this when a provider should
   *  never be allowed to occupy a connection beyond N seconds regardless
   *  of activity. */
  totalTimeoutMs?: number;
  /** Whether to insert `await new Promise(r => setImmediate(r))` between
   *  chunks while draining the body. Defaults to true — this is the
   *  loop-yield property that keeps `/health` responsive during a large
   *  streamed response. Disable only in tests that need deterministic
   *  back-to-back chunks. */
  yieldBetweenChunks?: boolean;
  /** Optional clock override (tests). */
  now?: () => number;
}

export const DEFAULT_RESPONSE_HEADERS_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

interface ResolvedOptions {
  component: string;
  logger: InstrumentedFetchLogger | undefined;
  responseHeadersTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number | undefined;
  yieldBetweenChunks: boolean;
  now: () => number;
}

function resolveOptions(options: InstrumentedFetchOptions): ResolvedOptions {
  return {
    component: options.component,
    logger: options.logger,
    responseHeadersTimeoutMs:
      options.responseHeadersTimeoutMs ?? DEFAULT_RESPONSE_HEADERS_TIMEOUT_MS,
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    totalTimeoutMs: options.totalTimeoutMs,
    yieldBetweenChunks: options.yieldBetweenChunks ?? true,
    now: options.now ?? Date.now,
  };
}

/**
 * Combine multiple AbortSignals into one. Node 20.3+ exposes
 * `AbortSignal.any` natively; we fall back to a manual implementation for
 * older runtimes to keep the wrapper portable. Either way the returned
 * signal aborts as soon as any input does and propagates the original
 * `reason`.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const native = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === 'function') {
    return native.call(AbortSignal, signals);
  }
  const controller = new AbortController();
  const handlers: Array<() => void> = [];
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    const handler = () => {
      if (!controller.signal.aborted) {
        controller.abort(sig.reason);
      }
      for (const h of handlers) h();
    };
    handlers.push(() => sig.removeEventListener('abort', handler));
    sig.addEventListener('abort', handler, { once: true });
  }
  return controller.signal;
}

class FetchStallError extends Error {
  constructor(public readonly kind: 'response-headers-timeout' | 'idle-timeout' | 'total-timeout', message: string) {
    super(message);
    this.name = 'FetchStallError';
  }
}

/**
 * Callable fetch type — what every consumer in this codebase (OpenAI
 * client, LmStudioBackend, embedding providers) actually wants. We do not
 * widen this to `typeof fetch` because that includes static fields like
 * `fetch.preconnect` that the global declares but no SDK consumes.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Create a `fetch`-compatible function with the configured instrumentation
 * baked in. Reuse the returned function across many requests; per-call
 * customization comes from the standard `init.signal` parameter, which we
 * compose with our internal abort sources.
 */
export function createInstrumentedFetch(options: InstrumentedFetchOptions): FetchLike {
  const resolved = resolveOptions(options);
  return async function instrumentedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    return instrumentedFetchImpl(input, init, resolved);
  };
}

/** Module-default instance, suitable for ad-hoc imports where the caller
 *  doesn't need per-component log routing or custom thresholds. */
export const instrumentedFetch: FetchLike = createInstrumentedFetch({
  component: 'default',
});

async function instrumentedFetchImpl(
  input: RequestInfo | URL,
  init: RequestInit,
  options: ResolvedOptions,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = extractUrl(input);
  const method = (init.method ?? (typeof input === 'object' && 'method' in (input as Request) ? (input as Request).method : 'GET') ?? 'GET').toUpperCase();
  const callerSignal = init.signal ?? undefined;

  const startedAt = options.now();
  const headersAbort = new AbortController();
  const idleAbort = new AbortController();
  const totalAbort = new AbortController();

  const signalsToCompose: AbortSignal[] = [headersAbort.signal, idleAbort.signal, totalAbort.signal];
  if (callerSignal) signalsToCompose.push(callerSignal);
  const composed = anySignal(signalsToCompose);

  const headersTimer = setTimeout(() => {
    headersAbort.abort(new FetchStallError(
      'response-headers-timeout',
      `No response headers after ${options.responseHeadersTimeoutMs}ms`,
    ));
  }, options.responseHeadersTimeoutMs);
  headersTimer.unref?.();

  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  if (options.totalTimeoutMs !== undefined) {
    totalTimer = setTimeout(() => {
      totalAbort.abort(new FetchStallError(
        'total-timeout',
        `Request exceeded total budget of ${options.totalTimeoutMs}ms`,
      ));
    }, options.totalTimeoutMs);
    totalTimer.unref?.();
  }

  options.logger?.debug?.(LOG_KINDS.FETCH_START, `${options.component}: ${method} ${redactUrl(url)}`, {
    component: options.component,
    requestId,
    method,
    url: redactUrl(url),
    responseHeadersTimeoutMs: options.responseHeadersTimeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs ?? null,
  });

  let response: Response;
  try {
    response = await fetch(input, { ...init, signal: composed });
  } catch (err) {
    clearTimeout(headersTimer);
    if (totalTimer) clearTimeout(totalTimer);
    const stall = classifyStallReason(err, headersAbort.signal, idleAbort.signal, totalAbort.signal, callerSignal);
    if (stall) {
      options.logger?.warn?.(stallToLogKind(stall.kind), `${options.component}: ${stall.kind} ${redactUrl(url)}`, {
        component: options.component,
        requestId,
        url: redactUrl(url),
        method,
        elapsedMs: options.now() - startedAt,
        reason: stall.message,
      });
      throw stall;
    }
    throw err;
  }

  clearTimeout(headersTimer);

  if (!response.body) {
    if (totalTimer) clearTimeout(totalTimer);
    options.logger?.debug?.(LOG_KINDS.FETCH_COMPLETE, `${options.component}: ${method} ${redactUrl(url)} ${response.status}`, {
      component: options.component,
      requestId,
      method,
      url: redactUrl(url),
      status: response.status,
      elapsedMs: options.now() - startedAt,
      chunkCount: 0,
      totalBytes: 0,
    });
    return response;
  }

  const wrappedBody = wrapBodyWithIdleWatchdog({
    body: response.body,
    idleAbort,
    callerSignal: composed,
    options,
    onSettled: () => {
      if (totalTimer) clearTimeout(totalTimer);
    },
    onComplete: (stats) => {
      options.logger?.debug?.(LOG_KINDS.FETCH_COMPLETE, `${options.component}: ${method} ${redactUrl(url)} ${response.status}`, {
        component: options.component,
        requestId,
        method,
        url: redactUrl(url),
        status: response.status,
        elapsedMs: options.now() - startedAt,
        chunkCount: stats.chunkCount,
        totalBytes: stats.totalBytes,
      });
    },
    onAbort: (reason) => {
      const stall = classifyStallReason(reason, headersAbort.signal, idleAbort.signal, totalAbort.signal, callerSignal);
      options.logger?.warn?.(
        stall ? stallToLogKind(stall.kind) : LOG_KINDS.FETCH_ABORT,
        `${options.component}: stream aborted ${redactUrl(url)}`,
        {
          component: options.component,
          requestId,
          url: redactUrl(url),
          method,
          elapsedMs: options.now() - startedAt,
          reason: stall?.message ?? errorReason(reason),
        },
      );
    },
  });

  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

interface BodyWrapStats {
  chunkCount: number;
  totalBytes: number;
}

interface WrapBodyArgs {
  body: ReadableStream<Uint8Array>;
  idleAbort: AbortController;
  callerSignal: AbortSignal;
  options: ResolvedOptions;
  onSettled: () => void;
  onComplete: (stats: BodyWrapStats) => void;
  onAbort: (reason: unknown) => void;
}

function wrapBodyWithIdleWatchdog(args: WrapBodyArgs): ReadableStream<Uint8Array> {
  const { body, idleAbort, callerSignal, options, onSettled, onComplete, onAbort } = args;

  let lastChunkAt = options.now();
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let chunkCount = 0;
  let totalBytes = 0;

  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      const sinceLastMs = options.now() - lastChunkAt;
      if (sinceLastMs >= options.idleTimeoutMs) {
        idleAbort.abort(new FetchStallError(
          'idle-timeout',
          `No chunk received in ${sinceLastMs}ms (threshold ${options.idleTimeoutMs}ms)`,
        ));
      }
    }, options.idleTimeoutMs);
  };

  const disarmWatchdog = () => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      let rejectPendingRead: ((reason: unknown) => void) | null = null;
      const abortRead = new Promise<never>((_, reject) => {
        rejectPendingRead = reject;
      });
      // Forward any abort source (idle watchdog, total-timeout, caller
      // signal) to the inner reader. Without this, `reader.read()` blocks
      // indefinitely while the upstream sends nothing, even after our
      // own watchdog has set `idleAbort` — the reader doesn't observe
      // signals on its own. Some runtimes do not reliably wake a pending
      // read from `reader.cancel()`, so race the read with an explicit
      // abort rejection as the authoritative wake-up path.
      const cancelOnAbort = () => {
        const reason = callerSignal.reason ?? new Error('Aborted');
        rejectPendingRead?.(reason);
        try { void reader.cancel(reason); } catch { /* ignore */ }
      };
      if (callerSignal.aborted) {
        cancelOnAbort();
      } else {
        callerSignal.addEventListener('abort', cancelOnAbort, { once: true });
      }

      armWatchdog();
      try {
        while (true) {
          if (callerSignal.aborted) {
            throw callerSignal.reason ?? new Error('Aborted');
          }
          const { done, value } = await Promise.race([
            reader.read(),
            abortRead,
          ]);
          if (callerSignal.aborted) {
            // Reader was cancelled mid-read. The read may return
            // `{ done: true }` quietly when cancelled — turn that into a
            // surfaced abort so the caller learns *why* the stream ended.
            throw callerSignal.reason ?? new Error('Aborted');
          }
          if (done) break;
          chunkCount += 1;
          totalBytes += value.byteLength;
          lastChunkAt = options.now();
          armWatchdog();
          controller.enqueue(value);
          if (options.yieldBetweenChunks) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
        controller.close();
        disarmWatchdog();
        callerSignal.removeEventListener('abort', cancelOnAbort);
        onSettled();
        onComplete({ chunkCount, totalBytes });
      } catch (err) {
        disarmWatchdog();
        callerSignal.removeEventListener('abort', cancelOnAbort);
        onSettled();
        onAbort(err);
        try { controller.error(err); } catch { /* already errored */ }
        try { reader.releaseLock(); } catch { /* ignore */ }
        try { await body.cancel(err); } catch { /* ignore */ }
      }
    },
    cancel(reason) {
      disarmWatchdog();
      onSettled();
      return body.cancel(reason);
    },
  });
}

function stallToLogKind(
  kind: FetchStallError['kind'],
): typeof LOG_KINDS.FETCH_STALL | typeof LOG_KINDS.FETCH_TIMEOUT {
  return kind === 'idle-timeout' ? LOG_KINDS.FETCH_STALL : LOG_KINDS.FETCH_TIMEOUT;
}

function classifyStallReason(
  err: unknown,
  headersSignal: AbortSignal,
  idleSignal: AbortSignal,
  totalSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): FetchStallError | undefined {
  if (err instanceof FetchStallError) return err;
  if (idleSignal.aborted && idleSignal.reason instanceof FetchStallError) return idleSignal.reason;
  if (headersSignal.aborted && headersSignal.reason instanceof FetchStallError) return headersSignal.reason;
  if (totalSignal.aborted && totalSignal.reason instanceof FetchStallError) return totalSignal.reason;
  if (callerSignal?.aborted) return undefined;
  return undefined;
}

function errorReason(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return '(unserializable)'; }
}

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/** Strip query params from URLs in logs. Provider URLs can carry tokens in
 *  query strings — never let those land in the log file. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    return u.href;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

export { FetchStallError };
