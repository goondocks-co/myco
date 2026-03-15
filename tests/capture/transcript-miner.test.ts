import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TranscriptMiner, extractTurnsFromBuffer } from '../../src/capture/transcript-miner.js';
import { claudeCodeAdapter } from '../../src/agents/claude-code.js';
import { createPerProjectAdapter } from '../../src/agents/adapter.js';
import { AgentRegistry } from '../../src/agents/registry.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('TranscriptMiner with AgentRegistry', () => {
  let tmpDir: string;
  let projectDir: string;
  const sessionId = 'test-session-abc123';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miner-test-'));
    projectDir = path.join(tmpDir, '-test-project');
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTranscript(entries: Record<string, unknown>[]) {
    const lines = entries.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines + '\n');
  }

  function createMiner(): TranscriptMiner {
    return new TranscriptMiner({
      additionalAdapters: [createPerProjectAdapter(tmpDir, claudeCodeAdapter.parseTurns, 'test-agent')],
    });
  }

  describe('getAllTurns', () => {
    it('extracts user-assistant turn pairs', () => {
      writeTranscript([
        { type: 'system', content: 'init', timestamp: '2026-03-15T10:00:00Z' },
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Fix the bug' }] },
          timestamp: '2026-03-15T10:01:00Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'I found the issue.' }] },
          timestamp: '2026-03-15T10:01:30Z',
        },
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Ship it' }] },
          timestamp: '2026-03-15T10:02:00Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Done.' }] },
          timestamp: '2026-03-15T10:02:30Z',
        },
      ]);

      const turns = createMiner().getAllTurns(sessionId);

      expect(turns).toHaveLength(2);
      expect(turns[0].prompt).toBe('Fix the bug');
      expect(turns[0].aiResponse).toBe('I found the issue.');
      expect(turns[0].timestamp).toBe('2026-03-15T10:01:00Z');
      expect(turns[1].prompt).toBe('Ship it');
      expect(turns[1].aiResponse).toBe('Done.');
    });

    it('counts tool_use blocks from assistant messages', () => {
      writeTranscript([
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Read the file' }] },
          timestamp: '2026-03-15T10:00:00Z',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: {} },
              { type: 'tool_use', id: 't2', name: 'Grep', input: {} },
              { type: 'text', text: 'Here is the content.' },
            ],
          },
          timestamp: '2026-03-15T10:00:30Z',
        },
      ]);

      const turns = createMiner().getAllTurns(sessionId);

      expect(turns).toHaveLength(1);
      expect(turns[0].toolCount).toBe(2);
      expect(turns[0].aiResponse).toBe('Here is the content.');
    });

    it('treats tool_result user messages as part of the current turn', () => {
      // In Claude's API format, tool results are sent as "user" messages
      // but they should NOT start new turns — they're part of the tool-use cycle
      writeTranscript([
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Fix the bug' }] },
          timestamp: '2026-03-15T10:00:00Z',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/foo.ts' } },
            ],
          },
          timestamp: '2026-03-15T10:00:10Z',
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'file contents here' },
            ],
          },
          timestamp: '2026-03-15T10:00:11Z',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/foo.ts' } },
            ],
          },
          timestamp: '2026-03-15T10:00:20Z',
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't2', content: 'edit applied' },
            ],
          },
          timestamp: '2026-03-15T10:00:21Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Fixed the null check.' }] },
          timestamp: '2026-03-15T10:00:30Z',
        },
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Now test it' }] },
          timestamp: '2026-03-15T10:01:00Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Tests pass.' }] },
          timestamp: '2026-03-15T10:01:30Z',
        },
      ]);

      const turns = createMiner().getAllTurns(sessionId);

      expect(turns).toHaveLength(2);
      expect(turns[0].prompt).toBe('Fix the bug');
      expect(turns[0].toolCount).toBe(2);
      expect(turns[0].aiResponse).toBe('Fixed the null check.');
      expect(turns[1].prompt).toBe('Now test it');
      expect(turns[1].toolCount).toBe(0);
      expect(turns[1].aiResponse).toBe('Tests pass.');
    });

    it('returns empty array for missing transcript', () => {
      const turns = createMiner().getAllTurns('nonexistent-session');
      expect(turns).toEqual([]);
    });

    it('handles turns without AI response', () => {
      writeTranscript([
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Do something' }] },
          timestamp: '2026-03-15T10:00:00Z',
        },
      ]);

      const turns = createMiner().getAllTurns(sessionId);

      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Do something');
      expect(turns[0].aiResponse).toBeUndefined();
    });

    it('skips non-conversation entry types', () => {
      writeTranscript([
        { type: 'system', content: 'bridge', timestamp: '2026-03-15T10:00:00Z' },
        { type: 'progress', content: 'loading', timestamp: '2026-03-15T10:00:01Z' },
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Hello' }] },
          timestamp: '2026-03-15T10:00:02Z',
        },
        { type: 'progress', content: 'thinking', timestamp: '2026-03-15T10:00:03Z' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hi!' }] },
          timestamp: '2026-03-15T10:00:04Z',
        },
        { type: 'file-history-snapshot', content: {}, timestamp: '2026-03-15T10:00:05Z' },
      ]);

      const turns = createMiner().getAllTurns(sessionId);

      expect(turns).toHaveLength(1);
      expect(turns[0].prompt).toBe('Hello');
      expect(turns[0].aiResponse).toBe('Hi!');
    });
  });

  describe('getAllTurnsWithSource', () => {
    it('reports the source adapter name', () => {
      writeTranscript([
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'Test' }] },
          timestamp: '2026-03-15T10:00:00Z',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Ok' }] },
          timestamp: '2026-03-15T10:00:30Z',
        },
      ]);

      const result = createMiner().getAllTurnsWithSource(sessionId);
      expect(result.source).toBe('test-agent');
      expect(result.turns).toHaveLength(1);
    });

    it('reports none when no transcript found', () => {
      const result = createMiner().getAllTurnsWithSource('missing');
      expect(result.source).toBe('none');
      expect(result.turns).toEqual([]);
    });
  });
});

describe('AgentRegistry', () => {
  it('detects active agent from environment', () => {
    const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = '/some/path';
    try {
      const registry = new AgentRegistry();
      const active = registry.detectActiveAgent();
      expect(active?.name).toBe('claude-code');
    } finally {
      if (originalEnv !== undefined) {
        process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
      } else {
        delete process.env.CLAUDE_PLUGIN_ROOT;
      }
    }
  });

  it('lists all registered adapters', () => {
    const registry = new AgentRegistry();
    expect(registry.adapterNames).toContain('claude-code');
    expect(registry.adapterNames).toContain('cursor');
  });
});

describe('extractTurnsFromBuffer', () => {
  it('builds turns from buffer events', () => {
    const events = [
      { type: 'user_prompt', prompt: 'Fix the bug', timestamp: '2026-03-15T10:00:00Z' },
      { type: 'tool_use', tool: 'Read', timestamp: '2026-03-15T10:00:10Z' },
      { type: 'tool_use', tool: 'Edit', timestamp: '2026-03-15T10:00:20Z' },
      { type: 'user_prompt', prompt: 'Now test it', timestamp: '2026-03-15T10:01:00Z' },
      { type: 'tool_use', tool: 'Bash', timestamp: '2026-03-15T10:01:10Z' },
    ];

    const turns = extractTurnsFromBuffer(events);

    expect(turns).toHaveLength(2);
    expect(turns[0].prompt).toBe('Fix the bug');
    expect(turns[0].toolCount).toBe(2);
    expect(turns[0].aiResponse).toBeUndefined();
    expect(turns[1].prompt).toBe('Now test it');
    expect(turns[1].toolCount).toBe(1);
  });

  it('returns empty for no events', () => {
    expect(extractTurnsFromBuffer([])).toEqual([]);
  });
});
