import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MycoPlugin,
  collectAssistantSummaryFromMessages,
  normalizeToolInput,
} from '../../src/symbionts/templates/opencode/plugin.ts';

function createProjectDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-opencode-plugin-'));
  fs.mkdirSync(path.join(directory, '.myco'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, '.myco', 'daemon.json'),
    JSON.stringify({ port: 32123 }),
    'utf-8',
  );
  return directory;
}

describe('opencode plugin helpers', () => {
  it('normalizes high-signal tool metadata aliases', () => {
    expect(
      normalizeToolInput({
        filePath: 'src/plugin.ts',
        cwd: '/repo',
        command: 'npm test',
      }),
    ).toEqual({
      filePath: 'src/plugin.ts',
      cwd: '/repo',
      command: 'npm test',
      file_path: 'src/plugin.ts',
      workdir: '/repo',
    });
  });

  it('collects the latest contiguous assistant block', () => {
    const summary = collectAssistantSummaryFromMessages([
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'older assistant block' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'new prompt' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'step 1' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'step 2' }] },
    ]);

    expect(summary).toBe('step 1\nstep 2');
  });

  it('ignores assistant messages without text parts', () => {
    const summary = collectAssistantSummaryFromMessages([
      { info: { role: 'assistant' }, parts: [{ type: 'tool_use' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'final answer' }] },
    ]);

    expect(summary).toBe('final answer');
  });
});

describe('opencode plugin runtime hooks', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('posts a richer assistant summary on session.idle', async () => {
    const directory = createProjectDir();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const client = {
      app: { log: vi.fn().mockResolvedValue(undefined) },
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [
            { info: { role: 'user' }, parts: [{ type: 'text', text: 'prompt' }] },
            { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'first chunk' }] },
            { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'second chunk' }] },
          ],
        }),
      },
    };

    const plugin = await MycoPlugin({ client, directory, worktree: directory });
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses-opencode-1' } } });

    expect(client.session.messages).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:32123/events/stop');
    expect(JSON.parse(String(init.body))).toMatchObject({
      session_id: 'ses-opencode-1',
      agent: 'opencode',
      last_assistant_message: 'first chunk\nsecond chunk',
    });
  });

  it('normalizes tool metadata before posting tool_use events', async () => {
    const directory = createProjectDir();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const client = {
      app: { log: vi.fn().mockResolvedValue(undefined) },
      session: { messages: vi.fn() },
    };

    const plugin = await MycoPlugin({ client, directory, worktree: directory });
    await plugin['tool.execute.after'](
      {
        sessionID: 'ses-opencode-2',
        tool: 'edit',
        args: {
          filePath: 'src/foo.ts',
          cwd: '/repo',
        },
      },
      {
        output: 'updated',
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:32123/events');
    expect(JSON.parse(String(init.body))).toMatchObject({
      type: 'tool_use',
      session_id: 'ses-opencode-2',
      tool_name: 'edit',
      tool_input: {
        filePath: 'src/foo.ts',
        cwd: '/repo',
        file_path: 'src/foo.ts',
        workdir: '/repo',
      },
      output_preview: 'updated',
    });
  });
});
