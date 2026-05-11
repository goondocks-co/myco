import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import {
  MycoPlugin,
  collectAssistantSummaryFromMessages,
  normalizeToolInput,
} from '@myco/symbionts/templates/opencode/plugin.ts';

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

function createGroveProjectDir(home: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-opencode-grove-plugin-'));
  fs.mkdirSync(path.join(directory, '.myco'), { recursive: true });
  fs.mkdirSync(path.join(home, 'service'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, '.myco', 'project.toml'),
    '[project]\nid = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n\n[grove]\nid = "grv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\nslug = "work"\nname = "Work"\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(directory, '.myco', 'daemon.json'),
    JSON.stringify({ port: 11111 }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(home, 'service', 'daemon.json'),
    JSON.stringify({ port: 32124 }),
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
  const originalHome = process.env.MYCO_HOME;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalHome;
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

  it('reads global daemon state when project.toml has a Grove binding', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-opencode-home-'));
    process.env.MYCO_HOME = home;
    const directory = createGroveProjectDir(home);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const client = {
      app: { log: vi.fn().mockResolvedValue(undefined) },
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'done' }] }],
        }),
      },
    };

    const plugin = await MycoPlugin({ client, directory, worktree: directory });
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses-opencode-grove' } } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:32124/events/stop');
    const headers = new Headers(init.headers);
    expect(headers.get('x-myco-project-root')).toBe(path.resolve(directory));
    expect(headers.get('x-myco-project-id')).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
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

  it('fetches resume context for resumed sessions and injects it once', async () => {
    const directory = createProjectDir();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/sessions/register')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/context/resume')) {
        return new Response(JSON.stringify({ text: 'Resume recap' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = {
      app: { log: vi.fn().mockResolvedValue(undefined) },
      session: {
        messages: vi.fn(),
        prompt: vi.fn().mockResolvedValue(undefined),
      },
    };

    const plugin = await MycoPlugin({ client, directory, worktree: directory });
    const resumeEvent = {
      event: {
        type: 'session.created',
        properties: { info: { id: 'resume-session', parentID: 'parent-session' } },
      },
    };

    await plugin.event(resumeEvent);
    await plugin.event(resumeEvent);

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: 'resume-session' },
      body: {
        parts: [
          {
            type: 'text',
            text: 'Resume recap',
            synthetic: true,
            metadata: { myco: true },
          },
        ],
        noReply: true,
      },
    });

    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls).toContain('http://localhost:32123/context/resume');
    expect(urls).not.toContain('http://localhost:32123/context');
  });

  it('posts pre-compaction telemetry before appending context', async () => {
    const directory = createProjectDir();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/events')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/context')) {
        return new Response(JSON.stringify({ text: 'Compaction context' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = {
      app: { log: vi.fn().mockResolvedValue(undefined) },
      session: { messages: vi.fn() },
    };

    const plugin = await MycoPlugin({ client, directory, worktree: directory });
    const output = { context: [] as string[] };

    await plugin['experimental.session.compacting'](
      { sessionID: 'ses-compact-1', trigger: 'auto' },
      output,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:32123/events');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      type: 'pre_compact',
      session_id: 'ses-compact-1',
      trigger: 'auto',
    });
    expect(output.context).toEqual([
      '## Myco — Project Context (preserved across compaction)\n\nCompaction context',
    ]);
  });

  describe('server-side drop buffering', () => {
    // Regression: before the fix, the plugin treated HTTP 200 as success
    // regardless of body. The daemon could return `{ ok: true, ignored: "..."}`
    // to silently drop events, and the plugin would never route them to the
    // on-disk buffer. That's how a stale capture rule erased every event of a
    // live opencode session across a daemon restart. An ignored response must
    // trigger the same buffer write as a transport failure would.

    function bufferLinesFor(directory: string, sessionId: string): string[] {
      const bufferPath = path.join(directory, '.myco', 'buffer', `${sessionId}.jsonl`);
      if (!fs.existsSync(bufferPath)) return [];
      return fs.readFileSync(bufferPath, 'utf-8').trim().split('\n').filter(Boolean);
    }

    it('buffers a chat.message event when daemon returns 200 with ignored field', async () => {
      const directory = createProjectDir();
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, ignored: 'ephemeral-sub-invocation' }), { status: 200 }),
      );
      globalThis.fetch = fetchMock as typeof fetch;

      const client = { app: { log: vi.fn().mockResolvedValue(undefined) }, session: { messages: vi.fn() } };
      const plugin = await MycoPlugin({ client, directory, worktree: directory });

      await plugin['chat.message'](
        { sessionID: 'ses-silent-drop-1' },
        { parts: [{ type: 'text', text: 'a real user prompt' }] },
      );

      const lines = bufferLinesFor(directory, 'ses-silent-drop-1');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        type: 'user_prompt',
        agent: 'opencode',
        prompt: 'a real user prompt',
      });

      fs.rmSync(directory, { recursive: true, force: true });
    });

    it('does NOT buffer when daemon returns 200 without ignored field', async () => {
      const directory = createProjectDir();
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      globalThis.fetch = fetchMock as typeof fetch;

      const client = { app: { log: vi.fn().mockResolvedValue(undefined) }, session: { messages: vi.fn() } };
      const plugin = await MycoPlugin({ client, directory, worktree: directory });

      await plugin['chat.message'](
        { sessionID: 'ses-silent-drop-2' },
        { parts: [{ type: 'text', text: 'happy path prompt' }] },
      );

      expect(bufferLinesFor(directory, 'ses-silent-drop-2')).toEqual([]);

      fs.rmSync(directory, { recursive: true, force: true });
    });

    it('buffers a tool.execute.after event when daemon returns 200 with ignored', async () => {
      const directory = createProjectDir();
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, ignored: 'rule' }), { status: 200 }),
      );
      globalThis.fetch = fetchMock as typeof fetch;

      const client = { app: { log: vi.fn().mockResolvedValue(undefined) }, session: { messages: vi.fn() } };
      const plugin = await MycoPlugin({ client, directory, worktree: directory });

      await plugin['tool.execute.after'](
        { sessionID: 'ses-silent-drop-3', tool: 'read', args: { file_path: '/a/b.ts' } },
        { output: 'file contents', metadata: {} },
      );

      const lines = bufferLinesFor(directory, 'ses-silent-drop-3');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        type: 'tool_use',
        agent: 'opencode',
        tool_name: 'read',
      });

      fs.rmSync(directory, { recursive: true, force: true });
    });
  });
});
