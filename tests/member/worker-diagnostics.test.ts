/**
 * A harness that stops on a missing login, a rate limit, a timeout or a crash is recorded by its coded reason, read
 * by each driver from that harness's own stream (`tests/fixtures/runner/diagnostics/`): Claude Code and Codex from a
 * stub that writes the recorded stream and stderr and exits as the harness did, the agent protocol from a peer that
 * answers as OpenCode does. The words the harness said — each case carries a secret — never reach the run's error;
 * a worker keeps them only in its local diagnostics log, bounded and rotated.
 */
import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyDiagnostic, harnessStoppedError, shapeRunError, type RunDiagnosticCode } from '@goondocks/myco-shared/run-text';
import { claudeCodeDriver } from '@myco/runner/drivers/claude-code.js';
import { codexDriver } from '@myco/runner/drivers/codex.js';
import { turnOver, runAsking, type Channel } from '@myco/runner/drivers/acp.js';
import type { RunTools } from '@myco/runner/drivers/run-tools.js';
import { harnessById } from '@myco/runner/harnesses.js';
import { writeRunDir } from '@myco/runner/mcp-config.js';
import { runWorker } from '@myco/runner/loop.js';
import { diagnosticLogPath, keepDiagnostic, maskedDetail, MAX_BACKUPS, MAX_ENTRY_CHARS, MAX_LOG_AGE_MS } from '@myco/runner/diagnostic-log.js';
import type { RunEvent } from '@myco/runner/events.js';
import { profileWorkerServer } from '../helpers/profile-worker-server.js';
import { STUB_PROFILE } from '../helpers/stub-profile-harness.ts';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';
import { AWS_SECRET, CORPUS, OPENAI_KEY, DIAGNOSTIC_PAYLOADS } from '../helpers/secret-corpus.ts';

const CASES = ['login_missing', 'rate_limited', 'timed_out', 'crashed'] as const;
type Case = (typeof CASES)[number];
interface NativeCase { recorded: boolean; stdout: string[]; stderr: string; exit: number }
interface AcpCase { recorded: boolean; prompt: { error: { code: number; message: string } } | 'close'; stderr: string }

const fixture = <T>(name: string): Record<Case, T> => JSON.parse(readFileSync(new URL(`../fixtures/runner/diagnostics/${name}`, import.meta.url), 'utf8')) as Record<Case, T>;
/** The secrets each case is run with: a key, a plain word and a slash-segmented key. */
const SECRETS: readonly string[] = [OPENAI_KEY, 'hunter22', AWS_SECRET];
const CONNECTION = { serverUrl: 'https://deployment.example', projectId: 'proj_1', runToken: 'tok_run_secret' };

/** Every string in a value with `{{SECRET}}` replaced. */
function withSecret<T>(value: T, secret: string): T {
  return JSON.parse(JSON.stringify(value), (_key, field: unknown) => (typeof field === 'string' ? field.replaceAll('{{SECRET}}', secret) : field)) as T;
}

/** A stub on PATH under `name` that writes these stdout lines and this stderr, then exits as told; a login probe exits 0. */
function stub(name: string, recorded: NativeCase): string {
  const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-diagnostic-')));
  writeFileSync(join(dir, 'stdout.jsonl'), `${recorded.stdout.join('\n')}\n`);
  writeFileSync(join(dir, 'stderr.txt'), recorded.stderr);
  writeFileSync(join(dir, name), [
    '#!/bin/sh',
    'if [ "$1" = "auth" ]; then exit 0; fi',
    `cat "${join(dir, 'stdout.jsonl')}"`,
    `cat "${join(dir, 'stderr.txt')}" >&2`,
    `exit ${recorded.exit}`,
  ].join('\n'), { mode: 0o755 });
  chmodSync(join(dir, name), 0o755);
  return dir;
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const runDir = () => writeRunDir(removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-run-'))), 'run_1', CONNECTION);

/** What a run's record carries of a harness that ended so: the worker's coded error, and the Deployment's re-check of it. */
function recorded(harness: string, events: readonly RunEvent[]): { code: RunDiagnosticCode; error: string; stored: string } {
  const last = events.at(-1)!;
  if (last.kind !== 'ended' || last.stop !== 'error') throw new Error(`the harness ended ${JSON.stringify(last)}`);
  const diagnostic = classifyDiagnostic(harness, last);
  const error = harnessStoppedError('error', diagnostic);
  return { code: diagnostic.code, error, stored: shapeRunError(error, harness)! };
}

async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous ?? ''}`;
  try { return await fn(); } finally { process.env.PATH = previous; }
}

for (const [harness, binary, driver, file] of [
  ['claude-code', 'claude', claudeCodeDriver, 'claude-code.json'],
  ['codex', 'codex', codexDriver, 'codex.json'],
] as const) {
  describe(`the ${harness} driver's stops, read as coded reasons`, () => {
    const cases = fixture<NativeCase>(file);
    for (const name of CASES) {
      it(`records ${name}${cases[name].recorded ? ' (recorded)' : ''} as its code, with nothing the harness said`, async () => {
        for (const secret of SECRETS) {
          const events = await withPath(stub(binary, withSecret(cases[name], secret)), () => collect(driver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal)));
          const { code, error, stored } = recorded(harness, events);
          expect(code).toBe(name);
          expect(stored).toBe(error);
          for (const word of [secret, 'Unauthorized', 'panicked', 'TypeError', 'Request']) expect(error).not.toContain(word);
          if (name === 'crashed') expect(error).toBe(`the harness stopped: error (crashed; exit code ${cases[name].exit})`);
        }
      }, 15_000);
    }
  });
}

describe('the agent-protocol driver\'s stops, read as coded reasons', () => {
  const cases = fixture<AcpCase>('opencode-acp.json');
  const RUN_AGENT = 'myco-run-test';
  const asking = runAsking(harnessById('opencode'), RUN_AGENT);
  const listed = async (): Promise<RunTools> => ({ ok: true, names: new Set(['myco_run']) });

  /** A peer that answers OpenCode's handshake and answers the prompt as the case says. */
  function peer(prompt: AcpCase['prompt']): Channel {
    let read: ((line: string) => void) | null = null;
    let closed: (() => void) | null = null;
    return {
      write: (line) => {
        const { id, method } = JSON.parse(line) as { id: number; method: string };
        if (method === 'session/prompt' && prompt === 'close') { queueMicrotask(() => closed?.()); return; }
        const answer = method === 'session/prompt' ? { error: (prompt as { error: unknown }).error }
          : { result: method === 'session/new' ? { sessionId: 'sess_acp', configOptions: [{ id: 'mode', currentValue: RUN_AGENT }] } : {} };
        queueMicrotask(() => read?.(`${JSON.stringify({ jsonrpc: '2.0', id, ...answer })}\n`));
      },
      onLine: (fn) => { read = fn; },
      onClose: (fn) => { closed = fn; },
    };
  }

  for (const name of CASES) {
    it(`records ${name} as its code, with nothing the harness said`, async () => {
      for (const secret of SECRETS) {
        const said = withSecret(cases[name], secret);
        const events = await collect(turnOver(peer(said.prompt), 'opencode', { ...runDir(), prompt: 'do it', credentialEnv: {} }, () => said.stderr, listed, { asking }));
        const { code, error, stored } = recorded('opencode', events);
        expect(code).toBe(name);
        expect(stored).toBe(error);
        for (const word of [secret, 'ProviderAuthError', 'panic', 'Too Many']) expect(error).not.toContain(word);
      }
    });
  }
});

describe('a worker driving a harness that fails', () => {
  it('reports the coded reason alone, and projects local diagnostic detail before writing it', async () => {
    const scratch = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-worker-diagnostics-')));
    const ends: Array<Record<string, unknown>> = [];
    // The run's credential, which a harness may echo, is masked wherever it appears.
    const credential = 'plainCredentialValue1';
    const said = [...CORPUS.map((leak) => leak.command), `using ${credential} and ${OPENAI_KEY}`].join('\n');
    const dir = stub('claude', { recorded: false, stdout: ['{"type":"system","subtype":"init","session_id":"s"}'], stderr: said, exit: 3 });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.endsWith('/worker/claim')) {
        return Response.json({
          persisted: true, claimed: true, heartbeatMs: 60_000,
          run: { projectId: 'proj_1', id: 'run_said', task: 'title-summary', instruction: 'do it', harness: 'claude-code', runToken: 'tok_run', credentialEnv: { ANTHROPIC_API_KEY: credential }, profile: STUB_PROFILE, timeoutSeconds: 300 },
        });
      }
      if (url.endsWith('/worker/end')) { ends.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json({ persisted: true, ended: true }); }
      return Response.json({ persisted: true });
    }) as unknown as typeof fetch;
    const logged: string[] = [];
    await withPath(dir, () => runWorker({
      serverUrl: 'https://deployment.example', token: 'tok', lockDir: null, only: ['claude-code'],
      runRoot: join(scratch, 'runs'), diagnosticRoot: join(scratch, 'diagnostics'),
      once: true, pollIdleMs: 3_000, log: (line) => { logged.push(line); }, fetchImpl: profileWorkerServer(fetchImpl), signal: new AbortController().signal,
    }));
    expect(ends.map(({ status, error }) => ({ status, error }))).toEqual([{ status: 'failed', error: 'the harness stopped: error (crashed; exit code 3)' }]);
    const leaked = CORPUS.flatMap((leak) => leak.secrets.filter((secret) => [JSON.stringify(ends), ...logged].some((text) => text.includes(secret))).map((secret) => `${leak.name}: ${secret}`));
    expect(leaked).toEqual([]);
    const kept = readFileSync(diagnosticLogPath(join(scratch, 'diagnostics')), 'utf8');
    expect(JSON.parse(kept.trim())).toMatchObject({ runId: 'run_said', harness: 'claude-code', error: 'the harness stopped: error (crashed; exit code 3)' });
    expect(kept).not.toContain('hunter22');
    expect(kept).not.toContain(credential);
    expect(kept).not.toContain(OPENAI_KEY);
    expect(statSync(diagnosticLogPath(join(scratch, 'diagnostics'))).mode & 0o777).toBe(0o600);
  }, 20_000);
});

describe('the local diagnostics log', () => {
  it('bounds each entry and rotates the file, keeping a bounded number of earlier files', () => {
    const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-diagnostic-log-')));
    for (let i = 0; i < 8; i += 1) keepDiagnostic(dir, { runId: `run_${i}`, harness: 'codex', error: 'e', detail: 'x'.repeat(MAX_ENTRY_CHARS * 2) }, 1, { maxBytes: 100 });
    const live = diagnosticLogPath(dir);
    const entry = JSON.parse(readFileSync(live, 'utf8').trim()) as { runId: string; detail: string };
    expect(entry.runId).toBe('run_7');
    expect(entry.detail.length).toBeLessThanOrEqual(MAX_ENTRY_CHARS);
    expect(entry.detail).toBe('…');
    for (let n = 1; n <= MAX_BACKUPS; n += 1) expect(existsSync(`${live}.${n}`)).toBe(true);
    expect(existsSync(`${live}.${MAX_BACKUPS + 1}`)).toBe(false);
  });

  it('rotates before a write would take the file past its bound, so the live file never crosses it', () => {
    const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-diagnostic-log-')));
    const bound = 1_000;
    for (let i = 0; i < 12; i += 1) {
      keepDiagnostic(dir, { runId: `run_${i}`, harness: 'codex', error: 'e', detail: 'x'.repeat(200) }, 1, { maxBytes: bound });
      expect(statSync(diagnosticLogPath(dir)).size).toBeLessThanOrEqual(bound);
    }
  });

  it('removes a file whose newest entry is older than its age bound', () => {
    const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-diagnostic-log-')));
    const now = Date.now();
    keepDiagnostic(dir, { runId: 'run_old', harness: 'codex', error: 'e', detail: 'old words' }, now);
    keepDiagnostic(dir, { runId: 'run_older', harness: 'codex', error: 'e', detail: 'older words' }, now, { maxBytes: 1 });
    const stale = (now - MAX_LOG_AGE_MS - 60_000) / 1000;
    utimesSync(diagnosticLogPath(dir), stale, stale);
    utimesSync(`${diagnosticLogPath(dir)}.1`, stale, stale);
    keepDiagnostic(dir, { runId: 'run_new', harness: 'codex', error: 'e', detail: 'new words' }, now);
    expect(readFileSync(diagnosticLogPath(dir), 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { runId: string }).runId)).toEqual(['run_new']);
    expect(existsSync(`${diagnosticLogPath(dir)}.1`)).toBe(false);
  });

  it('masks every credential value verbatim and every known key shape before it writes', () => {
    const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-diagnostic-log-')));
    keepDiagnostic(dir, { runId: 'run_1', harness: 'codex', error: 'e', detail: `auth with plainCredentialValue1, then ${OPENAI_KEY} and Bearer ${AWS_SECRET}` }, Date.now(), { secrets: ['plainCredentialValue1', 'x'] });
    const kept = readFileSync(diagnosticLogPath(dir), 'utf8');
    for (const secret of ['plainCredentialValue1', OPENAI_KEY, AWS_SECRET]) expect(kept).not.toContain(secret);
    expect(kept).not.toContain('auth with');
    expect(maskedDetail('the harness stopped: error (timed_out)')).toBe('…');
  });
});


describe('diagnostic payload privacy', () => {
  for (const leak of DIAGNOSTIC_PAYLOADS) {
    it(`omits ${leak.name} before writing the local artifact`, () => {
      const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-diagnostic-payload-')));
      keepDiagnostic(dir, { runId: 'run_1', harness: 'codex', error: 'the harness stopped: error (harness_error)', detail: leak.command });
      const stored = readFileSync(diagnosticLogPath(dir), 'utf8');
      for (const secret of leak.secrets) expect(stored).not.toContain(secret);
    });
  }
});
