/**
 * The allowed shape of a command, through every path a command-shaped string is stored by: a worker's step target of
 * every kind, the Deployment's re-check of a step page, an agent-protocol call (its raw input, its free-text title and
 * the name a failed call is noted by), and an agent's audit of the commands it ran and the files it examined.
 *
 * The corpus is every input an adversarial probe found a secret surviving in, and each shape a deny-list missed. The
 * gate is a property: for every corpus input, no path's stored output holds any of the input's secret values.
 */
import { describe, expect, it } from 'bun:test';
import { commandShape, identifierShape, KNOWN_PROGRAMS, SUBCOMMANDS } from '@goondocks/myco-shared/command-shape';
import { parseStepPage, STEP_KINDS, stepName, stepPages, stepTarget, type StepKind, type WorkerStep } from '@goondocks/myco-shared/worker-steps';
import { HARNESSES, harnessById } from '@myco/runner/harnesses.js';
import { StepLog } from '@myco/runner/steps.js';
import { AcpEvents } from '@myco/runner/drivers/acp-events.js';
import { failedCallsNote, type RunEvent } from '@myco/runner/events.js';
import { parseRunAudit } from '@myco-server-worker/core/run-audit.js';
import { MYCO_TOOL_OPS } from '@myco-server-worker/mcp/run-surface.js';
import { AWS_KEY_ID, CORPUS, FREE_TEXT, STRIPE_LIVE, UUID_KEY, type Leak } from '../helpers/secret-corpus.ts';

const step = (kind: StepKind, target: string): WorkerStep => ({ seq: 0, callId: 'c0', kind, tool: 'Bash', target, outcome: 'ok', exitCode: 0, startedAt: 1, endedAt: 2 });

/** The Claude Code tools each step kind is read from; each call carries the input in every field a rule may read. */
const CLAUDE_CALLS: readonly string[] = ['Bash', 'Read', 'Edit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'mcp__myco__myco_run'];
const claudeInput = (value: string): Record<string, unknown> => ({ command: value, file_path: value, pattern: value, path: value, url: value, query: value, op: value });

/** The agent-protocol kinds a call may carry, each with the raw input fields its rule reads. */
const ACP_CALLS: ReadonlyArray<{ kind: string; rawInput: (value: string) => Record<string, unknown> }> = [
  { kind: 'execute', rawInput: (value) => ({ command: value }) },
  { kind: 'read', rawInput: (value) => ({ path: value }) },
  { kind: 'search', rawInput: (value) => ({ pattern: value, query: value, glob: value, path: value }) },
  { kind: 'fetch', rawInput: (value) => ({ query: value }) },
  { kind: 'other', rawInput: () => ({}) },
];

/** What each path stores of one input. */
function stored(command: string): Record<string, string> {
  const claude = new StepLog(harnessById('claude-code')!, () => 1);
  CLAUDE_CALLS.forEach((name, i) => claude.observe({ kind: 'tool_call', name, status: 'started', callId: `c${i}`, input: claudeInput(command) }));
  claude.observe({ kind: 'tool_call', name: command, status: 'started', callId: 'named' });
  const acpEvents: RunEvent[] = [];
  for (const harness of ['opencode', 'cursor', 'antigravity']) {
    const acp = new AcpEvents(harness, null, {});
    ACP_CALLS.forEach(({ kind, rawInput }, i) => {
      acpEvents.push(...acp.update({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: `t${i}`, title: command, kind, status: 'pending', rawInput: rawInput(command) } } }, 's'));
      acpEvents.push(...acp.update({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: `u${i}`, title: command, kind, status: 'pending' } } }, 's'));
      acpEvents.push(...acp.refused({ toolCallId: `r${i}`, title: command, kind, rawInput: rawInput(command) }));
    });
    acpEvents.push(...acp.refused({ toolCallId: 'k', title: command, kind: command }));
  }
  const acpLogs = ['opencode', 'cursor', 'antigravity'].map((harness) => {
    const log = new StepLog(harnessById(harness)!, () => 1);
    for (const event of acpEvents) log.observe(event);
    return log.result().steps;
  });
  const audit = parseRunAudit({ steps: ['ran it'], reasoning: 'it ran', commands: [command], examined: [command] });
  if (!audit.ok) throw new Error(audit.error);
  return {
    commandShape: commandShape(command) ?? '',
    identifierShape: identifierShape(command) ?? '',
    workerTarget: JSON.stringify(claude.result().steps),
    workerTargetByKind: JSON.stringify(STEP_KINDS.map((kind) => stepTarget(command, kind))),
    serverTarget: JSON.stringify(STEP_KINDS.map((kind) => parseStepPage({ ...stepPages('mt_1', [step(kind, command.slice(0, 300) || 'x')], 0, { total: 0, shapes: {} })[0]! }, MYCO_TOOL_OPS).steps)),
    agentProtocolCall: JSON.stringify(acpLogs),
    agentProtocolNote: failedCallsNote(acpEvents) ?? '',
    audit: JSON.stringify(audit.audit),
  };
}

/** What each path that reads free text as a query or a title stores of it. */
function storedAsQuery(text: string): Record<string, string> {
  const claude = new StepLog(harnessById('claude-code')!, () => 1);
  CLAUDE_CALLS.filter((name) => ['Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(name))
    .forEach((name, i) => claude.observe({ kind: 'tool_call', name, status: 'started', callId: `c${i}`, input: claudeInput(text) }));
  const queryKinds: readonly StepKind[] = ['search', 'fetch'];
  const { agentProtocolCall, agentProtocolNote } = stored(text);
  return {
    workerTarget: JSON.stringify(claude.result().steps),
    workerTargetByKind: JSON.stringify(queryKinds.map((kind) => stepTarget(text, kind))),
    serverTarget: JSON.stringify(queryKinds.map((kind) => parseStepPage({ ...stepPages('mt_1', [step(kind, text)], 0, { total: 0, shapes: {} })[0]! }, MYCO_TOOL_OPS).steps)),
    agentProtocolCall: JSON.stringify(JSON.parse(agentProtocolCall).map((steps: WorkerStep[]) => steps.filter((s) => s.kind !== 'command' && s.kind !== 'read'))),
    agentProtocolNote,
  };
}

describe('the allowed shape of a command', () => {
  it(`stores none of the secrets of ${CORPUS.length + FREE_TEXT.length} adversarial inputs on any path`, () => {
    const survived: Array<{ input: string; path: string; secret: string; kept: string }> = [];
    const inputs: Array<[Leak, Record<string, string>]> = [
      ...CORPUS.map((leak): [Leak, Record<string, string>] => [leak, stored(leak.command)]),
      ...FREE_TEXT.map((leak): [Leak, Record<string, string>] => [leak, storedAsQuery(leak.command)]),
    ];
    for (const [leak, paths] of inputs) {
      for (const [path, kept] of Object.entries(paths)) {
        for (const secret of leak.secrets) if (kept.includes(secret)) survived.push({ input: leak.name, path, secret, kept });
      }
    }
    expect(survived).toEqual([]);
  });

  for (const leak of CORPUS) {
    it(`keeps nothing of ${leak.name}`, () => {
      const kept = commandShape(leak.command) ?? '';
      expect({ kept, leaked: leak.secrets.filter((secret) => kept.includes(secret)) }).toEqual({ kept, leaked: [] });
    });
  }

  it('keeps what a reader needs: the program, a listed subcommand, flag names, paths, operators, and a URL as its scheme and host', () => {
    const shapes: Array<[string, string]> = [
      ['git status', 'git status'],
      ['npm test', 'npm test'],
      ['gh pr view 1611', 'gh pr …'],
      ['ls -l /etc', 'ls -l /etc'],
      ['cat packages/x/y.ts', 'cat packages/x/y.ts'],
      ['rg -n leaseDeadline src/', 'rg -n … src/'],
      ['bun test tests/a.test.ts', 'bun test …'],
      ['npm test -- tests/member/worker-steps.test.ts', 'npm test -- …'],
      ['git log -1 --oneline', 'git log -1 --oneline'],
      ['git -C /repo status', 'git -C /repo status'],
      ['cd repo && npm run build | tail -5', 'cd … && npm run … | tail -5'],
      ['TOKEN=x9secret npm publish --access public', 'npm publish --access …'],
      ['true && ls -l /etc', 'true && ls -l /etc'],
      ['curl --data-binary @payload.json https://api.example.test', 'curl --data-binary … https://api.example.test'],
      ['export STRIPE=x', 'export'],
      ['env A=1 B=2 node scripts/smoke.mjs', 'env node scripts/smoke.mjs'],
      ["bash -lc 'npm test'", 'bash -l… npm test'],
      ['bash -lc ls', 'bash -l… ls'],
      ['psql postgres://admin:S3cret@db.internal:5432/app -c "select 1"', 'psql postgres://db.internal -c …'],
      ['mysql --password=Pa55word app', 'mysql --password=… …'],
      ['tail -n 50 logs/2026-10-02.log 2>&1 | grep -i error', 'tail -n … logs/2026-10-02.log 2>&1 | grep -i …'],
      ["cat > notes.md <<'EOF'\nbody\nEOF", 'cat > … << …'],
      ['/repo/src/runner/loop.ts', '/repo/src/runner/loop.ts'],
      ['README.md', 'README.md'],
      ['Makefile', 'Makefile'],
      ['tests/e2e/i18n.test.ts', 'tests/e2e/i18n.test.ts'],
    ];
    expect(shapes.map(([input]) => [input, commandShape(input)])).toEqual(shapes);
  });

  it('reads a subcommand only where the program\'s entry in one table lists it, and a later program only where one table names it', () => {
    expect(Object.keys(SUBCOMMANDS).sort()).toEqual(['brew', 'bun', 'cargo', 'docker', 'gh', 'git', 'go', 'kubectl', 'make', 'myco', 'npm', 'npx', 'pip', 'pnpm', 'uv', 'wrangler', 'yarn']);
    expect(commandShape('terraform apply')).toBe('terraform …');
    expect(commandShape('/usr/local/bin/git status')).toBe('/usr/local/bin/git status');
    expect(commandShape('git hunterpass')).toBe('git …');
    expect(commandShape('npm -- test')).toBe('npm -- …');
    expect(commandShape('true && git status | grep -c modified')).toBe('true && git status | grep -c …');
    expect(commandShape('true && Summer2024')).toBe('true && …');
    expect(commandShape("bash -c 'vllkbsi5'")).toBe('bash -c …');
    expect(commandShape('( cd src && ls )')).toBe('( cd … && ls …');
    expect(commandShape('! grep -q x a.txt')).toBe('! grep -q … a.txt');
    for (const program of Object.keys(SUBCOMMANDS)) expect({ program, known: KNOWN_PROGRAMS.has(program) }).toEqual({ program, known: true });
  });

  it('never keeps the word after a flag whose name says it carries a secret, and reads a bare dotted word as a file only by a listed extension', () => {
    expect(commandShape('login --password Winter.Is.Coming')).toBe('login --password …');
    expect(commandShape('deploy --token ./tok3n-file')).toBe('deploy --token …');
    expect(commandShape('cp --backup ./a.txt b.txt')).toBe('cp --backup … b.txt');
    expect(commandShape('cat notes.md config.yaml Winter.Is.Coming registry.example.test')).toBe('cat notes.md config.yaml …');
  });

  it('reads a URL whose host is key-like as its scheme alone', () => {
    expect(commandShape('curl https://k7x9q2mzp4.trycloudflare.com/x')).toBe('curl https://…');
    expect(commandShape('curl https://api.github.com/repos')).toBe('curl https://api.github.com');
  });

  it('keeps a file examined only where it is a path, and prose as `…`', () => {
    const audit = parseRunAudit({ steps: ['ran it'], reasoning: 'it ran', commands: [], examined: ['packages/x/y.ts', 'the auth module and hunter2 notes', 'README.md'] });
    expect(audit.ok && audit.audit.examined).toEqual(['packages/x/y.ts', '…', 'README.md']);
  });

  it('keeps a step\'s target by its kind: a search only as a path, a fetch as its scheme and host, never a query', () => {
    expect(stepTarget('src/runner', 'search')).toBe('src/runner');
    expect(stepTarget('src/**/*.ts', 'search')).toBeNull();
    expect(stepTarget('leaseDeadline', 'search')).toBeNull();
    for (const harness of HARNESSES) {
      for (const rule of harness.steps.filter((r) => r.kind === 'search')) {
        expect({ harness: harness.id, reads: rule.target.filter((field) => /pattern|query|glob/i.test(field)) }).toEqual({ harness: harness.id, reads: [] });
      }
    }
    expect(stepTarget('https://user:pw@docs.example.test/a?token=x', 'fetch')).toBe('https://docs.example.test');
    expect(stepTarget('how do I rotate keys', 'fetch')).toBeNull();
    expect(stepTarget('report', 'myco')).toBe('report');
    expect([stepTarget('report', 'myco', MYCO_TOOL_OPS), stepTarget('hunter22', 'myco', MYCO_TOOL_OPS)]).toEqual(['report', null]);
    expect(parseStepPage({ ...stepPages('mt_1', [{ ...step('myco', 'hunter22'), tool: 'mcp__myco__myco_run' }], 0, { total: 0, shapes: {} })[0]! }, MYCO_TOOL_OPS).steps[0]!.target).toBeNull();
    expect(stepTarget('anything', 'tool')).toBeNull();
  });

  it('names an agent-protocol call by its kind, never by its title, and never reads its title for a target', () => {
    const acp = new AcpEvents('opencode', null, {});
    const events = [
      ...acp.update({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'npm test', kind: 'execute', status: 'pending' } } }, 's'),
      ...acp.update({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'echo hunter22', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } } } }, 's'),
    ];
    expect(events.map((event) => (event.kind === 'tool_call' ? event.name : null))).toEqual(['execute', 'execute']);
    const log = new StepLog(harnessById('opencode')!, () => 1);
    for (const event of events) log.observe(event);
    expect(log.result().steps.map(({ tool, kind, target }) => ({ tool, kind, target }))).toEqual([
      { tool: 'execute', kind: 'command', target: null },
      { tool: 'execute', kind: 'command', target: 'npm test' },
    ]);
    for (const harness of HARNESSES) for (const rule of harness.steps) expect({ harness: harness.id, rule: rule.target.includes('title') }).toEqual({ harness: harness.id, rule: false });
  });

  it('keeps a step\'s tool only where every harness names it by an identifier that is not key-like, and the Deployment refuses a page whose tool is not one', () => {
    const title = `deploy\nSTRIPE_KEY=${STRIPE_LIVE}`;
    for (const harness of HARNESSES) {
      const log = new StepLog(harness, () => 1);
      log.observe({ kind: 'tool_call', name: title, category: 'execute', status: 'started', callId: 'c0', input: { title, command: title } });
      log.observe({ kind: 'tool_call', name: STRIPE_LIVE, status: 'started', callId: 'c1' });
      log.observe({ kind: 'tool_call', name: AWS_KEY_ID, category: UUID_KEY, status: 'started', callId: 'c2' });
      const tools = log.result().steps.map((s) => s.tool);
      expect({ harness: harness.id, identifiers: tools.every((tool) => identifierShape(tool) === tool), leaked: tools.some((tool) => tool.includes('rk_live') || tool.includes(AWS_KEY_ID) || tool.includes(UUID_KEY)) })
        .toEqual({ harness: harness.id, identifiers: true, leaked: false });
    }
    expect([stepName(AWS_KEY_ID), stepName(UUID_KEY), stepName('mcp__myco__myco_run'), stepName('command_execution')]).toEqual(['tool', 'tool', 'mcp__myco__myco_run', 'command_execution']);
    expect(() => parseStepPage({ ...stepPages('mt_1', [{ ...step('command', 'ls'), tool: 'Read loop.ts' }], 0, { total: 0, shapes: {} })[0]! }, MYCO_TOOL_OPS)).toThrow('steps[0].tool must be an identifier');
    expect(() => parseStepPage({ ...stepPages('mt_1', [{ ...step('command', 'ls'), tool: AWS_KEY_ID }], 0, { total: 0, shapes: {} })[0]! }, MYCO_TOOL_OPS)).toThrow('steps[0].tool must be an identifier');
    expect(() => parseStepPage({ ...stepPages('mt_1', [{ ...step('command', 'ls'), callId: 'c 1' }], 0, { total: 0, shapes: {} })[0]! }, MYCO_TOOL_OPS)).toThrow('steps[0].callId must be an id');
  });
});
