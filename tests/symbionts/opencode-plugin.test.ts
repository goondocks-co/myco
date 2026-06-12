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

  describe('per-prompt context injection (chat.message)', () => {
    function makeClient() {
      return { app: { log: vi.fn().mockResolvedValue(undefined) }, session: { messages: vi.fn(), prompt: vi.fn() } };
    }

    function userOutput() {
      return {
        parts: [
          {
            id: 'prt_0123456789abcdefghijklmn',
            messageID: 'msg_user_1',
            sessionID: 'ses-prompt-ctx',
            type: 'text',
            text: 'how does the outbox drain work?',
          },
        ],
      };
    }

    it('posts capture (/events) then context (/context/prompt) with {prompt, session_id}, in that order', async () => {
      const directory = createProjectDir();
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/context/prompt')) {
          return new Response(JSON.stringify({ text: 'Relevant spores' }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      globalThis.fetch = fetchMock as typeof fetch;

      const plugin = await MycoPlugin({ client: makeClient(), directory, worktree: directory });
      await plugin['chat.message']({ sessionID: 'ses-prompt-ctx' }, userOutput());

      const urls = fetchMock.mock.calls.map((call) => call[0]);
      expect(urls).toEqual([
        'http://localhost:32123/events',
        'http://localhost:32123/context/prompt',
      ]);
      expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toMatchObject({
        prompt: 'how does the outbox drain work?',
        session_id: 'ses-prompt-ctx',
      });
    });

    it('pushes one myco-marked text part mirroring the user part identity fields when context is non-empty', async () => {
      const directory = createProjectDir();
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/context/prompt')) {
          return new Response(JSON.stringify({ text: 'Relevant spores' }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      globalThis.fetch = fetchMock as typeof fetch;

      const plugin = await MycoPlugin({ client: makeClient(), directory, worktree: directory });
      const output = userOutput();
      const originalParts = output.parts;
      await plugin['chat.message']({ sessionID: 'ses-prompt-ctx' }, output);

      // In-place push — the original array binding must gain the part.
      expect(output.parts).toBe(originalParts);
      expect(output.parts).toHaveLength(2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const injected = output.parts[1] as any;
      expect(injected).toMatchObject({
        type: 'text',
        text: 'Relevant spores',
        synthetic: true,
        metadata: { myco: true },
        messageID: 'msg_user_1',
        sessionID: 'ses-prompt-ctx',
      });
      expect(injected.id).toMatch(/^prt_/);
      expect(injected.id).not.toBe('prt_0123456789abcdefghijklmn');
    });

    it('leaves output.parts unchanged when the daemon returns empty context text', async () => {
      const directory = createProjectDir();
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/context/prompt')) {
          return new Response(JSON.stringify({ text: '' }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      globalThis.fetch = fetchMock as typeof fetch;

      const plugin = await MycoPlugin({ client: makeClient(), directory, worktree: directory });
      const output = userOutput();
      await plugin['chat.message']({ sessionID: 'ses-prompt-ctx' }, output);

      expect(output.parts).toHaveLength(1);
    });

    it('skips capture AND context fetch for a pure-myco synthetic message', async () => {
      const directory = createProjectDir();
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      globalThis.fetch = fetchMock as typeof fetch;

      const plugin = await MycoPlugin({ client: makeClient(), directory, worktree: directory });
      await plugin['chat.message'](
        { sessionID: 'ses-prompt-ctx' },
        { parts: [{ type: 'text', text: 'Session digest', synthetic: true, metadata: { myco: true } }] },
      );

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('captures and fetches context for a MIXED message (real user text alongside a myco part)', async () => {
      // Tightened re-entrancy guard: the old guard skipped the whole message
      // when ANY part carried the myco marker, silently dropping real user
      // prompts in messages that also contained an injected part. Only the
      // absence of non-myco user text skips now.
      const directory = createProjectDir();
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/context/prompt')) {
          return new Response(JSON.stringify({ text: '' }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      globalThis.fetch = fetchMock as typeof fetch;

      const plugin = await MycoPlugin({ client: makeClient(), directory, worktree: directory });
      await plugin['chat.message'](
        { sessionID: 'ses-prompt-ctx' },
        {
          parts: [
            { type: 'text', text: 'Session digest', synthetic: true, metadata: { myco: true } },
            { id: 'prt_zzzz', messageID: 'msg_user_2', sessionID: 'ses-prompt-ctx', type: 'text', text: 'real question' },
          ],
        },
      );

      const urls = fetchMock.mock.calls.map((call) => call[0]);
      expect(urls).toEqual([
        'http://localhost:32123/events',
        'http://localhost:32123/context/prompt',
      ]);
      // The myco part is excluded from the captured prompt text.
      expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({
        type: 'user_prompt',
        prompt: 'real question',
      });
    });

    it('does not throw or mutate output.parts when the /context/prompt fetch fails', async () => {
      const directory = createProjectDir();
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/context/prompt')) {
          throw new Error('connection refused');
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      globalThis.fetch = fetchMock as typeof fetch;

      const plugin = await MycoPlugin({ client: makeClient(), directory, worktree: directory });
      const output = userOutput();
      await plugin['chat.message']({ sessionID: 'ses-prompt-ctx' }, output);

      expect(output.parts).toHaveLength(1);
    });
  });

  describe('server-side drop buffering', () => {
    // The plugin's buffer fallback (`shouldBufferPluginFallback`) mirrors
    // the hook CLI's contract: a deliberate `ignored` is never buffered in
    // any response shape — ignored ≠ lost, and buffering it would resurrect
    // a deliberately-dropped event on the daemon's next startup reconcile.
    //
    // Post-global-install (plan 38cff0752c919ffd §2), the buffer lives at
    // `~/.myco/groves/<groveId>/projects/<projectId>/buffer/`. Tests seed a
    // tmp MYCO_HOME and a project.toml so the plugin resolves the Grove-
    // scoped path; without project.toml the plugin DROPS the event (matches
    // the daemon-side `buffer-location.ts` tenet — no non-canonical writes).

    function bufferLinesAt(mycoHome: string, sessionId: string): string[] {
      const bufferPath = path.join(
        mycoHome,
        'groves', 'grv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'projects', 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'buffer', `${sessionId}.jsonl`,
      );
      if (!fs.existsSync(bufferPath)) return [];
      return fs.readFileSync(bufferPath, 'utf-8').trim().split('\n').filter(Boolean);
    }

    function setupHome(): { home: string; directory: string; restore: () => void } {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-opencode-drop-home-'));
      const directory = createGroveProjectDir(home);
      const prev = process.env.MYCO_HOME;
      process.env.MYCO_HOME = home;
      return {
        home,
        directory,
        restore: () => {
          if (prev === undefined) delete process.env.MYCO_HOME;
          else process.env.MYCO_HOME = prev;
          fs.rmSync(home, { recursive: true, force: true });
          fs.rmSync(directory, { recursive: true, force: true });
        },
      };
    }

    it('does NOT buffer a chat.message event the daemon ignored (no persisted field)', async () => {
      const ctx = setupHome();
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, ignored: 'ephemeral-sub-invocation' }), { status: 200 }),
      );
      globalThis.fetch = fetchMock as typeof fetch;

      const client = { app: { log: vi.fn().mockResolvedValue(undefined) }, session: { messages: vi.fn() } };
      const plugin = await MycoPlugin({ client, directory: ctx.directory, worktree: ctx.directory });

      await plugin['chat.message'](
        { sessionID: 'ses-silent-drop-1' },
        { parts: [{ type: 'text', text: 'a real user prompt' }] },
      );

      expect(bufferLinesAt(ctx.home, 'ses-silent-drop-1')).toEqual([]);

      ctx.restore();
    });

    it('does NOT buffer when daemon returns 200 without ignored field', async () => {
      const ctx = setupHome();
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      globalThis.fetch = fetchMock as typeof fetch;

      const client = { app: { log: vi.fn().mockResolvedValue(undefined) }, session: { messages: vi.fn() } };
      const plugin = await MycoPlugin({ client, directory: ctx.directory, worktree: ctx.directory });

      await plugin['chat.message'](
        { sessionID: 'ses-silent-drop-2' },
        { parts: [{ type: 'text', text: 'happy path prompt' }] },
      );

      expect(bufferLinesAt(ctx.home, 'ses-silent-drop-2')).toEqual([]);

      ctx.restore();
    });

    it('does NOT buffer a tool.execute.after event on a daemon ignore (replay would resurrect a dropped tool)', async () => {
      // tool_use replays directly without re-evaluating capture rules
      // (CAPTURE_EVENT_POLICY.tool_use replayMode 'direct'), so buffering
      // an ignored tool would re-insert a deliberately-dropped activity
      // on the daemon's next startup reconcile.
      const ctx = setupHome();
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, ignored: 'rule' }), { status: 200 }),
      );
      globalThis.fetch = fetchMock as typeof fetch;

      const client = { app: { log: vi.fn().mockResolvedValue(undefined) }, session: { messages: vi.fn() } };
      const plugin = await MycoPlugin({ client, directory: ctx.directory, worktree: ctx.directory });

      await plugin['tool.execute.after'](
        { sessionID: 'ses-silent-drop-3', tool: 'read', args: { file_path: '/a/b.ts' } },
        { output: 'file contents', metadata: {} },
      );

      expect(bufferLinesAt(ctx.home, 'ses-silent-drop-3')).toEqual([]);

      ctx.restore();
    });

    it('never buffers a daemon ignore that carries the honest contract fields', async () => {
      // `ignored` is deliberate (capture rule, dedup, tombstone) and must
      // not be resurrected via the buffer — with or without `persisted`.
      const ctx = setupHome();
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, ignored: 'rule', persisted: false }), { status: 200 }),
      );
      globalThis.fetch = fetchMock as typeof fetch;

      const client = { app: { log: vi.fn().mockResolvedValue(undefined) }, session: { messages: vi.fn() } };
      const plugin = await MycoPlugin({ client, directory: ctx.directory, worktree: ctx.directory });

      await plugin['chat.message'](
        { sessionID: 'ses-contract-ignored-1' },
        { parts: [{ type: 'text', text: 'a deliberately-ignored prompt' }] },
      );

      expect(bufferLinesAt(ctx.home, 'ses-contract-ignored-1')).toEqual([]);

      ctx.restore();
    });

    it('does not buffer when the daemon failed to persist but holds a buffered copy', async () => {
      const ctx = setupHome();
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, persisted: false, buffered: true }), { status: 200 }),
      );
      globalThis.fetch = fetchMock as typeof fetch;

      const client = { app: { log: vi.fn().mockResolvedValue(undefined) }, session: { messages: vi.fn() } };
      const plugin = await MycoPlugin({ client, directory: ctx.directory, worktree: ctx.directory });

      await plugin['chat.message'](
        { sessionID: 'ses-daemon-buffered-1' },
        { parts: [{ type: 'text', text: 'daemon holds the durable copy' }] },
      );

      expect(bufferLinesAt(ctx.home, 'ses-daemon-buffered-1')).toEqual([]);

      ctx.restore();
    });

    it('buffers the one honest-fallback case: persisted:false with no daemon-side copy', async () => {
      const ctx = setupHome();
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, persisted: false, buffered: false }), { status: 200 }),
      );
      globalThis.fetch = fetchMock as typeof fetch;

      const client = { app: { log: vi.fn().mockResolvedValue(undefined) }, session: { messages: vi.fn() } };
      const plugin = await MycoPlugin({ client, directory: ctx.directory, worktree: ctx.directory });

      await plugin['chat.message'](
        { sessionID: 'ses-honest-fallback-1' },
        { parts: [{ type: 'text', text: 'no durable copy anywhere' }] },
      );

      const lines = bufferLinesAt(ctx.home, 'ses-honest-fallback-1');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        type: 'user_prompt',
        agent: 'opencode',
        prompt: 'no durable copy anywhere',
      });

      ctx.restore();
    });
  });
});
