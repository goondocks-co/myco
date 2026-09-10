/**
 * One run-event model, three drivers, one contract.
 *
 * Every case here is enumerated from the harness manifest rather than written
 * per harness, so a harness added to the manifest without a driver, without an
 * isolation mechanism, or without a credential probe fails by name instead of
 * being quietly absent.
 *
 * What each driver does with its harness's own bytes is executed in
 * `worker-driver-streams`; what is held here is the manifest every driver,
 * the detector and `myco doctor` read, and the shape of the model they answer in.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESSES } from '@myco/runner/harnesses.js';
import { DRIVERS, driverFor } from '@myco/runner/drivers/registry.js';
import { reachedEnd, type RunEvent } from '@myco/runner/events.js';
import { discardRunDir, mcpConfigOf, MCP_SERVER_NAME, RUN_INSTRUCTIONS_FILES, writeRunDir } from '@myco/runner/mcp-config.js';
import { PROJECT_HEADER, PROTOCOL_HEADER } from '@myco/member/constants.js';
import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';

const CONNECTION = { serverUrl: 'https://deployment.example', projectId: 'proj_1', runToken: 'tok_run_secret_value' };

describe('the harness manifest', () => {
  it('gives every harness a driver, an isolation mechanism and a credential probe', () => {
    for (const harness of HARNESSES) {
      expect({ id: harness.id, driven: driverFor(harness.id) !== null }).toEqual({ id: harness.id, driven: true });
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
  it('keeps reclaimed attempts in distinct directories and preserves the current attempt during cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'myco-worker-'));
    try {
      const previous = writeRunDir(root, 'same_run', CONNECTION);
      const current = writeRunDir(root, 'same_run', { ...CONNECTION, runToken: 'current_run_token' });
      expect(previous.scratchDir).not.toBe(current.scratchDir);
      discardRunDir(previous.scratchDir);
      expect(readFileSync(current.mcpConfigPath, 'utf8')).toContain('current_run_token');
    } finally { discardRunDir(root); }
  });

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
    // A claim that hands no standing rules leaves no instructions file behind.
    for (const name of RUN_INSTRUCTIONS_FILES) expect(existsSync(join(scratchDir, name))).toBe(false);
    discardRunDir(scratchDir);
    expect(existsSync(scratchDir)).toBe(false);
  });

  it('writes the standing rules the claim handed as the run\'s instructions file, under every name a harness reads one by', () => {
    const root = mkdtempSync(join(tmpdir(), 'myco-worker-'));
    const { scratchDir } = writeRunDir(root, 'run_2', CONNECTION, '# Myco extraction run\n\nSearch before every write.');
    expect(RUN_INSTRUCTIONS_FILES).toEqual(['AGENTS.md', 'CLAUDE.md']);
    for (const name of RUN_INSTRUCTIONS_FILES) expect(readFileSync(join(scratchDir, name), 'utf8')).toBe('# Myco extraction run\n\nSearch before every write.');
    // Blank rules are no rules: nothing is written for a harness to read as guidance.
    const { scratchDir: bare } = writeRunDir(root, 'run_3', CONNECTION, '   ');
    for (const name of RUN_INSTRUCTIONS_FILES) expect(existsSync(join(bare, name))).toBe(false);
    discardRunDir(scratchDir);
    discardRunDir(bare);
  });

  it('names the Deployment\'s MCP surface and the three headers it requires', () => {
    const config = mcpConfigOf(CONNECTION) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
    const server = config.mcpServers[MCP_SERVER_NAME]!;
    expect(server.url).toBe('https://deployment.example/mcp');
    expect(Object.keys(server.headers).sort()).toEqual(['authorization', PROJECT_HEADER, PROTOCOL_HEADER].sort());
  });
});

describe('the stop reasons every driver answers in', () => {
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
