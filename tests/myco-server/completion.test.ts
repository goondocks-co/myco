import recorded from '../fixtures/providers/workers-ai-completion.json';
import { describe, expect, it } from 'bun:test';
import { configuredCompletionProvider } from '@myco-server-worker/core/completion/configured-provider.js';
import { cloudflareCompletionProvider } from '@myco-server-worker/platform/cloudflare/completion.js';
import { COMPLETION_OUTPUT_TOKENS } from '@myco-server-worker/core/completion/provider.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';

const request = { messages: [{ role: 'user' as const, content: 'Give the title' }], schema: { type: 'object' } };
const body = { choices: [{ message: { content: '{"title":"Done"}' } }], usage: { prompt_tokens: 12, completion_tokens: 5 } };

describe('platform completions', () => {
  it('defaults to the Workers AI binding, requests schema-bound output and returns text with usage', async () => {
    const f = sqliteEnv();
    let sent: unknown;
    const env = serverEnvFromBindings({ ...f.env, AI: { run: async (_model, input) => { sent = input; return recorded.r; } } });
    const provider = await env.completionProvider!();
    expect(provider?.model).toBe('@cf/openai/gpt-oss-20b');
    expect(await provider!.complete(request)).toEqual({ text: recorded.r.choices[0]!.message.content, usage: { input: recorded.r.usage.prompt_tokens, output: recorded.r.usage.completion_tokens } });
    expect(sent).toMatchObject({ max_tokens: COMPLETION_OUTPUT_TOKENS, response_format: { type: 'json_schema', json_schema: request.schema } });
    f.sqlite.close();
  });

  it('leaves native unconfigured until both endpoint and model are saved, refuses credentials in URLs, and uses HTTP without a key', async () => {
    const f = sqliteEnv();
    const outbound: typeof f.serverEnv.outbound = async (_url, init) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return Response.json(body);
    };
    const get = () => configuredCompletionProvider(f.db, f.serverEnv.wrappingKey, outbound, { target: 'bun' });
    expect(await get()).toBeNull();
    const writer = settingsWriter(f.db, { target: 'bun' });
    const actor = 'mem_machine_1';
    expect((await writer.setLeaf('single_turn.base_url', 'http://user:pass@localhost/v1', actor, 1, 0)).applied).toBe(false);
    expect((await writer.setLeaf('single_turn.base_url', 'http://titles.example.com/v1', actor, 2, 0)).applied).toBe(false);
    expect((await writer.setLeaf('single_turn.base_url', 'http://localhost:1234/v1', actor, 2, 0)).applied).toBe(true);
    expect(await get()).toBeNull();
    expect((await writer.setLeaf('single_turn.model', 'local-model', actor, 3, 0)).applied).toBe(true);
    expect(await (await get())!.complete(request)).toMatchObject({ text: '{"title":"Done"}' });
    f.sqlite.close();
  });

  it('names provider HTTP and malformed answer failures without copying provider text', async () => {
    const provider = cloudflareCompletionProvider({ run: async () => ({ response: null }) }, 'model');
    await expect(provider.complete(request)).rejects.toMatchObject({ code: 'invalid_response' });
    const failed = cloudflareCompletionProvider({ run: async () => { throw new Error('private provider text'); } }, 'model');
    await expect(failed.complete(request)).rejects.toMatchObject({ code: 'unreachable', message: 'completion_unreachable' });
  });
});
