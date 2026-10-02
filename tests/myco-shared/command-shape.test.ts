/**
 * The allowed shape of a command, through every path a command-shaped string is stored by: a worker's step target of
 * every kind, the Deployment's re-check of a step page, an agent-protocol call (its raw input, its free-text title and
 * the name a failed call is noted by), and an agent's audit of the commands it ran and the files it examined.
 *
 * The corpus is every input an adversarial probe found a secret surviving in, and each shape a deny-list missed. The
 * gate is a property: for every corpus input, no path's stored output holds any of the input's secret values.
 */
import { describe, expect, it } from 'bun:test';
import { commandShape, identifierShape, SUBCOMMAND_PROGRAMS } from '@goondocks/myco-shared/command-shape';
import { parseStepPage, STEP_KINDS, stepName, stepPages, stepTarget, type StepKind, type WorkerStep } from '@goondocks/myco-shared/worker-steps';
import { HARNESSES, harnessById } from '@myco/runner/harnesses.js';
import { StepLog } from '@myco/runner/steps.js';
import { AcpEvents } from '@myco/runner/drivers/acp-events.js';
import { failedCallsNote, type RunEvent } from '@myco/runner/events.js';
import { parseRunAudit } from '@myco-server-worker/core/run-audit.js';

/** Token-shaped values, assembled so the source holds no literal a secret scanner reads as a live credential. */
const STRIPE_LIVE = ['rk', 'live', '51HxQwErTyUiOpAsDfGhJkL'].join('_');
const OPENAI_KEY = ['sk', 'proj', 'Zx81Qw2Er3Ty4Ui5Op6As7Df8Gh9Jk0'].join('-');
const GITHUB_PAT = ['ghp', 'R4nd0mT0k3nV4lu3Abcdefghij0123456789'].join('_');
const SLACK_BOT = ['xoxb', '1234567890', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
const GITLAB_PAT = ['glpat', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn'].join('-');
const AWS_KEY_ID = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const AWS_SECRET = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/');
const BARE_JWT = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
const BASE64_SECRET = 'c3VwZXItc2VjcmV0LXZhbHVlLTQyCg==';
const UUID_KEY = '550e8400-e29b-41d4-a716-446655440000';

interface Leak { name: string; command: string; secrets: readonly string[] }

/** Each input, and the values of it no path may ever store. */
const CORPUS: readonly Leak[] = [
  // Plain and short positional words.
  { name: 'a plain word echoed', command: 'echo S3cret', secrets: ['S3cret'] },
  { name: 'a lowercase word echoed', command: 'echo letmein77', secrets: ['letmein77'] },
  { name: 'a quoted literal echoed', command: "echo 'literal-secret-value-123456'", secrets: ['literal-secret-value', '123456'] },
  { name: 'a double-quoted secret', command: 'echo "hunter2pass"', secrets: ['hunter2pass'] },
  { name: 'an htpasswd password', command: 'htpasswd -b f user S3cret', secrets: ['S3cret'] },
  { name: 'a Redis AUTH', command: 'redis-cli AUTH S3cret', secrets: ['S3cret', 'AUTH'] },
  { name: 'an ssh trailing word', command: 'ssh user@host S3cret', secrets: ['S3cret', 'user@'] },
  { name: 'a word after the end of flags', command: 'tool -- S3cret', secrets: ['S3cret'] },
  { name: 'a password piped to sudo', command: 'echo S3cret | sudo -S cmd', secrets: ['S3cret'] },
  { name: 'a short secret of six', command: 'login --user me qwerty', secrets: ['qwerty'] },
  { name: 'a short secret of twelve', command: 'unlock vault Tr0ub4dor&3x', secrets: ['Tr0ub4dor'] },
  { name: 'a lowercase word after a subcommand program flag', command: 'docker -p lowercasesecret', secrets: ['lowercasesecret'] },
  { name: 'a lowercase second word of a subcommand program', command: 'make deploy hunter22', secrets: ['hunter22'] },
  // Single-dash long flags.
  { name: 'a single-dash password flag', command: 'tool -password S3cret', secrets: ['S3cret', 'assword'] },
  { name: 'an openssl passin', command: 'openssl rsa -passin S3cret -in key.pem', secrets: ['S3cret'] },
  { name: 'an openssl pass', command: 'openssl enc -pass S3cret -in a.txt', secrets: ['S3cret'] },
  { name: 'an openssl pass with its source', command: 'openssl enc -aes-256-cbc -pass pass:S3cret -in a.txt', secrets: ['S3cret', 'pass:'] },
  { name: 'a single-dash token flag', command: 'tool -token abc', secrets: ['abc', 'oken'] },
  // Redirections and here-strings.
  { name: 'a here-string', command: 'cat <<< S3cretpass', secrets: ['S3cretpass'] },
  { name: 'a glued here-string', command: 'cat <<<S3cretpass', secrets: ['S3cretpass'] },
  { name: 'a here-string piped on', command: 'base64 -d <<< c2VjcmV0 | sh', secrets: ['c2VjcmV0'] },
  { name: 'a path-like word after a redirection', command: 'cat > secrets/prod.env', secrets: ['secrets/prod.env'] },
  // Line breaks a here-document or a second command hides behind.
  { name: 'a here-document after \\n', command: `cat > .env <<'EOF'\nSTRIPE_KEY=${STRIPE_LIVE}\nDATABASE_URL=postgres://admin:S3cret@db\nEOF`, secrets: ['rk_live', 'S3cret', 'admin', 'DATABASE_URL'] },
  { name: 'a here-document after \\r', command: 'cat <<EOF\rS3cret\rEOF', secrets: ['S3cret'] },
  { name: 'a here-document after U+2028', command: 'cat <<EOF\u2028token=S3cret\u2028EOF', secrets: ['S3cret', 'token'] },
  { name: 'a second command after U+2029', command: 'true\u2029echo hunter22', secrets: ['hunter22'] },
  { name: 'a second command after U+0085', command: 'true\u0085echo hunter22', secrets: ['hunter22'] },
  { name: 'a second command after VT', command: 'true\u000becho hunter22', secrets: ['hunter22'] },
  { name: 'a second command after FF', command: 'true\u000cecho hunter22', secrets: ['hunter22'] },
  ...['\\u2028', '\\u2029', '\\u0085', '\\u000b', '\\u000c'].map((code): Leak => ({
    name: `a key file named on the line after ${code}`,
    command: `true${String.fromCharCode(Number.parseInt(code.slice(2), 16))}cat vault/prod-signing.pem`,
    secrets: ['prod-signing'],
  })),
  // URLs.
  { name: 'an @ inside a URL password', command: 'curl https://user:pa@ss@host.example.test/x', secrets: ['pa@ss', 'ss@', 'user'] },
  { name: 'a / inside a URL password', command: 'curl https://user:pa/ss@host.example.test/x', secrets: ['pa/ss', 'user:'] },
  { name: 'a postgres URL with credentials', command: 'psql postgres://admin:S3cret@db.internal:5432/app', secrets: ['S3cret', 'admin'] },
  { name: 'a quoted postgresql URL', command: 'psql "postgresql://admin:S3cret@db.internal/app"', secrets: ['S3cret', 'admin'] },
  { name: 'a mongodb+srv URL with credentials', command: 'mongosh "mongodb+srv://root:Pa55word@cluster0.example.test/db"', secrets: ['Pa55word', 'root'] },
  { name: 'keys in a query string', command: 'curl "https://api.example.test/v1?key=AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv&token=t0kenValue"', secrets: ['AIza', 't0kenValue', 'key='] },
  { name: 'a token in a clone URL', command: `git clone https://user:${GITHUB_PAT}@github.com/org/repo.git`, secrets: ['ghp_', 'R4nd0m', 'user:'] },
  { name: 'a GitLab token in a remote', command: `git push https://oauth2:${GITLAB_PAT}@gitlab.example.test/x.git`, secrets: ['glpat', 'oauth2'] },
  { name: 'credentials in an ssh URL', command: 'git clone ssh://git:tok3nValue@git.example.test/repo.git', secrets: ['tok3nValue', 'git:'] },
  // Key-like words judged whole.
  { name: 'a UUID file', command: `cat ${UUID_KEY}.json`, secrets: [UUID_KEY, '446655440000'] },
  { name: 'a UUID path segment', command: `cat keys/${UUID_KEY}/a.txt`, secrets: [UUID_KEY, '446655440000'] },
  { name: 'a UUID with few digits', command: 'cat runs/ffffffff-ffff-4fff-bfff-ffffffffffff.json', secrets: ['ffffffff-ffff'] },
  { name: 'a slash-segmented key', command: `cat ${AWS_SECRET}`, secrets: ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfi'] },
  { name: 'a dot-segmented key', command: 'cat Xk9q.Pq2w.Zr7e.json', secrets: ['Xk9q', 'Pq2w', 'Zr7e'] },
  { name: 'a plus-segmented key', command: 'cat a1b2+c3d4+e5f6.txt', secrets: ['a1b2', 'c3d4', 'e5f6'] },
  { name: 'a base64 secret', command: `echo ${BASE64_SECRET} | base64 -d`, secrets: [BASE64_SECRET.slice(0, 12)] },
  { name: 'a base64 secret as a path', command: 'cat c3VwZXI/c2VjcmV0/dmFsdWU.txt', secrets: ['c3VwZXI', 'c2VjcmV0'] },
  { name: 'a short token naming a file', command: 'cat tokens/x7Kp2mQ9.txt', secrets: ['x7Kp2mQ9'] },
  // Access keys.
  { name: 'AWS keys in leading assignments', command: `AWS_ACCESS_KEY_ID=${AWS_KEY_ID} AWS_SECRET_ACCESS_KEY=${AWS_SECRET} aws s3 ls`, secrets: [AWS_KEY_ID, 'wJalrXUtnFEMI', 'AWS_SECRET_ACCESS_KEY'] },
  { name: 'an AWS access key id as an argument', command: `aws configure set aws_access_key_id ${AWS_KEY_ID}`, secrets: [AWS_KEY_ID] },
  { name: 'a Stripe live key exported', command: `export STRIPE=${STRIPE_LIVE}`, secrets: ['rk_live', '51HxQw'] },
  { name: 'an OpenAI key in env', command: `env OPENAI_API_KEY=${OPENAI_KEY} node app.js`, secrets: ['sk-', 'Zx81Qw'] },
  { name: 'a token assigned before a command', command: 'TOKEN=x9secret npm publish', secrets: ['x9secret', 'TOKEN'] },
  { name: 'a GitHub token as an argument', command: `gh auth login --with-token ${GITHUB_PAT}`, secrets: ['ghp_', 'R4nd0m'] },
  { name: 'a Slack bot token', command: `slack-cli send --token ${SLACK_BOT} hello`, secrets: ['xoxb', 'AbCdEf'] },
  { name: 'a bare JWT', command: `echo ${BARE_JWT}`, secrets: ['eyJhbGci', 'dozjgNryP4'] },
  { name: 'a JWT in a header', command: `curl -H "Authorization: Bearer ${BARE_JWT}" https://example.test`, secrets: ['eyJhbGci', 'Bearer'] },
  { name: 'a JWT in a glued header', command: `curl -HAuthorization:Bearer:${BARE_JWT} https://example.test`, secrets: ['eyJhbGci', 'Bearer'] },
  { name: 'an API key header', command: 'curl -H "X-Api-Key: k3yValue99" https://example.test', secrets: ['k3yValue99', 'X-Api-Key'] },
  { name: 'an unquoted API key header', command: 'curl -H X-Api-Key:k3yValue99 https://example.test', secrets: ['k3yValue99'] },
  { name: 'curl basic credentials', command: 'curl -u admin:Pa55word https://api.example.test', secrets: ['Pa55word', 'admin'] },
  // Passwords given to clients.
  { name: 'a MySQL password glued to its flag', command: 'mysql -uroot -pPa55word app', secrets: ['Pa55word', 'root'] },
  { name: 'a MySQL password after -p', command: 'mysql -u root -p Pa55word app', secrets: ['Pa55word', 'root'] },
  { name: 'a password after its long flag', command: 'mysql --password Pa55word app', secrets: ['Pa55word'] },
  { name: 'a password in its long flag', command: 'mysql --password=Pa55word app', secrets: ['Pa55word'] },
  { name: 'a Redis password', command: 'redis-cli -a Pa55word ping', secrets: ['Pa55word'] },
  { name: 'a docker login', command: 'docker login -u deployer -p Pa55word registry.example.test', secrets: ['Pa55word', 'deployer'] },
  { name: 'an sshpass password', command: 'sshpass -p Pa55word ssh deploy@host.example.test', secrets: ['Pa55word', 'deploy@'] },
  { name: 'an inline Python key', command: `python -c "import openai; openai.api_key='${OPENAI_KEY}'"`, secrets: ['sk-', 'Zx81Qw', 'openai'] },
  { name: 'a shell script carrying a key', command: `bash -lc "curl -H 'Authorization: Bearer ${BARE_JWT}' https://example.test"`, secrets: ['eyJhbGci', 'Bearer'] },
  { name: 'a shell script echoing a word', command: "sh -c 'echo hunter22'", secrets: ['hunter22'] },
];

/**
 * Free text a harness names as a search pattern, a search or fetch query, or an agent-protocol call's title. A command
 * keeps its program's name, so free text is judged on the paths that read it as a query or a title.
 */
const FREE_TEXT: readonly Leak[] = [
  { name: 'a search query', command: 'letmein77 rotation', secrets: ['letmein77', 'rotation'] },
  { name: 'a search for a key', command: `where is ${AWS_KEY_ID} used`, secrets: [AWS_KEY_ID] },
  { name: 'a grep pattern', command: 'hunter22', secrets: ['hunter22'] },
];

const step = (kind: StepKind, target: string): WorkerStep => ({ seq: 0, callId: 'c0', kind, tool: 'Bash', target, outcome: 'ok', exitCode: 0, startedAt: 1, endedAt: 2 });

/** The Claude Code tool each step kind is read from, and the input field its target is named by. */
const CLAUDE_CALLS: ReadonlyArray<{ name: string; field: string }> = [
  { name: 'Bash', field: 'command' }, { name: 'Read', field: 'file_path' }, { name: 'Edit', field: 'file_path' },
  { name: 'Grep', field: 'pattern' }, { name: 'Glob', field: 'pattern' }, { name: 'WebFetch', field: 'url' },
  { name: 'WebSearch', field: 'query' }, { name: 'mcp__myco__myco_run', field: 'op' },
];

/** The agent-protocol kinds a call may carry, each with the raw input fields its rule reads. */
const ACP_CALLS: ReadonlyArray<{ kind: string; rawInput: (value: string) => Record<string, unknown> }> = [
  { kind: 'execute', rawInput: (value) => ({ command: value }) },
  { kind: 'read', rawInput: (value) => ({ path: value }) },
  { kind: 'search', rawInput: (value) => ({ pattern: value, query: value }) },
  { kind: 'fetch', rawInput: (value) => ({ query: value }) },
  { kind: 'other', rawInput: () => ({}) },
];

/** What each path stores of one input. */
function stored(command: string): Record<string, string> {
  const claude = new StepLog(harnessById('claude-code')!, () => 1);
  CLAUDE_CALLS.forEach(({ name, field }, i) => claude.observe({ kind: 'tool_call', name, status: 'started', callId: `c${i}`, input: { [field]: command } }));
  claude.observe({ kind: 'tool_call', name: command, status: 'started', callId: 'named' });
  const acpEvents: RunEvent[] = [];
  for (const harness of ['opencode', 'cursor', 'antigravity']) {
    const acp = new AcpEvents(harness, null, {});
    ACP_CALLS.forEach(({ kind, rawInput }, i) => {
      acpEvents.push(...acp.update({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: `t${i}`, title: command, kind, status: 'pending', rawInput: rawInput(command) } } }, 's'));
      acpEvents.push(...acp.update({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: `u${i}`, title: command, kind, status: 'pending' } } }, 's'));
      acpEvents.push(...acp.refused({ toolCallId: `r${i}`, title: command, kind, rawInput: rawInput(command) }, 'outside the run\'s grant'));
    });
    acpEvents.push(...acp.refused({ toolCallId: 'k', title: command, kind: command }, 'outside the run\'s grant'));
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
    serverTarget: JSON.stringify(STEP_KINDS.map((kind) => parseStepPage({ ...stepPages('mt_1', [step(kind, command.slice(0, 300) || 'x')], 0, { total: 0, shapes: {} })[0]! }).steps)),
    agentProtocolCall: JSON.stringify(acpLogs),
    agentProtocolNote: failedCallsNote(acpEvents) ?? '',
    audit: JSON.stringify(audit.audit),
  };
}

/** What each path that reads free text as a query or a title stores of it. */
function storedAsQuery(text: string): Record<string, string> {
  const claude = new StepLog(harnessById('claude-code')!, () => 1);
  CLAUDE_CALLS.filter(({ name }) => ['Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(name))
    .forEach(({ name, field }, i) => claude.observe({ kind: 'tool_call', name, status: 'started', callId: `c${i}`, input: { [field]: text } }));
  const queryKinds: readonly StepKind[] = ['search', 'fetch'];
  const { agentProtocolCall, agentProtocolNote } = stored(text);
  return {
    workerTarget: JSON.stringify(claude.result().steps),
    workerTargetByKind: JSON.stringify(queryKinds.map((kind) => stepTarget(text, kind))),
    serverTarget: JSON.stringify(queryKinds.map((kind) => parseStepPage({ ...stepPages('mt_1', [step(kind, text)], 0, { total: 0, shapes: {} })[0]! }).steps)),
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
      ['bun test tests/a.test.ts', 'bun test tests/a.test.ts'],
      ['npm test -- tests/member/worker-steps.test.ts', 'npm test -- tests/member/worker-steps.test.ts'],
      ['git log -1 --oneline', 'git log -1 --oneline'],
      ['git -C /repo status', 'git -C /repo status'],
      ['cd repo && npm run build | tail -5', 'cd … && npm run … | tail -5'],
      ['TOKEN=x9secret npm publish --access public', 'npm publish --access …'],
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

  it('reads a subcommand only for the programs one table lists', () => {
    expect([...SUBCOMMAND_PROGRAMS].sort()).toEqual(['brew', 'bun', 'cargo', 'docker', 'gh', 'git', 'go', 'kubectl', 'make', 'myco', 'npm', 'npx', 'pip', 'pnpm', 'uv', 'wrangler', 'yarn']);
    expect(commandShape('terraform apply')).toBe('terraform …');
    expect(commandShape('/usr/local/bin/git status')).toBe('/usr/local/bin/git status');
  });

  it('keeps a step\'s target by its kind: a search only as a path, a fetch as its scheme and host, never a query', () => {
    expect(stepTarget('src/**/*.ts', 'search')).toBe('src/**/*.ts');
    expect(stepTarget('leaseDeadline', 'search')).toBeNull();
    expect(stepTarget('https://user:pw@docs.example.test/a?token=x', 'fetch')).toBe('https://docs.example.test');
    expect(stepTarget('how do I rotate keys', 'fetch')).toBeNull();
    expect(stepTarget('report', 'myco')).toBe('report');
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
    expect(() => parseStepPage({ ...stepPages('mt_1', [{ ...step('command', 'ls'), tool: 'Read loop.ts' }], 0, { total: 0, shapes: {} })[0]! })).toThrow('steps[0].tool must be an identifier');
    expect(() => parseStepPage({ ...stepPages('mt_1', [{ ...step('command', 'ls'), tool: AWS_KEY_ID }], 0, { total: 0, shapes: {} })[0]! })).toThrow('steps[0].tool must be an identifier');
    expect(() => parseStepPage({ ...stepPages('mt_1', [{ ...step('command', 'ls'), callId: 'c 1' }], 0, { total: 0, shapes: {} })[0]! })).toThrow('steps[0].callId must be an id');
  });
});
