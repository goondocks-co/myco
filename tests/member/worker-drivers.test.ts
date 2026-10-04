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
import { mkdtempSync, readFileSync, existsSync } from "../support/fenced-fs.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESSES, offerable } from '@myco/runner/harnesses.js';
import { DRIVERS, driverFor, RUN_HOMES } from '@myco/runner/drivers/registry.js';
import { offerOf } from '@myco/runner/detect.js';
import { callOutcome, failedCallsNote, reachedEnd, type RunEvent } from '@myco/runner/events.js';
import { discardRunDir, mcpConfigOf, MCP_SERVER_NAME, RUN_INSTRUCTIONS_FILES, writeRunDir } from '@myco/runner/mcp-config.js';
import { PROJECT_HEADER, PROTOCOL_HEADER } from '@myco/member/constants.js';
import { HARNESS_CREDENTIALS, credentialEnvFor } from '@goondocks/myco-shared/harness-providers';
import { profileSupported, type ProfileCapability } from '@goondocks/myco-shared/execution-profile';

const CONNECTION = { serverUrl: 'https://deployment.example', projectId: 'proj_1', runToken: 'tok_run_secret_value' };

describe('the harness manifest', () => {
  it('gives every harness a run can be held on a driver, and every harness an isolation mechanism and a credential probe', () => {
    for (const harness of HARNESSES) {
      // A harness no worker offers has no driver, so no run is started on it.
      expect({ id: harness.id, driven: driverFor(harness.id) !== null }).toEqual({ id: harness.id, driven: offerable(harness) });
      expect(['flag', 'home', 'additive']).toContain(harness.isolation.kind);
      expect(['file', 'command', 'file-or-command']).toContain(harness.credential.kind);
      expect(harness.binary.length).toBeGreaterThan(0);
    }
    expect(Object.keys(DRIVERS).sort()).toEqual(HARNESSES.filter(offerable).map((h) => h.id).sort());
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
    // Each harness reads a slot of its own use: Codex never reads the embedding provider's `openai` slot (#1212).
    expect(Object.fromEntries(Object.entries(HARNESS_CREDENTIALS).map(([id, c]) => [id, c.slot]))).toEqual({
      'claude-code': 'anthropic', codex: 'codex', opencode: 'anthropic', cursor: 'anthropic', antigravity: null,
    });
  });

  it('offers explicit profile capabilities and keeps subscription credentials on Claude Code', () => {
    expect(Object.fromEntries(HARNESSES.map((h) => [h.id, h.profile.model]))).toEqual({
      'claude-code': 'flag', codex: 'config', opencode: 'config', cursor: 'none', antigravity: 'none',
    });
    const offered = offerOf(HARNESSES.map((h) => ({ id: h.id, installed: true, authenticated: true })));
    expect(offered.offered.map((h) => h.profile)).toEqual(HARNESSES.filter(offerable).map((h) => h.profile));
    const oauth = 'sk-ant-oat-test-token';
    expect(credentialEnvFor('claude-code', oauth)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: oauth });
    expect(credentialEnvFor('opencode', oauth)).toEqual({});
    expect(credentialEnvFor('cursor', oauth)).toEqual({});
    expect(credentialEnvFor('opencode', 'sk-ant-api-test')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api-test' });
  });

  it('refuses an unknown advertised model capability', () => {
    const profile = { tier: 'low', model: 'haiku', effort: 'low', sources: { tier: 'task', model: 'default' } } as const;
    const malformed = { model: 'surprise', efforts: ['low'] } as unknown as ProfileCapability;
    expect(profileSupported(profile, malformed)).toBe(false);
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

  it('says how each harness is made to ask before a call, or what bounds a run on one that never asks', () => {
    // OpenCode allows every tool under its default configuration, so its runs
    // start in an agent of their own that asks for everything, with no plugin
    // loaded that could answer for the driver. Cursor asks for what its own
    // configuration has not approved, so its runs read a configuration of their
    // own. Codex never asks, and its sandbox is the run's bound. Antigravity's
    // approvals cannot be kept from a run.
    expect(Object.fromEntries(HARNESSES.map((h) => [h.id, h.asking]))).toEqual({
      'claude-code': { kind: 'native' },
      codex: { kind: 'sandbox' },
      opencode: { kind: 'run-agent', env: 'OPENCODE_CONFIG_CONTENT', extensionsOff: { OPENCODE_PURE: '1' }, sourceReads: { read: 'ask', glob: 'ask', grep: 'ask', list: 'ask', external_directory: 'ask' } },
      cursor: { kind: 'run-home', env: 'CURSOR_CONFIG_DIR', sourceReads: 'unheld' },
      antigravity: { kind: 'unheld' },
    });
  });

  it('gives every harness that reads a configuration of the run\'s own a writer for it', () => {
    // A run-home harness with no writer would read the machine's configuration,
    // whose approvals are exactly what the home keeps from the run.
    const homed = HARNESSES.filter((h) => h.asking.kind === 'run-home').map((h) => h.id).sort();
    expect(Object.keys(RUN_HOMES).sort()).toEqual(homed);
  });

  it('offers no harness a run cannot be held on, whatever detection finds logged in', () => {
    const detected = HARNESSES.map((h) => ({ id: h.id, installed: true, authenticated: true }));
    const offer = offerOf(detected);
    expect({ offered: offer.offered.map((h) => h.id), withheld: offer.withheld }).toEqual({
      offered: ['claude-code', 'codex', 'opencode', 'cursor'],
      withheld: ['antigravity'],
    });
    expect(HARNESSES.filter((h) => !offerable(h)).map((h) => h.id)).toEqual(['antigravity']);
    // A harness that is not logged in is not offered, and is not reported as withheld either.
    expect(offerOf([{ id: 'antigravity', installed: true, authenticated: false }]).withheld).toEqual([]);
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
          alwaysLoad: true,
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

describe('what a run\'s record says of the calls that failed in it', () => {
  const failed = (name: string, outcome: { refused?: true; timedOut?: true; exitCode?: number } = {}): RunEvent => ({ kind: 'tool_call', name, status: 'error', ...outcome });
  const ended: RunEvent = { kind: 'ended', stop: 'end_turn', detail: null };

  it('says nothing where no call failed', () => {
    expect(failedCallsNote([{ kind: 'tool_call', name: 'Read', status: 'ok' }, ended])).toBeNull();
  });

  it('names a refused call by its tool alone, codes its outcome, and says the turn ended right after it', () => {
    expect(failedCallsNote([{ kind: 'message', role: 'assistant', text: 'listing' }, failed('ls -la', { refused: true }), ended]))
      .toBe('a call failed or was refused: tool (refused); the turn ended right after the last of them');
  });

  it('counts a call that failed more than once, and does not say the turn ended on it where the agent went on', () => {
    expect(failedCallsNote([
      failed('myco_run_sessions'), failed('myco_run_sessions'),
      { kind: 'tool_call', name: 'myco_run', status: 'ok' }, ended,
    ])).toBe('2 calls failed or were refused: myco_run_sessions (failed) ×2');
    // A thought is not the agent going on; a message to the user is.
    expect(failedCallsNote([failed('x'), { kind: 'message', role: 'thought', text: 'hm' }, ended])).toContain('the turn ended right after');
    expect(failedCallsNote([failed('x'), { kind: 'message', role: 'assistant', text: 'I could not.' }, ended])).toBe('a call failed or was refused: x (failed)');
  });

  it('codes a failed call\'s outcome as refused, timed out, its exit code, or failed', () => {
    expect([failed('a', { refused: true, exitCode: 1 }), failed('b', { timedOut: true, exitCode: 124 }), failed('c', { exitCode: 2 }), failed('d')]
      .map((event) => (event.kind === 'tool_call' ? callOutcome(event) : null))).toEqual(['refused', 'timed out', 'exit code 2', 'failed']);
  });

  it('names five kinds of failed call and counts the rest', () => {
    const events = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => failed(name));
    expect(failedCallsNote(events)).toBe('7 calls failed or were refused: a (failed); b (failed); c (failed); d (failed); e (failed), and 2 more; the turn ended right after the last of them');
  });
});
