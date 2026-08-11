/**
 * Tests for the shared LM Studio instance manager — the single
 * ensure-loaded path with v0-primary loaded-state reads, single-flight,
 * and the converge-to-one instance policy.
 *
 * All network access goes through the injected fetch seam; no live
 * LM Studio is required. The v0/v1 response shapes mirror live captures
 * from 2026-08-11 (see the module header): v0 reports loaded instances as
 * separate `:N`-suffixed entries with `state`/`loaded_context_length`;
 * v1's `loaded_instances` arrays are unreliably empty.
 */

import { describe, it, expect } from 'bun:test';
import {
  ensureLmStudioModelInstance,
  queryLmStudioInstances,
  unloadLmStudioInstance,
  normalizeLmStudioControlUrl,
  lmStudioModelMatches,
  type LmStudioTimedFetch,
} from '@myco/intelligence/lmstudio-instances.js';

interface RecordedCall {
  url: string;
  method: string;
  body: any;
}

interface StubServerOptions {
  /** v0 entries: [id, state, loadedContextLength] */
  v0?: Array<[string, string, number | undefined]>;
  /** v1 entries: [key, instances as [id, contextLength][]] */
  v1?: Array<[string, Array<[string, number | undefined]>]>;
  /** Status for the v0 list endpoint (default 200). */
  v0Status?: number;
  /** Status for the v1 list endpoint (default 200). */
  v1Status?: number;
  /** When true, both list endpoints throw (server stalled) while load/unload still work. */
  listsUnreachable?: boolean;
  /** Response to a load POST (default: success with instance id `<model>:new`). */
  onLoad?: (body: any) => Response;
  /** Called after a successful load — lets the stub server "become loaded". */
  afterLoad?: (body: any) => void;
  /** Delay every request by this many ms (for concurrency tests). */
  delayMs?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stateful LM Studio stub covering the v0/v1 lists + load/unload. */
function stubServer(options: StubServerOptions) {
  const calls: RecordedCall[] = [];
  const state = {
    v0: options.v0 ?? [],
    v1: options.v1 ?? [],
  };

  const fetchImpl: LmStudioTimedFetch = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }

    if (url.endsWith('/api/v0/models') && method === 'GET') {
      if (options.listsUnreachable) throw new Error('list stalled');
      if (options.v0Status && options.v0Status !== 200) {
        return new Response('err', { status: options.v0Status });
      }
      return jsonResponse({
        data: state.v0.map(([id, s, ctx]) => ({
          id,
          object: 'model',
          state: s,
          ...(ctx !== undefined ? { loaded_context_length: ctx } : {}),
        })),
      });
    }
    if (url.endsWith('/api/v1/models') && method === 'GET') {
      if (options.listsUnreachable) throw new Error('list stalled');
      if (options.v1Status && options.v1Status !== 200) {
        return new Response('err', { status: options.v1Status });
      }
      return jsonResponse({
        models: state.v1.map(([key, instances]) => ({
          key,
          loaded_instances: instances.map(([id, ctx]) => ({
            id,
            ...(ctx !== undefined ? { config: { context_length: ctx } } : {}),
          })),
        })),
      });
    }
    if (url.endsWith('/api/v1/models/load') && method === 'POST') {
      const response = options.onLoad
        ? options.onLoad(body)
        : jsonResponse({ instance_id: `${body.model}:new`, status: 'loaded' });
      if (response.ok) options.afterLoad?.(body);
      return response;
    }
    if (url.endsWith('/api/v1/models/unload') && method === 'POST') {
      state.v0 = state.v0.filter(([id]) => id !== body.instance_id);
      return jsonResponse({ instance_id: body.instance_id });
    }
    return new Response('not found', { status: 404 });
  };

  return { fetchImpl, calls, state };
}

function collectWarns() {
  const events: Array<{ event: string; meta?: Record<string, unknown> }> = [];
  return {
    warn: (event: string, _message: string, meta?: Record<string, unknown>) => {
      events.push({ event, meta });
    },
    events,
  };
}

const loadCalls = (calls: RecordedCall[]) => calls.filter((c) => c.url.endsWith('/models/load'));
const unloadCalls = (calls: RecordedCall[]) => calls.filter((c) => c.url.endsWith('/models/unload'));

describe('normalizeLmStudioControlUrl', () => {
  it('strips a trailing /v1 path', () => {
    expect(normalizeLmStudioControlUrl('http://localhost:1234/v1')).toBe('http://localhost:1234');
  });

  it('strips a trailing slash', () => {
    expect(normalizeLmStudioControlUrl('http://localhost:1234/')).toBe('http://localhost:1234');
  });

  it('passes a bare control root through', () => {
    expect(normalizeLmStudioControlUrl('http://10.29.13.55:1234')).toBe('http://10.29.13.55:1234');
  });
});

describe('lmStudioModelMatches', () => {
  it('matches exactly', () => {
    expect(lmStudioModelMatches('gpt-oss-20b', 'gpt-oss-20b')).toBe(true);
  });

  it('matches across an :N instance suffix', () => {
    expect(lmStudioModelMatches('gpt-oss-20b:3', 'gpt-oss-20b')).toBe(true);
  });

  it('bridges the one-sided vendor-prefix asymmetry in both directions', () => {
    expect(lmStudioModelMatches('gpt-oss-20b', 'openai/gpt-oss-20b')).toBe(true);
    expect(lmStudioModelMatches('gpt-oss-20b:2', 'openai/gpt-oss-20b')).toBe(true);
    expect(lmStudioModelMatches('openai/gpt-oss-20b', 'gpt-oss-20b')).toBe(true);
  });

  it('never aliases two different vendors of the same base model', () => {
    expect(lmStudioModelMatches('unsloth/qwen3-8b', 'lmstudio-community/qwen3-8b')).toBe(false);
  });

  it('never matches on substring containment', () => {
    expect(lmStudioModelMatches('my-gpt-oss-20b-tune', 'gpt-oss-20b')).toBe(false);
    expect(lmStudioModelMatches('gpt-oss-20b', 'gpt-oss')).toBe(false);
  });
});

describe('queryLmStudioInstances', () => {
  it('reads loaded instances from v0 (v1 empty — the known defect)', async () => {
    const { fetchImpl } = stubServer({
      v0: [
        ['gpt-oss-20b', 'loaded', 32768],
        ['gpt-oss-20b:2', 'loaded', 32768],
        ['other-model', 'not-loaded', undefined],
      ],
      v1: [['openai/gpt-oss-20b', []]],
    });
    const { warn, events } = collectWarns();

    const instances = await queryLmStudioInstances('http://localhost:1234', 'openai/gpt-oss-20b', warn, fetchImpl);

    expect(instances.map((i) => i.id)).toEqual(['gpt-oss-20b', 'gpt-oss-20b:2']);
    expect(instances[0].contextLength).toBe(32768);
    expect(instances[0].ready).toBe(true);
    // v1-empty-while-v0-populated is the documented defect — no warning.
    expect(events).toEqual([]);
  });

  it('marks mid-load v0 entries as not ready', async () => {
    const { fetchImpl } = stubServer({
      v0: [['gpt-oss-20b', 'loading', undefined]],
    });

    const instances = await queryLmStudioInstances('http://localhost:1234', 'gpt-oss-20b', () => {}, fetchImpl);

    expect(instances).toEqual([{ id: 'gpt-oss-20b', contextLength: null, ready: false }]);
  });

  it('falls back to v1 when v0 is unavailable', async () => {
    const { fetchImpl } = stubServer({
      v0Status: 404,
      v1: [['openai/gpt-oss-20b', [['gpt-oss-20b:1', 16384]]]],
    });

    const instances = await queryLmStudioInstances('http://localhost:1234', 'openai/gpt-oss-20b', undefined, fetchImpl);

    expect(instances).toEqual([{ id: 'gpt-oss-20b:1', contextLength: 16384, ready: true }]);
  });

  it('warns when v0 reports nothing but v1 reports instances', async () => {
    const { fetchImpl } = stubServer({
      v0: [['gpt-oss-20b', 'not-loaded', undefined]],
      v1: [['openai/gpt-oss-20b', [['gpt-oss-20b:1', 16384]]]],
    });
    const { warn, events } = collectWarns();

    const instances = await queryLmStudioInstances('http://localhost:1234', 'openai/gpt-oss-20b', warn, fetchImpl);

    expect(instances.map((i) => i.id)).toEqual(['gpt-oss-20b:1']);
    expect(events.map((e) => e.event)).toContain('lmstudio.instances.source-disagreement');
  });

  it('scans every duplicate v1 catalog entry for the same key', async () => {
    const { fetchImpl } = stubServer({
      v0Status: 500,
      v1: [
        ['openai/gpt-oss-20b', []],
        ['openai/gpt-oss-20b', [['gpt-oss-20b:2', 8192]]],
      ],
    });

    const instances = await queryLmStudioInstances('http://localhost:1234', 'openai/gpt-oss-20b', undefined, fetchImpl);

    expect(instances.map((i) => i.id)).toEqual(['gpt-oss-20b:2']);
  });
});

describe('ensureLmStudioModelInstance', () => {
  it('reuses an adequate loaded instance without loading', async () => {
    const { fetchImpl, calls } = stubServer({
      v0: [['gpt-oss-20b', 'loaded', 32768]],
    });

    const result = await ensureLmStudioModelInstance({
      baseUrl: 'http://localhost:1234',
      model: 'openai/gpt-oss-20b',
      contextLength: 16384,
      fetchImpl,
    });

    expect(result).toEqual({ instanceId: 'gpt-oss-20b', loaded: true });
    expect(loadCalls(calls)).toHaveLength(0);
    expect(unloadCalls(calls)).toHaveLength(0);
  });

  it('converges a duplicate pile onto one instance (the accumulation cleanup)', async () => {
    const { fetchImpl, calls } = stubServer({
      v0: [
        ['gpt-oss-20b', 'loaded', 32768],
        ['gpt-oss-20b:2', 'loaded', 32768],
        ['gpt-oss-20b:3', 'loaded', 32768],
      ],
    });
    const { warn, events } = collectWarns();

    const result = await ensureLmStudioModelInstance({
      baseUrl: 'http://localhost:1234',
      model: 'openai/gpt-oss-20b',
      contextLength: 32768,
      warn,
      fetchImpl,
    });

    expect(result.loaded).toBe(true);
    expect(loadCalls(calls)).toHaveLength(0);
    const unloaded = unloadCalls(calls).map((c) => c.body.instance_id).sort();
    expect(unloaded).toHaveLength(2);
    expect(unloaded).not.toContain(result.instanceId);
    expect(events.map((e) => e.event)).toContain('lmstudio.instances.converge-sweep');
  });

  it('replaces undersized instances by loading FIRST, then sweeping the old one', async () => {
    const server = stubServer({
      v0: [['gpt-oss-20b', 'loaded', 4096]],
      onLoad: () => jsonResponse({ instance_id: 'gpt-oss-20b:2', status: 'loaded' }),
      afterLoad: () => {
        server.state.v0 = [
          ['gpt-oss-20b', 'loaded', 4096],
          ['gpt-oss-20b:2', 'loaded', 32768],
        ];
      },
    });
    const { warn, events } = collectWarns();

    const result = await ensureLmStudioModelInstance({
      baseUrl: 'http://localhost:1234',
      model: 'openai/gpt-oss-20b',
      contextLength: 32768,
      warn,
      fetchImpl: server.fetchImpl,
    });

    const loads = loadCalls(server.calls);
    expect(loads).toHaveLength(1);
    expect(loads[0].body).toEqual({
      model: 'openai/gpt-oss-20b',
      context_length: 32768,
      flash_attention: true,
    });
    // Old 4K instance swept AFTER the replacement load, never before —
    // there is no zero-instance gap for runs pinned to it.
    const loadIndex = server.calls.findIndex((c) => c.url.endsWith('/models/load'));
    const unloads = unloadCalls(server.calls);
    expect(unloads.map((c) => c.body.instance_id)).toEqual(['gpt-oss-20b']);
    expect(server.calls.indexOf(unloads[0])).toBeGreaterThan(loadIndex);
    expect(result).toEqual({ instanceId: 'gpt-oss-20b:2', loaded: true });
    expect(events.map((e) => e.event)).toContain('lmstudio.instances.replacing-undersized');
  });

  it('never pins to a mid-load instance and never stacks a load beside it', async () => {
    const { fetchImpl, calls } = stubServer({
      v0: [['gpt-oss-20b', 'loading', undefined]],
    });
    const { warn, events } = collectWarns();

    const result = await ensureLmStudioModelInstance({
      baseUrl: 'http://localhost:1234',
      model: 'openai/gpt-oss-20b',
      contextLength: 32768,
      warn,
      fetchImpl,
    });

    expect(result).toEqual({ instanceId: null, loaded: false });
    expect(loadCalls(calls)).toHaveLength(0);
    expect(unloadCalls(calls)).toHaveLength(0);
    expect(events.map((e) => e.event)).toContain('lmstudio.instances.instance-still-loading');
  });

  it('does not speculatively load when both list sources are unreachable', async () => {
    const { fetchImpl, calls } = stubServer({ listsUnreachable: true });
    const { warn, events } = collectWarns();

    const result = await ensureLmStudioModelInstance({
      baseUrl: 'http://localhost:1234',
      model: 'openai/gpt-oss-20b',
      contextLength: 32768,
      warn,
      fetchImpl,
    });

    expect(result).toEqual({ instanceId: null, loaded: false });
    expect(loadCalls(calls)).toHaveLength(0);
    expect(events.map((e) => e.event)).toContain('lmstudio.instances.state-unavailable');
  });

  it('loads when nothing is loaded and pins the confirmed instance id', async () => {
    const server = stubServer({
      v0: [],
      onLoad: (body) => jsonResponse({ instance_id: `${body.model}:1`, status: 'loaded' }),
      afterLoad: () => {
        server.state.v0 = [['openai/gpt-oss-20b:1', 'loaded', 32768]];
      },
    });

    const result = await ensureLmStudioModelInstance({
      baseUrl: 'http://localhost:1234',
      model: 'openai/gpt-oss-20b',
      contextLength: 32768,
      fetchImpl: server.fetchImpl,
    });

    expect(loadCalls(server.calls)).toHaveLength(1);
    expect(result).toEqual({ instanceId: 'openai/gpt-oss-20b:1', loaded: true });
  });

  it('single-flights concurrent ensures for the same endpoint+model', async () => {
    const server = stubServer({
      v0: [],
      delayMs: 10,
      afterLoad: () => {
        server.state.v0 = [['solo-model', 'loaded', 32768]];
      },
    });

    const options = {
      baseUrl: 'http://localhost:4321',
      model: 'solo-model',
      contextLength: 32768,
      fetchImpl: server.fetchImpl,
    };
    const [a, b, c] = await Promise.all([
      ensureLmStudioModelInstance(options),
      ensureLmStudioModelInstance(options),
      ensureLmStudioModelInstance(options),
    ]);

    // One shared ensure → exactly one load POST despite three racers.
    expect(loadCalls(server.calls)).toHaveLength(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.loaded).toBe(true);
  });

  it('shares one flight across vendor-prefix spellings of the same model', async () => {
    const server = stubServer({
      v0: [],
      delayMs: 10,
      afterLoad: (body) => {
        server.state.v0 = [['spelling-model', 'loaded', 32768]];
      },
    });

    const base = { baseUrl: 'http://localhost:4322', contextLength: 32768, fetchImpl: server.fetchImpl };
    const [a, b] = await Promise.all([
      ensureLmStudioModelInstance({ ...base, model: 'openai/spelling-model' }),
      ensureLmStudioModelInstance({ ...base, model: 'spelling-model' }),
    ]);

    // Without key canonicalization each spelling would run its own ensure
    // and both would load — the exact leak this module prevents.
    expect(loadCalls(server.calls)).toHaveLength(1);
    expect(a.loaded).toBe(true);
    expect(b.loaded).toBe(true);
  });

  it('re-ensures a joiner that needs more context than the in-flight ensure', async () => {
    const server = stubServer({
      v0: [],
      delayMs: 10,
      onLoad: (body) => jsonResponse({ instance_id: `joiner-model:${body.context_length}`, status: 'loaded' }),
      afterLoad: (body) => {
        server.state.v0 = [[`joiner-model:${body.context_length}`, 'loaded', body.context_length]];
      },
    });

    const base = { baseUrl: 'http://localhost:4323', model: 'joiner-model', fetchImpl: server.fetchImpl };
    const [small, large] = await Promise.all([
      ensureLmStudioModelInstance({ ...base, contextLength: 32768 }),
      ensureLmStudioModelInstance({ ...base, contextLength: 65536 }),
    ]);

    // The 64K caller must not be handed the 32K flight's result: it chains
    // a second ensure, which replaces the undersized instance.
    expect(small.loaded).toBe(true);
    expect(large.loaded).toBe(true);
    const loads = loadCalls(server.calls);
    expect(loads).toHaveLength(2);
    expect(loads.map((c) => c.body.context_length)).toEqual([32768, 65536]);
    expect(large.instanceId).toBe('joiner-model:65536');
  });

  it('warns loudly when a successful load is invisible to the model lists', async () => {
    const { fetchImpl, calls } = stubServer({
      v0: [],
      onLoad: (body) => jsonResponse({ instance_id: `${body.model}:1`, status: 'loaded' }),
      // No afterLoad — the lists keep reporting nothing, like a rotted source.
    });
    const { warn, events } = collectWarns();

    const result = await ensureLmStudioModelInstance({
      baseUrl: 'http://localhost:1234',
      model: 'phantom-model',
      contextLength: 32768,
      warn,
      fetchImpl,
    });

    expect(loadCalls(calls)).toHaveLength(1);
    expect(result).toEqual({ instanceId: 'phantom-model:1', loaded: true });
    expect(events.map((e) => e.event)).toContain('lmstudio.instances.loaded-state-source-lying');
  });

  it('returns loaded:false without throwing when the load is rejected', async () => {
    const { fetchImpl } = stubServer({
      v0: [],
      onLoad: () => new Response('{"error":{"type":"invalid_request"}}', { status: 400 }),
    });
    const { warn, events } = collectWarns();

    const result = await ensureLmStudioModelInstance({
      baseUrl: 'http://localhost:1234',
      model: 'bad-model',
      contextLength: 32768,
      warn,
      fetchImpl,
    });

    expect(result).toEqual({ instanceId: null, loaded: false });
    expect(events.map((e) => e.event)).toContain('lmstudio.instances.load-failed');
  });

  it('returns loaded:false without throwing when the server is unreachable', async () => {
    const fetchImpl: LmStudioTimedFetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await ensureLmStudioModelInstance({
      baseUrl: 'http://localhost:1234',
      model: 'down-model',
      contextLength: 32768,
      warn: () => {},
      fetchImpl,
    });

    expect(result).toEqual({ instanceId: null, loaded: false });
  });

  it('normalizes a /v1-suffixed baseUrl to the control root', async () => {
    const { fetchImpl, calls } = stubServer({
      v0: [['some-model', 'loaded', 32768]],
    });

    await ensureLmStudioModelInstance({
      baseUrl: 'http://localhost:1234/v1',
      model: 'some-model',
      contextLength: 16384,
      fetchImpl,
    });

    expect(calls.every((c) => !c.url.includes('/v1/api/'))).toBe(true);
    expect(calls[0].url).toBe('http://localhost:1234/api/v0/models');
  });
});

describe('unloadLmStudioInstance', () => {
  it('treats 404 (already gone) as success', async () => {
    const fetchImpl: LmStudioTimedFetch = async () =>
      new Response('{"error":{"type":"model_not_found"}}', { status: 404 });

    const ok = await unloadLmStudioInstance('http://localhost:1234', 'gone:2', () => {}, fetchImpl);

    expect(ok).toBe(true);
  });

  it('POSTs the instance_id body shape the API requires', async () => {
    const { fetchImpl, calls } = stubServer({ v0: [['m:2', 'loaded', 4096]] });

    const ok = await unloadLmStudioInstance('http://localhost:1234', 'm:2', () => {}, fetchImpl);

    expect(ok).toBe(true);
    expect(unloadCalls(calls)[0].body).toEqual({ instance_id: 'm:2' });
  });
});
