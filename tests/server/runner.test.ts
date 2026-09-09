/**
 * What a failed command tells the operator. A `--json` command names its
 * failure on stdout while its configuration warnings fill stderr, so the
 * message a refusal carries has to be built from both streams rather than from
 * stderr alone.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandFailed, commandFailureDetail, systemRunner, WorkingDirectoryMissing } from '@myco/server/runner.js';

const failed = (stdout: string, stderr: string, code = 1): CommandFailed =>
  new CommandFailed('npx', ['wrangler', 'd1', 'execute', 'myco-server'], { code, stdout, stderr });

/** A wrangler configuration warning, as it reaches stderr around a failure. */
const WARNING = [
  '',
  '\u001b[33m\u25b2 \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m Processing wrangler.deploy.toml configuration:',
  '',
  '    - Unexpected fields found in top-level field: "unstable_dev"',
  '',
  '',
].join('\n');

describe('a failed command names what it printed', () => {
  it('reads the JSON error document wrangler writes to stdout, with each note it carries', () => {
    const document = JSON.stringify({
      error: {
        text: 'A request to the Cloudflare API (/accounts/a/d1/database/b/query) failed.',
        notes: [{ text: 'internal error; reference = 7f3c1d2e' }, { text: '' }],
        kind: 'error',
        name: 'APIError',
        code: 7400,
      },
    });
    const err = failed(`${WARNING}${document}\n`, WARNING);

    expect(err.message).toContain('A request to the Cloudflare API');
    expect(err.message).toContain('internal error; reference = 7f3c1d2e');
    expect(err.message).toContain('exited 1');
    expect(err.message).not.toContain('Unexpected fields');
    expect({ stdout: err.stdout.includes(document), stderr: err.stderr }).toEqual({ stdout: true, stderr: WARNING });
  });

  it('GATE: a stderr that holds only a configuration warning does not become the message', () => {
    const err = failed('\u2718 the D1 database myco-server could not be reached\n', `${WARNING}\u001b[31m\u2718 [ERROR] npx exited with 1\u001b[0m\n`);

    expect(err.message).toContain('the D1 database myco-server could not be reached');
    expect(err.message).toContain('npx exited with 1');
    expect(err.message).not.toContain('Unexpected fields');
    expect(err.message).not.toContain('Processing wrangler.deploy.toml');
  });

  it('carries both streams when neither holds a JSON document, npm notices dropped and the tail bounded', () => {
    const stdout = ['npm notice run npx', ...Array.from({ length: 20 }, (_, at) => `line ${at}`)].join('\n');
    const detail = commandFailureDetail({ code: 1, stdout, stderr: 'docker daemon unreachable\n' });

    expect(detail.split('\n')).toEqual(['line 14', 'line 15', 'line 16', 'line 17', 'line 18', 'line 19', 'docker daemon unreachable']);
    expect(detail).not.toContain('npm notice');
    expect(commandFailureDetail({ code: 1, stdout: 'x'.repeat(4000), stderr: '' }).length).toBe(1000);
  });

  it('GATE: never drops everything — output that is all noise is carried raw', () => {
    const err = failed('', WARNING);
    expect(err.message).toContain('Unexpected fields found in top-level field');
  });
});

/**
 * Where a command is asked to run, when it is asked to run somewhere that does
 * not exist.
 */
describe('a command pointed at a directory that is not there', () => {
  it('GATE: names the directory rather than the command, which is on the PATH', async () => {
    const absent = join(tmpdir(), 'myco-runner-absent', 'never-created');
    const refused = await systemRunner().run('npx', ['--version'], { cwd: absent }).catch((err: unknown) => err as Error);

    expect(refused).toBeInstanceOf(WorkingDirectoryMissing);
    // The platform reports this as ENOENT against `npx`, which sends whoever
    // reads it hunting for a program that is installed.
    expect(refused.message).toContain(absent);
    expect(refused.message).not.toContain('posix_spawn');
    expect(refused.message).not.toContain('no such file or directory, ');
  });
});
