import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MycoClinePlugin,
  extractLatestUserPrompt,
  extractSessionId,
  extractWorkspaceRoot,
  shouldBufferPluginFallback,
  summarizeToolOutput,
} from '@myco/symbionts/templates/cline/plugin.ts';

const originalFetch = globalThis.fetch;
const originalMycoHome = process.env.MYCO_HOME;

function makeProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cline-plugin-'));
  fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
  fs.writeFileSync(path.join(project, '.myco', 'daemon.json'), JSON.stringify({
    port: 45678,
    auth_token: 'secret',
  }));
  return project;
}

function makeContext(project: string, sessionId: string, promptId = 'prompt-1') {
  return {
    snapshot: {
      agentId: 'agent-1',
      conversationId: sessionId,
      status: 'running',
      iteration: 1,
      messages: [],
      pendingToolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    request: {
      messages: [
        {
          id: promptId,
          role: 'user',
          content: [{ type: 'text', text: 'Explain the install path.' }],
          createdAt: Date.now(),
        },
      ],
      tools: [],
    },
    cwd: project,
  };
}

describe('Cline Myco plugin template', () => {
  beforeEach(() => {
    delete process.env.MYCO_HOME;
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalMycoHome;
  });

  it('exports a Cline AgentExtension shape with hooks capability', () => {
    expect(MycoClinePlugin.name).toBe('myco');
    expect(MycoClinePlugin.manifest.capabilities).toEqual(['hooks']);
    expect(typeof MycoClinePlugin.setup).toBe('function');
    expect(typeof MycoClinePlugin.hooks.beforeModel).toBe('function');
    expect(typeof MycoClinePlugin.hooks.afterTool).toBe('function');
    expect(typeof MycoClinePlugin.hooks.afterRun).toBe('function');
  });

  it('extracts Cline session, workspace, and latest human prompt', () => {
    const project = '/tmp/myco-cline-test';
    MycoClinePlugin.setup({}, {
      session: { sessionId: 'setup-session' },
      workspaceInfo: { rootPath: project, latestGitBranchName: 'feature/cline' },
    });
    const context = makeContext(project, 'conversation-1');

    expect(extractSessionId(context)).toBe('conversation-1');
    expect(extractWorkspaceRoot(context)).toBe(project);
    expect(extractLatestUserPrompt(context)).toEqual({
      key: 'prompt-1',
      text: 'Explain the install path.',
    });
  });

  it('ignores Myco synthetic context messages when finding user prompts', () => {
    const context = makeContext('/tmp/myco-cline-test', 'conversation-2');
    context.request.messages.push({
      id: 'myco-context',
      role: 'user',
      content: [{ type: 'text', text: 'Synthetic context' }],
      createdAt: Date.now(),
      metadata: { myco: true },
    } as never);

    expect(extractLatestUserPrompt(context)).toEqual({
      key: 'prompt-1',
      text: 'Explain the install path.',
    });
  });

  it('keeps degraded mode invisible when the daemon is absent', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cline-no-daemon-'));
    const context = makeContext(project, 'conversation-3');

    await expect(MycoClinePlugin.hooks.beforeModel(context)).resolves.toBeUndefined();
    await expect(MycoClinePlugin.hooks.afterTool({
      ...context,
      tool: { name: 'editor' },
      toolCall: { toolName: 'editor', input: { path: 'README.md' } },
      input: { path: 'README.md' },
      result: { output: 'ok' },
    })).resolves.toBeUndefined();
  });

  it('captures a prompt and appends Myco context through beforeModel', async () => {
    const project = makeProject();
    const calls: Array<{ url: string; body?: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      const pathname = new URL(String(url)).pathname;
      const responseBody = pathname === '/context'
        ? { text: 'Session context' }
        : pathname === '/context/prompt'
          ? { additionalContext: 'Per-prompt context' }
          : pathname === '/events'
            ? { persisted: true, batchId: 42 }
            : { ok: true };
      return new Response(JSON.stringify(responseBody), { status: 200 });
    }) as typeof fetch;

    MycoClinePlugin.setup({}, {
      session: { sessionId: 'setup-session' },
      workspaceInfo: { rootPath: project, latestGitBranchName: 'feature/cline' },
    });

    const result = await MycoClinePlugin.hooks.beforeModel(makeContext(project, 'conversation-4'));
    expect(result?.messages).toHaveLength(2);
    expect(JSON.stringify(result?.messages?.[1])).toContain('Session context');
    expect(JSON.stringify(result?.messages?.[1])).toContain('Per-prompt context');
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/sessions/register',
      '/events',
      '/context',
      '/context/prompt',
    ]);
    expect(calls[1]!.body).toMatchObject({
      type: 'user_prompt',
      session_id: 'conversation-4',
      agent: 'cline',
      prompt: 'Explain the install path.',
      kind: 'initial',
    });
  });

  it('summarizes tool output and mirrors buffer fallback decisions', () => {
    expect(summarizeToolOutput('x'.repeat(250))).toBe(`${'x'.repeat(200)}...`);
    expect(summarizeToolOutput({ ok: true })).toBe('{"ok":true}');
    expect(shouldBufferPluginFallback({ ok: false }, 'tool_use')).toBe(true);
    expect(shouldBufferPluginFallback({ ok: true, data: { ignored: 'rule' } }, 'tool_use')).toBe(false);
    expect(shouldBufferPluginFallback({ ok: true, data: { persisted: false } }, 'user_prompt')).toBe(true);
  });
});
