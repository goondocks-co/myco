import { describe, it, expect, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import {
  createInstrumentedFetch,
  FetchStallError,
} from '@myco/utils/instrumented-fetch.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

interface LogCall {
  level: 'warn' | 'debug' | 'info' | 'error';
  kind: string;
  message: string;
  data?: Record<string, unknown>;
}

function captureLogger(): { logs: LogCall[]; logger: any } {
  const logs: LogCall[] = [];
  const push = (level: LogCall['level']) =>
    (kind: string, message: string, data?: Record<string, unknown>) => {
      logs.push({ level, kind, message, data });
    };
  return {
    logs,
    logger: {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    },
  };
}

function buildChunkedResponse(chunks: Uint8Array[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
        await new Promise((r) => setTimeout(r, 5));
      }
      controller.close();
    },
  });
  return new Response(body, { status });
}

function buildStallingHeadersResponse(): Promise<Response> {
  // Never resolves; the wrapper's response-headers timeout must catch it.
  return new Promise(() => {});
}

function buildIdleStreamResponse(idleAfterChunkMs: number): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
      // Then go silent — never closes, never enqueues. The wrapper's
      // idle watchdog must abort.
      await new Promise((r) => setTimeout(r, idleAfterChunkMs));
    },
  });
  return new Response(body, { status: 200 });
}

describe('createInstrumentedFetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs start + complete with chunk stats on a normal response', async () => {
    const { logs, logger } = captureLogger();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        buildChunkedResponse([
          new TextEncoder().encode('hello '),
          new TextEncoder().encode('world'),
        ]),
      ),
    );

    const fetchFn = createInstrumentedFetch({ component: 'test.basic', logger });
    const response = await fetchFn('http://example.test/api/echo');
    const text = await response.text();
    expect(text).toBe('hello world');

    const starts = logs.filter((l) => l.kind === LOG_KINDS.FETCH_START);
    const completes = logs.filter((l) => l.kind === LOG_KINDS.FETCH_COMPLETE);
    expect(starts.length).toBe(1);
    expect(completes.length).toBe(1);
    expect(completes[0].data?.chunkCount).toBe(2);
    expect(completes[0].data?.totalBytes).toBe(11);
    expect(completes[0].data?.status).toBe(200);
  });

  it('aborts with FetchStallError when response headers never arrive', async () => {
    const { logs, logger } = captureLogger();
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        // Honor the composed AbortSignal so the underlying fetch
        // rejects when the wrapper aborts — what real undici does.
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal!.reason);
        });
      }),
    ));

    const fetchFn = createInstrumentedFetch({
      component: 'test.headers',
      logger,
      responseHeadersTimeoutMs: 50,
    });

    let caught: unknown;
    try {
      await fetchFn('http://example.test/api/slow');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetchStallError);
    expect((caught as FetchStallError).kind).toBe('response-headers-timeout');

    const timeoutLogs = logs.filter((l) => l.kind === LOG_KINDS.FETCH_TIMEOUT);
    expect(timeoutLogs.length).toBe(1);
  });

  it('aborts mid-stream when chunks stop arriving past idleTimeoutMs', async () => {
    const { logs, logger } = captureLogger();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => buildIdleStreamResponse(5_000)),
    );

    const fetchFn = createInstrumentedFetch({
      component: 'test.idle',
      logger,
      idleTimeoutMs: 60,
    });
    const response = await fetchFn('http://example.test/api/drip');

    let caught: unknown;
    try {
      await response.text();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetchStallError);
    expect((caught as FetchStallError).kind).toBe('idle-timeout');

    const stalls = logs.filter((l) => l.kind === LOG_KINDS.FETCH_STALL);
    expect(stalls.length).toBe(1);
  });

  it('honors the caller-supplied AbortSignal without misclassifying as stall', async () => {
    const { logs, logger } = captureLogger();
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal!.reason);
        });
      }),
    ));

    const fetchFn = createInstrumentedFetch({ component: 'test.caller-abort', logger });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('caller aborted')), 30);

    let caught: unknown;
    try {
      await fetchFn('http://example.test/api/x', { signal: controller.signal });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(FetchStallError);

    // No spurious stall/timeout warns when the caller aborted.
    const wronglyClassified = logs.filter(
      (l) => l.kind === LOG_KINDS.FETCH_STALL || l.kind === LOG_KINDS.FETCH_TIMEOUT,
    );
    expect(wronglyClassified.length).toBe(0);
  });

  it('reports per-chunk stats matching what the wrapper observed', async () => {
    const { logs, logger } = captureLogger();
    const chunkCount = 8;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < chunkCount; i += 1) {
            controller.enqueue(new TextEncoder().encode('xxx'));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }));

    const fetchFn = createInstrumentedFetch({ component: 'test.stats', logger });
    const response = await fetchFn('http://example.test/api/burst');
    await response.text();

    const completes = logs.filter((l) => l.kind === LOG_KINDS.FETCH_COMPLETE);
    expect(completes.length).toBe(1);
    expect(completes[0].data?.chunkCount).toBe(chunkCount);
    expect(completes[0].data?.totalBytes).toBe(chunkCount * 3);
  });
});
