/**
 * What a run's record keeps of free text a harness, a worker or an agent wrote (`run-text.ts`).
 *
 * A diagnostic is stored as a coded reason alone: whatever a harness or a worker said, no word of it reaches the run's
 * error, on the worker that writes it or on the Deployment that stores it. Agent prose is bounded and masked: code
 * fences and here-documents collapse, a command quoted inline is held to the shape of a command, and no key-shaped
 * value survives anywhere. The corpus is every input an adversarial probe found a secret surviving in.
 */
import { describe, expect, it } from 'bun:test';
import { keyLike } from '@goondocks/myco-shared/command-shape';
import { PROVIDER_KEY_PREFIXES, redactSecrets } from '@goondocks/myco-shared/redact-secrets';
import {
  agentProse, budgetError, classifyDiagnostic, failedCallsError, HARNESS_NO_ENDING_ERROR, harnessStoppedError, parseRunError,
  PATTERNED_DIAGNOSTIC_CODES, RUN_DIAGNOSTIC_CODES, RUN_STOP_REASONS, runErrorDiagnostic, shapeRunError, WORKER_FAILURE_CODES,
  WORKER_START_CODES, workerFailedError, workerStartError,
} from '@goondocks/myco-shared/run-text';
import { RUNNER_HARNESSES } from '../../packages/myco-shared/src/runner-harnesses.generated.ts';
import {
  AWS_KEY_ID, AWS_SECRET, BARE_JWT, BASE64_SECRET, CORPUS, FREE_TEXT, GITHUB_FINE, GITHUB_PAT, GITHUB_SHORT, GITLAB_PAT, GITLAB_SHORT, GOOGLE_KEY,
  OPENAI_KEY, OPENAI_LETTERS, PROSE, SLACK_BOT, SLACK_USER, STRIPE_LIVE, STRIPE_SHORT, UUID_KEY, type Leak,
} from '../helpers/secret-corpus.ts';

const HARNESS_IDS: readonly string[] = RUNNER_HARNESSES.map((harness) => harness.id);
const KEYS: readonly string[] = [STRIPE_LIVE, OPENAI_KEY, GITHUB_PAT, SLACK_BOT, GITLAB_PAT, AWS_KEY_ID, AWS_SECRET, BARE_JWT, BASE64_SECRET, UUID_KEY];
/** Each access key as a leak whose every distinctive fragment is a secret. */
const KEY_LEAKS: readonly Leak[] = KEYS.map((key) => ({ name: `the key ${key.slice(0, 4)}…`, command: key, secrets: [key, key.slice(0, 12), key.slice(-12)] }));
const ALL: readonly Leak[] = [...CORPUS, ...FREE_TEXT, ...KEY_LEAKS];

const leaksIn = (leak: Leak, stored: string | null): string[] => leak.secrets.filter((secret) => (stored ?? '').includes(secret)).map((secret) => `${leak.name}: ${secret}`);

describe('a harness diagnostic, stored as a coded reason', () => {
  /** How a harness says why it stopped: its stderr after a crash, an in-band error, a protocol error's message. */
  const SAID: ReadonlyArray<(said: string) => string> = [
    (said) => said,
    (said) => `Error: request failed: ${said}\n    at main (file:///usr/lib/harness/cli.js:12:3)\n`,
    (said) => `the harness wrote no result and exited 1: ${said}`,
    (said) => `profile_unapplied: it refused the model ${said} (${said})`,
  ];

  it('keeps no word a harness said, through the worker\'s classification and the Deployment\'s re-check alike', () => {
    const leaked: string[] = [];
    for (const harness of [...HARNESS_IDS, 'unknown-harness']) {
      for (const leak of ALL) {
        // A refused tool's name is the identifier the harness's own registry gives it, kept as the failed-calls note keeps
        // one (`identifierShape`); a name the harness gives that is no identifier is never kept.
        const names = FREE_TEXT.includes(leak) ? ['Read'] : [leak.command, 'Read'];
        for (const say of SAID) {
          const detail = say(leak.command);
          const written = harnessStoppedError('error', classifyDiagnostic(harness, { detail, exitCode: 1, signal: 'SIGKILL', names }));
          const permission = harnessStoppedError('error', classifyDiagnostic(harness, { code: 'permission_refused', detail, names }));
          for (const stored of [
            written, permission, shapeRunError(written, harness), shapeRunError(detail, harness), shapeRunError(`the harness stopped: error (${detail})`, harness),
            shapeRunError(`the harness stopped: refusal (${detail})`, harness), shapeRunError(`${detail}\nthe harness stopped: error (crashed)`, harness),
          ]) {
            leaked.push(...leaksIn(leak, stored));
            expect(stored === null || parseRunError(stored) !== null).toBe(true);
          }
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  it('keeps every sentence a worker writes exactly as written', () => {
    const written = [
      ...RUN_STOP_REASONS.filter((stop) => stop !== 'error').map((stop) => harnessStoppedError(stop)),
      ...RUN_DIAGNOSTIC_CODES.map((code) => harnessStoppedError('error', { code })),
      harnessStoppedError('error', { code: 'crashed', exitCode: 137, signal: 'SIGKILL' }),
      harnessStoppedError('error', { code: 'login_missing', exitCode: -1 }),
      harnessStoppedError('error', classifyDiagnostic('claude-code', { code: 'permission_refused', names: ['mcp__myco__myco_run', 'Read'] })),
      ...WORKER_START_CODES.map((code) => workerStartError(code, 'claude-code')),
      workerStartError('no_instruction', 'title-summary'),
      workerStartError('profile_unapplied'),
      ...WORKER_FAILURE_CODES.map((code) => workerFailedError(code)),
      budgetError(300),
      HARNESS_NO_ENDING_ERROR,
      failedCallsError([{ name: 'Bash', outcome: 'exit code 1', count: 2 }, { name: 'mcp__myco__myco_run', outcome: 'refused', count: 1 }], 3, 2, true),
      failedCallsError([{ name: 'tool', outcome: 'timed out', count: 1 }], 1, 0, false),
    ];
    for (const sentence of written) {
      expect(parseRunError(sentence)).not.toBeNull();
      expect(shapeRunError(sentence, 'claude-code')).toBe(sentence);
    }
  });

  it('codes a sentence again wherever anything was added to it, so nothing rides along on a sentence\'s shape', () => {
    const tampered = [
      'the harness stopped: error (login_missing) S3cret',
      'the harness stopped: error (login_missing; exit code 1; hunter22)',
      'the harness stopped: error (permission_refused: Read, echo hunter22)',
      'the harness stopped: error (login_missing: hunter22)',
      'the harness stopped: end_turn (hunter22)',
      'the worker could not start the run (no_driver: hunter22 S3cret)',
      'the worker failed while driving the run (repository_unprepared: hunter22)',
      'the run outlived its budget of 300s hunter22',
      'a call failed or was refused: Bash (hunter22)',
      'a call failed or was refused: echo S3cret (failed)',
      `2 calls failed or were refused: Bash (failed); ${UUID_KEY} (failed)`,
    ];
    for (const text of tampered) {
      const shaped = shapeRunError(text, 'claude-code')!;
      expect(shaped).not.toBe(text);
      expect(shaped).not.toContain('hunter22');
      expect(shaped).not.toContain('S3cret');
      expect(shaped).not.toContain(UUID_KEY);
      expect(parseRunError(shaped)).not.toBeNull();
    }
  });

  it('reads a code from the stream\'s structure first, then its words by the harness\'s own patterns, then its exit status', () => {
    expect(classifyDiagnostic('claude-code', { code: 'tools_unlisted', detail: 'rate_limit', exitCode: 1 })).toEqual({ code: 'tools_unlisted', exitCode: 1 });
    expect(classifyDiagnostic('claude-code', { detail: 'profile_unapplied: it offers no model x' })).toEqual({ code: 'profile_unapplied' });
    expect(classifyDiagnostic('claude-code', { detail: 'rate_limit' })).toEqual({ code: 'rate_limited' });
    expect(classifyDiagnostic('codex', { detail: 'rate_limit' })).toEqual({ code: 'rate_limited' });
    expect(classifyDiagnostic('claude-code', { detail: 'segmentation fault', exitCode: 139 })).toEqual({ code: 'crashed', exitCode: 139 });
    expect(classifyDiagnostic('claude-code', { detail: 'segmentation fault', signal: 'SIGSEGV' })).toEqual({ code: 'crashed', signal: 'SIGSEGV' });
    expect(classifyDiagnostic('claude-code', { detail: 'something went wrong' })).toEqual({ code: 'harness_error' });
    // A harness the Deployment knows no patterns for is read by its exit status alone.
    expect(classifyDiagnostic('unknown-harness', { detail: 'rate_limit' })).toEqual({ code: 'harness_error' });
    // An exit of 0, a signal that is no signal name and names a refusal does not carry are never kept.
    expect(classifyDiagnostic('claude-code', { detail: 'x', exitCode: 0, signal: 'hunter22', names: ['Read'] })).toEqual({ code: 'harness_error' });
  });

  it('declares, for every harness a worker runs, a pattern for each reason its words are read as', () => {
    for (const harness of RUNNER_HARNESSES) {
      expect([...new Set(harness.diagnostics.map((rule) => rule.code))].sort()).toEqual([...PATTERNED_DIAGNOSTIC_CODES].sort());
    }
  });

  it('answers the reason a reader acts on from what a run error says', () => {
    expect(runErrorDiagnostic('the harness stopped: error (login_missing; exit code 1)')).toBe('login_missing');
    expect(runErrorDiagnostic('the harness stopped: refusal')).toBe('model_refused');
    expect(runErrorDiagnostic(budgetError(60))).toBe('timed_out');
    expect(runErrorDiagnostic('the worker reported a failure (rate_limited)')).toBe('rate_limited');
    expect(runErrorDiagnostic(workerStartError('no_driver', 'codex'))).toBeNull();
    expect(runErrorDiagnostic('the harness stopped: error (rate_limited) S3cret')).toBeNull();
    expect(runErrorDiagnostic(null)).toBeNull();
  });
});

/**
 * The plain words a probe's commands carry that agent prose cannot tell from a password: a word that is neither
 * key-shaped nor a value a secret-named flag or label introduces. An agent that writes one in its own sentence has
 * it stored, as its own words, with the run. Inline code, a code fence and a here-document never keep one.
 */
const PLAIN_WORDS: ReadonlySet<string> = new Set([
  'private/customer-note', 'customer-note.json',
  'letmein77', 'literal-secret-value', '123456', 'AUTH', 'qwerty', 'lowercasesecret', 'hunter22', 'hunter2', 'assword', 'oken',
  'secrets/prod.env', 'prod-signing', 'Bearer', 'X-Api-Key', 'root', 'deployer', 'openai', 'Winter', 'Coming', 'vllkbsi5',
  'Summer2024', 'hunterpass', 'rotation',
]);

describe('a harness diagnostic, never mislabelled', () => {
  /** A crash or an ordinary failure whose words carry a status code, a limit or a timeout somewhere other than its error. */
  const CRASHES: ReadonlyArray<{ said: string; exitCode?: number; signal?: string }> = [
    { said: 'segfault at line 401', exitCode: 139 },
    { said: 'panic: runtime error: index out of range [401] with length 3', exitCode: 2 },
    { said: 'thread main panicked at src/limits.rs:429:5', exitCode: 101 },
    { said: 'Traceback (most recent call last):\n  File "auth.py", line 401, in login\nKeyError: token', exitCode: 1 },
    { said: 'Unauthorized access to the cache; rate limit set to 10', signal: 'SIGSEGV' },
    { said: 'Error: request timeout reached', signal: 'SIGKILL' },
  ];
  /** Failures that name a code only in passing, deep in what the harness wrote, never on its error line. */
  const ORDINARY: readonly string[] = [
    'Error: could not open the config\n  at load (file:///a.js:401:12)\n  at main (file:///a.js:429:3)',
    'Error: unexpected token at line 401',
    'Error: 429 files changed, nothing staged',
    'Error: --timeout must be a number',
    // A status code in its context, but in a stack frame or in the middle of what it wrote, never on its error line.
    'Error: could not open the config\n    at retry (file:///http.js:3:1) status 401 Unauthorized',
    'Error: the build failed\nwarning: HTTP 429 from the mirror, retried\nstep 2\nstep 3\nstep 4\nstep 5',
  ];

  it('reads a crash as a crash, whatever code or limit its words mention', () => {
    for (const harness of HARNESS_IDS) {
      for (const { said, exitCode, signal } of CRASHES) {
        expect({ harness, said, code: classifyDiagnostic(harness, { detail: said, exitCode, signal }).code }).toEqual({ harness, said, code: 'crashed' });
      }
    }
  });

  it('reads no status code, limit or timeout outside its context and its error line', () => {
    for (const harness of HARNESS_IDS) {
      for (const said of ORDINARY) {
        expect({ harness, said, code: classifyDiagnostic(harness, { detail: said }).code }).toEqual({ harness, said, code: 'harness_error' });
      }
    }
  });

  it('reads a status code in its context, on the error line', () => {
    expect(classifyDiagnostic('opencode', { detail: 'AI_APICallError: HTTP 401' }).code).toBe('login_missing');
    expect(classifyDiagnostic('claude-code', { detail: 'API Error: status 429 from the provider' }).code).toBe('rate_limited');
    expect(classifyDiagnostic('codex', { detail: 'stream disconnected\nerror: request timeout after 300s' }).code).toBe('timed_out');
  });
});

describe('a key known by its provider\'s prefix', () => {
  it('is key-like, and masked by redactSecrets from the same table', () => {
    for (const key of [STRIPE_SHORT, SLACK_USER, GITLAB_SHORT, GITHUB_SHORT, GITHUB_FINE, GOOGLE_KEY, OPENAI_LETTERS]) {
      expect({ key, keyLike: keyLike(key), redacted: redactSecrets(`with ${key} here`).includes(key) }).toEqual({ key, keyLike: true, redacted: false });
      expect(PROVIDER_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))).toBe(true);
    }
    for (const word of ['task-runner', 'risk-free', 'ASIAN', 'AKIA', 'desk-top']) expect({ word, keyLike: keyLike(word) }).toEqual({ word, keyLike: false });
  });
});

describe('agent prose, bounded and masked', () => {
  it('keeps no secret of the prose corpus, in a report or an audit, alone or inside a sentence', () => {
    const leaked = PROSE.flatMap((leak) => [
      leak.command, `Then I noted: ${leak.command}`, `Notes\n\n${leak.command}\n\nDone.`,
    ].flatMap((said) => [
      ...leaksIn(leak, agentProse(said, 65_536)),
      ...leaksIn(leak, agentProse(said, 500, { singleLine: true })),
    ]));
    expect(leaked).toEqual([]);
  });

  it('masks a labeled value to its closing quote, the next table cell or the end of its line, and keeps what follows', () => {
    expect(agentProse('The secret is "alpha beta" and the run ended.', 1_000)).toBe('The secret is "…" and the run ended.');
    expect(agentProse('passphrase: my dog spot\nNext line stands.', 1_000)).toBe('passphrase: …\nNext line stands.');
    expect(agentProse('| DB_PASSWORD | p@ss w0rd | kept |', 1_000)).toBe('| DB_PASSWORD | … | kept |');
  });

  const EMBEDDED: Readonly<Record<string, (command: string) => string>> = {
    'a code fence': (command) => `I ran:\n\`\`\`bash\n${command}\n\`\`\`\nand it worked.`,
    'an unclosed code fence': (command) => `I ran:\n~~~\n${command}`,
    'a here-document': (command) => `I wrote it with cat > .env <<'EOF'\n${command}\nEOF\nand it worked.`,
    'a here-document on one line': (command) => `I ran cat <<EOF ${command} EOF and it worked.`,
    'inline code': (command) => `I ran \`${command}\` and it worked.`,
  };

  for (const [form, embed] of Object.entries(EMBEDDED)) {
    it(`keeps no secret of a command quoted in ${form}, in a report or an audit alike`, () => {
      const leaked = [...CORPUS, ...KEY_LEAKS].flatMap((leak) => [
        ...leaksIn(leak, agentProse(embed(leak.command), 65_536)),
        ...leaksIn(leak, agentProse(embed(leak.command), 500, { singleLine: true })),
      ]);
      expect(leaked).toEqual([]);
    });
  }

  it('keeps no key-shaped value an agent writes in its own sentence, and no word but the plain words prose cannot tell apart', () => {
    const survived = new Set<string>();
    const keys: string[] = [];
    for (const leak of ALL) {
      const stored = agentProse(`Then I ran ${leak.command} and moved on.`, 65_536) ?? '';
      for (const secret of leak.secrets) {
        if (!stored.includes(secret)) continue;
        if (KEY_LEAKS.includes(leak)) keys.push(`${leak.name}: ${secret}`);
        survived.add(secret);
      }
    }
    expect(keys).toEqual([]);
    expect([...survived].filter((word) => !PLAIN_WORDS.has(word))).toEqual([]);
    for (const word of PLAIN_WORDS) expect(keyLike(word)).toBe(false);
  });

  it('collapses code-fence and here-document bodies, keeping the words around them', () => {
    expect(agentProse('Ran this:\n```sh\nexport A=1\ncat secret.txt\n```\nthen stopped.', 1_000)).toBe('Ran this:\n…\nthen stopped.');
    expect(agentProse('Ran this:\n```sh\ncat secret.txt', 1_000)).toBe('Ran this:\n…');
    expect(agentProse("cat > .env <<'EOF'\nSTRIPE=x\nEOF\nthen ran the tests", 1_000)).toBe("cat > .env <<'EOF' … EOF\nthen ran the tests");
    expect(agentProse('cat <<-END\n\tvalue\n\tEND\ndone', 1_000)).toBe('cat <<-END … END\ndone');
    expect(agentProse('cat << EOF\nhunter22\nEOF', 1_000)).toBe('cat << EOF … EOF');
    expect(agentProse('cat <<EOF\nhunter22 and the rest', 1_000)).toBe('cat <<EOF …');
    expect(agentProse('base64 -d <<< hunter22 | sh', 1_000)).toBe('base64 -d <<< … | sh');
  });

  it('reads a URL as its scheme and host, and an assignment, a credential and the word a secret names as …', () => {
    expect(agentProse('Fetched https://user:pw@api.example.test/v1/x?key=abc and http://k7x9q2mzp4.trycloudflare.com/x', 1_000)).toBe('Fetched https://api.example.test and http://…');
    expect(agentProse('Set DATABASE_URL=postgres://admin:pw@db and ran it', 1_000)).toBe('Set … and ran it');
    expect(agentProse('Logged in as deploy@host.example.test with --token abc and --password=hunter22', 1_000)).toBe('Logged in as … with --token … and --password=[REDACTED]');
    expect(agentProse('The password is hunter22, the api_key: zebra and the token was letmein', 1_000)).toBe('The password is …');
    expect(agentProse('openssl enc -pass pass:hunter22', 1_000)).toBe('openssl enc -pass …');
  });

  it('keeps an agent\'s ordinary account as it wrote it', () => {
    const account = 'Read `packages/myco-server/src/core/run-audit.ts:102`, ran `npm test` and fixed parseRunAudit; see #1615 and @goondocks/myco-shared.';
    expect(agentProse(account, 1_000)).toBe(account);
    expect(agentProse('Steps:\n1. Read the material.\n2. Wrote the title.', 1_000)).toBe('Steps:\n1. Read the material.\n2. Wrote the title.');
    expect(agentProse('Steps:\n1. Read the material.\r\n2. Wrote the title.', 1_000, { singleLine: true })).toBe('Steps: 1. Read the material. 2. Wrote the title.');
  });

  it('keeps complete ordinary label components and the prose beside quoted secrets', () => {
    for (const account of ['bypass: disabled. Fixed src/auth.ts.', 'compass: east. Updated src/auth.ts.', 'surpass: done. Updated the policy.', 'Reviewed ﬁle ①. Compass: east.']) {
      expect(agentProse(account, 1000)).toBe(account);
      expect(redactSecrets(account)).toBe(account);
    }
    for (const leak of PROSE.filter((case_) => case_.command.startsWith('Read the policy.\n'))) {
      const stored = agentProse(leak.command, 1000)!;
      expect(leaksIn(leak, stored)).toEqual([]);
      expect(stored).toContain('Read the policy.');
      expect(stored).toContain('Updated the policy.');
      expect(leaksIn(leak, redactSecrets(leak.command))).toEqual([]);
    }
  });

  it('keeps declared decimal token quantities in displayed instructions', () => {
    const quantities = 'Keep max_tokens=4096 and token_budget: 12000; token_limit=8000.';
    expect(redactSecrets(quantities)).toBe(quantities);
    for (const leak of PROSE.filter((case_) => case_.name.startsWith('token quantity payload'))) {
      expect(leaksIn(leak, redactSecrets(leak.command))).toEqual([]);
    }
  });

  it('is cut to its bound and is null where nothing is left', () => {
    expect(agentProse('word '.repeat(100), 20)).toHaveLength(20);
    expect(agentProse('word '.repeat(100), 20)!.endsWith('…')).toBe(true);
    expect(agentProse(' \n\t ', 20)).toBeNull();
  });
});
