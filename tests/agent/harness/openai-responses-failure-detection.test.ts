/**
 * Tests for the OpenAI Agents harness fetch-seam guard against spore
 * discovery-5c27c512: OpenRouter's `/api/v1/responses` returns HTTP 200 for
 * an upstream provider failure (`status: "failed"`, `error: {...}`,
 * `output: []`, `usage: null`; also `status: "incomplete"` with only
 * reasoning-shaped output). `@openai/agents` v0.12.0's
 * `OpenAIResponsesModel.getResponse` reads only `response.output`/
 * `response.usage` and never checks `status`/`error`, so an unguarded
 * 200-wrapped failure becomes a zero-item model turn that agents-core's
 * turn loop silently re-runs until `MaxTurnsExceededError` — 8 turns in ~7s
 * with zero tool events and zero recorded usage (run 3e23e9bf).
 *
 * `isUnsurfacedResponsesFailure` and `wrapResponsesFailureDetection` are
 * exported directly from openai.ts for unit testing — driving this through
 * a full `harness.execute()` call would require a real `OpenAIProvider` +
 * stubbed global fetch, which every other harness test avoids by injecting
 * a `modelProvider` test override that bypasses `createProvider`/
 * `harnessFetch` (and therefore this guard) entirely.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import {
  isUnsurfacedResponsesFailure,
  wrapResponsesFailureDetection,
  OpenAIAgentsHarness,
} from '@myco/agent/harness/openai.js';
import { HarnessExecutionError } from '@myco/agent/harness/types.js';
import type { FetchLike } from '@myco/utils/instrumented-fetch.js';

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(response: Response): FetchLike {
  return async () => response;
}

const RESPONSES_URL = 'https://openrouter.ai/api/v1/responses';

// The exact shape spore discovery-5c27c512 verified live against OpenRouter.
const FAILED_BODY = {
  id: 'gen-abc123',
  status: 'failed',
  error: { code: 'provider_unavailable', message: 'Azure upstream rejected the request' },
  output: [],
  usage: null,
};

const INCOMPLETE_REASONING_ONLY_BODY = {
  id: 'gen-def456',
  status: 'incomplete',
  output: [{ type: 'reasoning', content: [] }],
  usage: { requests: 1, input_tokens: 10, output_tokens: 0, total_tokens: 10 },
};

const CLEAN_BODY = {
  id: 'gen-ghi789',
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
  usage: { requests: 1, input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

describe('isUnsurfacedResponsesFailure', () => {
  it('flags status: "failed"', () => {
    expect(isUnsurfacedResponsesFailure(FAILED_BODY)).toBe(true);
  });

  it('flags status: "incomplete" with only reasoning-shaped output', () => {
    expect(isUnsurfacedResponsesFailure(INCOMPLETE_REASONING_ONLY_BODY)).toBe(true);
  });

  it('flags status: "incomplete" with empty output', () => {
    expect(isUnsurfacedResponsesFailure({ status: 'incomplete', output: [] })).toBe(true);
  });

  it('flags status: "incomplete" with no output key at all', () => {
    expect(isUnsurfacedResponsesFailure({ status: 'incomplete' })).toBe(true);
  });

  it('passes status: "incomplete" that has at least one non-reasoning item', () => {
    expect(isUnsurfacedResponsesFailure({
      status: 'incomplete',
      output: [
        { type: 'reasoning', content: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] },
      ],
    })).toBe(false);
  });

  it('passes a clean status: "completed" body', () => {
    expect(isUnsurfacedResponsesFailure(CLEAN_BODY)).toBe(false);
  });

  it('passes an unrecognized status untouched (not our shape to police)', () => {
    expect(isUnsurfacedResponsesFailure({ status: 'queued', output: [] })).toBe(false);
  });
});

describe('wrapResponsesFailureDetection', () => {
  it('converts a 200 status:"failed" body into a synthesized 5xx the OpenAI SDK will raise as APIError', async () => {
    const wrapped = wrapResponsesFailureDetection(stubFetch(jsonResponse(FAILED_BODY)));
    const result = await wrapped(RESPONSES_URL, { method: 'POST', body: '{}' });

    expect(result.status).toBeGreaterThanOrEqual(500);
    expect(result.ok).toBe(false);
    const parsed = await result.json();
    expect(parsed.error.message).toContain('Azure upstream rejected the request');
    expect(parsed.error.code).toBe('provider_unavailable');
  });

  it('converts a 200 status:"incomplete" reasoning-only body the same way', async () => {
    const wrapped = wrapResponsesFailureDetection(stubFetch(jsonResponse(INCOMPLETE_REASONING_ONLY_BODY)));
    const result = await wrapped(RESPONSES_URL, { method: 'POST', body: '{}' });

    expect(result.status).toBeGreaterThanOrEqual(500);
    const parsed = await result.json();
    expect(parsed.error.message).toContain('incomplete response with no non-reasoning output');
  });

  it('passes a clean 200 response through byte-identical', async () => {
    const clean = jsonResponse(CLEAN_BODY);
    const wrapped = wrapResponsesFailureDetection(stubFetch(clean));
    const result = await wrapped(RESPONSES_URL, { method: 'POST', body: '{}' });

    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    const parsed = await result.json();
    expect(parsed).toEqual(CLEAN_BODY);
  });

  it('ignores GET requests to a /responses path (e.g. retrieve-by-id)', async () => {
    const wrapped = wrapResponsesFailureDetection(stubFetch(jsonResponse(FAILED_BODY)));
    const result = await wrapped(`${RESPONSES_URL}/gen-abc123`, { method: 'GET' });

    expect(result.status).toBe(200);
  });

  it('ignores POST requests whose path does not end in /responses', async () => {
    const wrapped = wrapResponsesFailureDetection(stubFetch(jsonResponse(FAILED_BODY)));
    const result = await wrapped('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}' });

    expect(result.status).toBe(200);
  });

  it('leaves an already-erroring (non-2xx) response untouched', async () => {
    const errorResponse = jsonResponse({ error: { message: 'invalid api key' } }, { status: 401 });
    const wrapped = wrapResponsesFailureDetection(stubFetch(errorResponse));
    const result = await wrapped(RESPONSES_URL, { method: 'POST', body: '{}' });

    expect(result.status).toBe(401);
    const parsed = await result.json();
    expect(parsed.error.message).toBe('invalid api key');
  });

  it('passes through a streamed (SSE content-type) response untouched', async () => {
    const sseResponse = new Response('data: {"type":"response.created"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const wrapped = wrapResponsesFailureDetection(stubFetch(sseResponse));
    const result = await wrapped(RESPONSES_URL, { method: 'POST', body: '{"stream":true}' });

    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('text/event-stream');
  });

  it('passes through a non-JSON body without throwing', async () => {
    const textResponse = new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } });
    const wrapped = wrapResponsesFailureDetection(stubFetch(textResponse));
    const result = await wrapped(RESPONSES_URL, { method: 'POST', body: '{}' });

    expect(result.status).toBe(200);
    expect(await result.text()).toBe('not json');
  });

  it('logs a warn-level fetch.provider-failure entry with the provider error message', async () => {
    const logs: Array<{ kind: string; message: string; data?: Record<string, unknown> }> = [];
    const logger = {
      warn: (kind: string, message: string, data?: Record<string, unknown>) => {
        logs.push({ kind, message, data });
      },
    };
    const wrapped = wrapResponsesFailureDetection(stubFetch(jsonResponse(FAILED_BODY)), logger);
    await wrapped(RESPONSES_URL, { method: 'POST', body: '{}' });

    expect(logs).toHaveLength(1);
    expect(logs[0]!.kind).toBe('fetch.provider-failure');
    expect(logs[0]!.message).toContain('Azure upstream rejected the request');
    expect(logs[0]!.data?.status).toBe('failed');
    expect(logs[0]!.data?.responseId).toBe('gen-abc123');
  });

  it('does not log when no logger is provided (silent instrumentation stays silent, not throwing)', async () => {
    const wrapped = wrapResponsesFailureDetection(stubFetch(jsonResponse(FAILED_BODY)));
    const result = await wrapped(RESPONSES_URL, { method: 'POST', body: '{}' });
    expect(result.status).toBeGreaterThanOrEqual(500);
  });
});

/**
 * End-to-end proof that the fetch-seam guard is actually wired into the
 * live harness path: no `modelProvider` test override here (that would
 * bypass `createProvider`/`createHarnessFetch` — and this guard — entirely,
 * same as every other harness test file). `global.fetch` is stubbed so
 * `OpenAIProvider`'s real `OpenAI` client, constructed by `createProvider`
 * with `fetch: createHarnessFetch(logger)`, actually round-trips through
 * `wrapResponsesFailureDetection`. This is the run 3e23e9bf reproduction:
 * before Fix 1, this exact stub would silently loop to
 * MaxTurnsExceededError in a handful of empty turns; after the fix it
 * throws on the FIRST turn.
 */
describe('OpenAIAgentsHarness.execute — end-to-end fetch-seam guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws immediately on turn 1 instead of looping to MaxTurnsExceededError', async () => {
    let fetchCallCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      fetchCallCount += 1;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (new URL(url).pathname.endsWith('/responses')) {
        return jsonResponse(FAILED_BODY);
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }));

    const priorKey = process.env.MYCO_OPENROUTER_API_KEY;
    process.env.MYCO_OPENROUTER_API_KEY = 'test-key';
    try {
      const harness = new OpenAIAgentsHarness();
      let caught: unknown;
      try {
        await harness.execute({
          prompt: 'do something',
          model: 'openai/gpt-5.4-mini',
          provider: { type: 'openrouter' },
          maxTurns: 8,
          toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(HarnessExecutionError);
      const harnessErr = caught as InstanceType<typeof HarnessExecutionError>;
      expect(harnessErr.telemetry.kind).toBe('connection');
      expect(harnessErr.message).toContain('Azure upstream rejected the request');
      // The whole point: the SDK's own retry-on-5xx may issue a couple of
      // attempts, but this must NOT consume the full maxTurns budget (8) —
      // that was the 3e23e9bf failure mode (8 turns in ~7s, zero events).
      expect(fetchCallCount).toBeLessThan(8);
    } finally {
      if (priorKey === undefined) delete process.env.MYCO_OPENROUTER_API_KEY;
      else process.env.MYCO_OPENROUTER_API_KEY = priorKey;
    }
  });

  it('threads the run logger into harnessFetch so the provider-failure warning is actually logged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(FAILED_BODY)));

    const priorKey = process.env.MYCO_OPENROUTER_API_KEY;
    process.env.MYCO_OPENROUTER_API_KEY = 'test-key';
    const warnCalls: Array<{ kind: string; message: string }> = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (kind: string, message: string) => { warnCalls.push({ kind, message }); },
      error: () => {},
    };
    try {
      const harness = new OpenAIAgentsHarness();
      await harness.execute({
        prompt: 'do something',
        model: 'openai/gpt-5.4-mini',
        provider: { type: 'openrouter' },
        maxTurns: 8,
        logger,
        toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
      }).catch(() => {});

      expect(warnCalls.some((c) => c.kind === 'fetch.provider-failure')).toBe(true);
    } finally {
      if (priorKey === undefined) delete process.env.MYCO_OPENROUTER_API_KEY;
      else process.env.MYCO_OPENROUTER_API_KEY = priorKey;
    }
  });
});
