/**
 * The allowed shape of a command, through every path a command-shaped string is stored by: a worker's step target,
 * the Deployment's re-check of a step page, an agent-protocol call's free-text title, and an agent's audit of the
 * commands it ran and the files it examined. Each leak below is a shape a deny-list missed; none may survive any path.
 */
import { describe, expect, it } from 'bun:test';
import { commandShape, identifierShape } from '@goondocks/myco-shared/command-shape';
import { parseStepPage, stepPages, type WorkerStep } from '@goondocks/myco-shared/worker-steps';
import { HARNESSES, harnessById } from '@myco/runner/harnesses.js';
import { StepLog } from '@myco/runner/steps.js';
import { AcpEvents } from '@myco/runner/drivers/acp-events.js';
import { parseRunAudit } from '@myco-server-worker/core/run-audit.js';

/** Token-shaped values, assembled so the source holds no literal a secret scanner reads as a live credential. */
const STRIPE_LIVE = ['rk', 'live', '51HxQwErTyUiOpAsDfGhJkL'].join('_');
const SLACK_BOT = ['xoxb', '1234567890', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
const GITLAB_PAT = ['glpat', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn'].join('-');
const AWS_KEY_ID = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const BARE_JWT = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');

/** Each leak, and what of it must never be stored. */
const LEAKS: ReadonlyArray<{ name: string; command: string; secrets: readonly string[] }> = [
  { name: 'a here-document carrying keys and a database URL', command: `cat > .env <<'EOF'\nSTRIPE_KEY=${STRIPE_LIVE}\nDATABASE_URL=postgres://admin:S3cret@db\nEOF`, secrets: ['rk_live', 'S3cret', 'admin', 'DATABASE_URL'] },
  { name: 'an AWS secret in a leading assignment', command: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 ls', secrets: ['wJalrXUtnFEMI', 'AWS_SECRET_ACCESS_KEY'] },
  { name: 'an AWS access key id as an argument', command: `aws configure set aws_access_key_id ${AWS_KEY_ID}`, secrets: [AWS_KEY_ID] },
  { name: 'a Stripe live key exported', command: `export STRIPE=${STRIPE_LIVE}`, secrets: ['rk_live'] },
  { name: 'a MySQL password glued to its flag', command: 'mysql -uroot -pPa55word app', secrets: ['Pa55word', 'root'] },
  { name: 'a password after its long flag', command: 'mysql --password Pa55word app', secrets: ['Pa55word'] },
  { name: 'curl basic credentials and a key in the query', command: 'curl -u admin:Pa55word https://api.example.test/v1?key=AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv', secrets: ['Pa55word', 'admin', 'AIza'] },
  { name: 'a Redis password', command: 'redis-cli -a Pa55word ping', secrets: ['Pa55word'] },
  { name: 'credentials in a URL that is not http', command: 'git clone ssh://git:tok3nValue@git.example.test/repo.git', secrets: ['tok3nValue', 'git:'] },
  { name: 'a Slack bot token', command: `slack-cli send --token ${SLACK_BOT} hello`, secrets: ['xoxb', 'AbCdEf'] },
  { name: 'a GitLab token in a remote', command: `git push https://oauth2:${GITLAB_PAT}@gitlab.example.test/x.git`, secrets: ['glpat', 'oauth2'] },
  { name: 'a bare JWT', command: `echo ${BARE_JWT}`, secrets: ['eyJhbGci', 'dozjgNryP4'] },
  { name: 'a bearer header', command: 'curl -H "Authorization: Bearer abcdef0123456789abcdef" https://example.test', secrets: ['abcdef0123456789abcdef', 'Bearer'] },
];

const step = (target: string): WorkerStep => ({ seq: 0, callId: 'c0', kind: 'command', tool: 'Bash', target, outcome: 'ok', exitCode: 0, startedAt: 1, endedAt: 2 });

/** What each path stores of one command. */
function stored(command: string): Record<string, string> {
  const claude = new StepLog(harnessById('claude-code')!, () => 1);
  claude.observe({ kind: 'tool_call', name: 'Bash', status: 'started', callId: 'c0', input: { command } });
  const acp = new AcpEvents('opencode', null, {});
  const titled = new StepLog(harnessById('opencode')!, () => 1);
  for (const event of acp.update({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: command, kind: 'execute', status: 'pending' } } }, 's')) titled.observe(event);
  for (const event of acp.update({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'c2', title: command, kind: 'other', status: 'pending' } } }, 's')) titled.observe(event);
  const audit = parseRunAudit({ steps: ['ran it'], reasoning: 'it ran', commands: [command], examined: [command] });
  if (!audit.ok) throw new Error(audit.error);
  return {
    workerTarget: JSON.stringify(claude.result().steps),
    serverTarget: JSON.stringify(parseStepPage({ ...stepPages('mt_1', [step(command)], 0, { total: 0, shapes: {} })[0]! }).steps),
    agentProtocolCall: JSON.stringify(titled.result().steps),
    audit: JSON.stringify(audit.audit),
  };
}

describe('the allowed shape of a command', () => {
  for (const leak of LEAKS) {
    it(`keeps nothing of ${leak.name} on any path`, () => {
      for (const [path, kept] of Object.entries(stored(leak.command))) {
        for (const secret of leak.secrets) expect({ path, secret, kept: kept.includes(secret) }).toEqual({ path, secret, kept: false });
      }
    });
  }

  it('keeps what a reader needs: the program, subcommands, flag names, paths, operators, and a URL as its scheme and host', () => {
    expect(commandShape('npm test -- tests/member/worker-steps.test.ts')).toBe('npm test -- tests/member/worker-steps.test.ts');
    expect(commandShape('git log -1 --oneline')).toBe('git log -1 --oneline');
    expect(commandShape('cd repo && npm run build | tail -5')).toBe('cd repo && npm run build | tail -5');
    expect(commandShape('psql postgres://admin:S3cret@db.internal:5432/app -c "select 1"')).toBe('psql postgres://db.internal -c …');
    expect(commandShape('mysql --password=Pa55word app')).toBe('mysql --password=… app');
    expect(commandShape('/repo/src/runner/loop.ts')).toBe('/repo/src/runner/loop.ts');
    expect(commandShape("\n\ncat > notes.md <<'EOF'\nbody\nEOF")).toBe('cat > notes.md …');
  });

  it('names an agent-protocol call by its kind, never by its title, and reads the title only through the shape', () => {
    const [titled, unmatched] = JSON.parse(stored(LEAKS[0]!.command).agentProtocolCall) as WorkerStep[];
    expect(titled).toMatchObject({ tool: 'execute', kind: 'command', target: 'cat > .env …' });
    expect(unmatched).toMatchObject({ tool: 'other', kind: 'tool', target: null });
  });

  it('keeps a step\'s tool only where every harness names it by an identifier, and the Deployment refuses a page whose tool is not one', () => {
    const title = `deploy\nSTRIPE_KEY=${STRIPE_LIVE}`;
    for (const harness of HARNESSES) {
      const log = new StepLog(harness, () => 1);
      log.observe({ kind: 'tool_call', name: title, category: 'execute', status: 'started', callId: 'c0', input: { title, command: title } });
      log.observe({ kind: 'tool_call', name: STRIPE_LIVE, status: 'started', callId: 'c1' });
      const tools = log.result().steps.map((s) => s.tool);
      expect({ harness: harness.id, identifiers: tools.every((tool) => identifierShape(tool) === tool), leaked: tools.some((tool) => tool.includes('rk_live')) })
        .toEqual({ harness: harness.id, identifiers: true, leaked: false });
    }
    expect(() => parseStepPage({ ...stepPages('mt_1', [{ ...step('ls'), tool: 'Read loop.ts' }], 0, { total: 0, shapes: {} })[0]! })).toThrow('steps[0].tool must be an identifier');
    expect(() => parseStepPage({ ...stepPages('mt_1', [{ ...step('ls'), callId: 'c 1' }], 0, { total: 0, shapes: {} })[0]! })).toThrow('steps[0].callId must be an id');
  });
});
