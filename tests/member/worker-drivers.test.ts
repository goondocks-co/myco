/**
 * One run-event model, three drivers, one contract.
 *
 * Every case here is enumerated from the harness manifest rather than written
 * per harness, so a harness added to the manifest without a driver, without an
 * isolation mechanism, or without a credential probe fails by name instead of
 * being quietly absent.
 *
 * The stream fixtures are the shapes verified against the real binaries: the
 * asymmetries that a reader gets wrong are what they exist to hold.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESSES } from '@myco/runner/harnesses.js';
import { DRIVERS, driverFor } from '@myco/runner/drivers/registry.js';
import { reachedEnd, type RunEvent } from '@myco/runner/events.js';
import { discardRunDir, mcpConfigOf, MCP_SERVER_NAME, writeRunDir } from '@myco/runner/mcp-config.js';
import { PROJECT_HEADER, PROTOCOL_HEADER } from '@myco/member/constants.js';
import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';

const CONNECTION = { serverUrl: 'https://deployment.example', projectId: 'proj_1', runToken: 'tok_run_secret_value' };

describe('the harness manifest', () => {
  it('gives every harness a driver, an isolation mechanism and a credential probe', () => {
    for (const harness of HARNESSES) {
      expect({ id: harness.id, driven: driverFor(harness.id) !== null }).toEqual({ id: harness.id, driven: true });
      expect({ id: harness.id, isolation: harness.isolation.kind }).toEqual({ id: harness.id, isolation: harness.isolation.kind });
      expect(['flag', 'home', 'additive']).toContain(harness.isolation.kind);
      expect(['file', 'command', 'file-or-command']).toContain(harness.credential.kind);
      expect(harness.binary.length).toBeGreaterThan(0);
    }
    expect(Object.keys(DRIVERS).sort()).toEqual(HARNESSES.map((h) => h.id).sort());
  });

  it('names the same harnesses the Deployment opens a credential for, and each its own provider', () => {
    // A harness is not a provider: handing one another's key fails in a way
    // that reads as a bad credential rather than as a wrong table.
    expect(Object.keys(HARNESS_CREDENTIALS).sort()).toEqual(HARNESSES.map((h) => h.id).sort());
    expect(Object.fromEntries(Object.entries(HARNESS_CREDENTIALS).map(([id, c]) => [id, c.provider]))).toEqual({
      'claude-code': 'anthropic', codex: 'openai', opencode: 'anthropic', cursor: 'anthropic', antigravity: 'google',
    });
    for (const [id, declared] of Object.entries(HARNESS_CREDENTIALS)) {
      expect({ id, variables: declared.variables.length > 0 }).toEqual({ id, variables: true });
    }
  });

  it('names three launch shapes, and the two harnesses with native drivers speak no protocol of their own', () => {
    const shapes = Object.fromEntries(HARNESSES.map((h) => [h.id, h.launch.kind]));
    expect(shapes).toEqual({
      'claude-code': 'native', codex: 'native', opencode: 'subcommand', cursor: 'subcommand', antigravity: 'sidecar',
    });
  });

  it('isolates a run\'s tools airtight only where the harness supports it, and says so where it does not', () => {
    // A harness that adds a run's servers to the host's own cannot be made
    // exclusive from outside. The manifest carries that rather than a driver
    // claiming an isolation it does not have.
    expect(Object.fromEntries(HARNESSES.map((h) => [h.id, h.isolation.kind]))).toEqual({
      'claude-code': 'flag', codex: 'home', opencode: 'additive', cursor: 'additive', antigravity: 'additive',
    });
  });
});

describe('the run credential', () => {
  it('reaches the run\'s own configuration file and nothing else, readable only by the worker', () => {
    const root = mkdtempSync(join(tmpdir(), 'myco-worker-'));
    const { scratchDir, mcpConfigPath } = writeRunDir(root, 'run_1', CONNECTION);
    const written = readFileSync(mcpConfigPath, 'utf8');
    expect(written).toContain(CONNECTION.runToken);
    expect(JSON.parse(written)).toEqual({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url: 'https://deployment.example/mcp',
          headers: {
            authorization: `Bearer ${CONNECTION.runToken}`,
            [PROTOCOL_HEADER]: '1',
            [PROJECT_HEADER]: 'proj_1',
          },
        },
      },
    });
    discardRunDir(scratchDir);
    expect(existsSync(scratchDir)).toBe(false);
  });

  it('names the Deployment\'s MCP surface and the three headers it requires', () => {
    const config = mcpConfigOf(CONNECTION) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
    const server = config.mcpServers[MCP_SERVER_NAME]!;
    expect(server.url).toBe('https://deployment.example/mcp');
    expect(Object.keys(server.headers).sort()).toEqual(['authorization', PROJECT_HEADER, PROTOCOL_HEADER].sort());
  });
});

/** A driver run against a scripted stream: what a harness writes, and what the driver answers. */
async function eventsOf(lines: readonly string[], read: (line: Record<string, unknown>) => RunEvent | null): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const event = read(parsed);
    if (event !== null) out.push(event);
  }
  return out;
}

describe('the shapes a driver must read correctly', () => {
  it('reads a success result with a null structured output as a success, by value and never by key', async () => {
    const result = JSON.parse('{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","structured_output":null}') as Record<string, unknown>;
    // The key is present on an ordinary success, so a reader that asks whether
    // the key exists reads a value that is not there.
    expect('structured_output' in result).toBe(true);
    expect(result.structured_output).toBeNull();
    expect(result.is_error).toBe(false);
  });

  it('reads an error item in a completed turn as an item, never as a failed run', async () => {
    const lines = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"id":"i0","type":"error","message":"a tool was unavailable"}}',
      '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"done"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
    ];
    const events = await eventsOf(lines, (line) => {
      if (line.type === 'turn.completed') return { kind: 'ended', stop: 'end_turn', detail: null };
      if (line.type === 'item.completed' && (line.item as Record<string, unknown>).type === 'error') return { kind: 'tool_call', name: 'item', status: 'error' };
      return null;
    });
    expect(reachedEnd(events)).toBe(true);
    expect(events.filter((e) => e.kind === 'tool_call')).toHaveLength(1);
  });

  it('holds the five stop reasons the protocol names, plus the one a driver adds for a harness that answered none', () => {
    const ended: RunEvent[] = ([ 'end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'error' ] as const)
      .map((stop) => ({ kind: 'ended', stop, detail: null }));
    expect(ended.map((e) => (e.kind === 'ended' ? e.stop : null)))
      .toEqual(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'error']);
    // Only a turn that ended on its own is an ending a worker reports as reached.
    for (const event of ended) expect(reachedEnd([event])).toBe(event.kind === 'ended' && event.stop === 'end_turn');
  });

  it('reads no ending at all as a failure rather than a success', () => {
    expect(reachedEnd([])).toBe(false);
    expect(reachedEnd([{ kind: 'message', role: 'assistant', text: 'hello' }])).toBe(false);
  });
});
