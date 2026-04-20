import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Tmp fixtures
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ups-kind-test-'));
const vaultDir = path.join(tmpDir, 'vault');
const transcriptDir = path.join(tmpDir, 'transcripts');
fs.mkdirSync(vaultDir, { recursive: true });
fs.mkdirSync(transcriptDir, { recursive: true });
// Write a minimal myco.yaml so the vault guard passes
fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 1\n');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper to write a JSONL transcript fixture.
// Includes a padding first line so parseJsonlTail's first-line-drop is a no-op.
// ---------------------------------------------------------------------------

function writeTranscriptJsonl(name: string, events: Record<string, unknown>[]): string {
  const filePath = path.join(transcriptDir, `${name}.jsonl`);
  const lines = [JSON.stringify({ type: '_pad' }), ...events.map((e) => JSON.stringify(e))];
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

// ---------------------------------------------------------------------------
// Module mocks — must be at the top before any dynamic import of the hook
// ---------------------------------------------------------------------------

// Capture the body sent to /events
let capturedEventsBody: unknown = null;

vi.mock('@myco/hooks/client.js', () => {
  function DaemonClientMock(_vaultDir: string) {
    this.isHealthy = vi.fn().mockResolvedValue(true);
    this.spawnDaemon = vi.fn();
    this.post = vi.fn().mockImplementation((endpoint: string, body: unknown) => {
      if (endpoint === '/events') {
        capturedEventsBody = body;
      }
      return Promise.resolve({ ok: true, data: {} });
    });
    this.delete = vi.fn().mockResolvedValue({ ok: true });
  }
  return {
    isIgnoredEventResponse: vi.fn().mockReturnValue(false),
    DaemonClient: DaemonClientMock,
  };
});

vi.mock('@myco/vault/resolve.js', () => ({
  resolveVaultDir: vi.fn().mockReturnValue(vaultDir),
}));

vi.mock('@myco/symbionts/detect.js', () => ({
  loadManifests: vi.fn().mockReturnValue([]),
}));

vi.mock('@myco/capture/buffer.js', () => ({
  EventBuffer: vi.fn().mockImplementation(() => ({
    append: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// The readStdin mock must be defined before the test that sets the transcript path
// because we'll set it per-test via a variable.
// ---------------------------------------------------------------------------

let stdinJson = '{}';
vi.mock('@myco/hooks/read-stdin.js', () => ({
  readStdin: vi.fn().mockImplementation(() => Promise.resolve(stdinJson)),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('user-prompt-submit: kind is tagged via classifyPromptKind', () => {
  beforeEach(() => {
    capturedEventsBody = null;
  });

  it('sends kind=steering when the prior assistant turn has stop_reason=tool_use', async () => {
    // Write a transcript showing an in-flight tool_use turn
    const transcriptPath = writeTranscriptJsonl('steering-turn', [
      {
        type: 'user',
        promptId: 'p1',
        message: { role: 'user', content: [{ type: 'text', text: 'Fix the bug' }] },
      },
      {
        type: 'assistant',
        message: {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        },
      },
    ]);

    stdinJson = JSON.stringify({
      session_id: 'test-session-123',
      transcript_path: transcriptPath,
      prompt: 'keep going',
      agent: 'claude-code',
    });

    // Dynamic import so the module mock is in place
    const { main } = await import('@myco/hooks/user-prompt-submit.js');
    await main();

    expect(capturedEventsBody).not.toBeNull();
    expect((capturedEventsBody as Record<string, unknown>).kind).toBe('steering');
  });

  it('sends kind=initial when the prior assistant turn has stop_reason=end_turn', async () => {
    const transcriptPath = writeTranscriptJsonl('initial-turn', [
      {
        type: 'user',
        promptId: 'p1',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      },
      {
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done.' }],
        },
      },
    ]);

    stdinJson = JSON.stringify({
      session_id: 'test-session-456',
      transcript_path: transcriptPath,
      prompt: 'do something new',
      agent: 'claude-code',
    });

    const { main } = await import('@myco/hooks/user-prompt-submit.js');
    await main();

    expect(capturedEventsBody).not.toBeNull();
    expect((capturedEventsBody as Record<string, unknown>).kind).toBe('initial');
  });
});
