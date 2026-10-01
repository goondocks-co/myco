import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { MECHANISM_WORDS, RETIRED_VOCABULARY } from '../helpers/reader-vocabulary.ts';
import { serverReaderStrings } from '../helpers/server-reader-strings.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'packages/myco-server/src');

/** Exact diagnostic text allowed at a non-dashboard seam, with its purpose. */
const ALLOWED: Readonly<Record<string, string>> = {
  'core/worker-run.ts:the lease is no longer held': 'Worker protocol diagnostic; the dashboard never quotes it.',
  'core/harness.ts:the lease is no longer held': 'Worker completion diagnostic; the dashboard never quotes it.',
  'api/worker.ts:the lease is no longer held': 'Worker protocol diagnostic; the dashboard never quotes it.',
  'api/worker.ts:lease names a projectId and a runId': 'Worker renewal request grammar; the dashboard never sends it.',
};

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : entry.name.endsWith('.ts') ? [file] : [];
  });
}

const strings = serverReaderStrings([
  ...['api', 'core', 'read'].flatMap((dir) => sources(path.join(SRC, dir))),
  ...['bun', 'cloudflare'].map((target) => path.join(SRC, 'platform', target, 'store-maintenance.ts')),
  path.join(SRC, 'platform/cloudflare/recovery-export.ts'),
]);
const key = (entry: { file: string; text: string }) => `${path.relative(SRC, entry.file)}:${entry.text}`;

describe('server reader vocabulary', () => {
  it('traces a non-empty set of diagnostics and the stale run constant', () => {
    expect(strings.length).toBeGreaterThan(100);
    expect(strings.some((entry) => entry.text === 'the machine running it stopped responding')).toBe(true);
  });

  it('uses reader words for every literal flowing into dashboard diagnostic fields', () => {
    const hits = strings.filter((entry) => (MECHANISM_WORDS.test(entry.text) || RETIRED_VOCABULARY.test(entry.text)) && ALLOWED[key(entry)] === undefined);
    expect(hits.map((entry) => `${path.relative(SRC, entry.file)}:${entry.line} "${entry.text}"`)).toEqual([]);
  });

  it('keeps each exception tied to exact text that is still present', () => {
    const present = new Set(strings.map(key));
    expect(Object.keys(ALLOWED).filter((allowed) => !present.has(allowed))).toEqual([]);
    expect(Object.values(ALLOWED).every((reason) => reason.trim().length > 0)).toBe(true);
  });
});


it('traces constants, helper returns, parameters, assignments, templates and findings across files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-words-'));
  try {
    const constants = path.join(dir, 'constants.ts');
    const source = path.join(dir, 'api.ts');
    fs.writeFileSync(constants, "export const STALE_RUN_ERROR = 'the runtime went away';");
    fs.writeFileSync(source, [
      "import { STALE_RUN_ERROR as stale } from './constants.js';",
      "const badRequest = (reason: string) => ({ error: 'bad_request', reason });",
      "function reason() { return 'Deployment could not run'; }",
      "const answer = badRequest(reason());",
      "const failStaleRun = (...args: unknown[]) => args; failStaleRun(null, null, null, 0, stale);",
      "let detail: string; detail = 'harness refused it'; const refusal = { detail };",
      "const findings = ['lease expired']; const check = { findings };",
      "findings.push('Observations found'); const later = { reason: '' }; later.reason = 'runtime stopped';",
      "const recovery = { idleBecause: `the Deployment waits for ${1}`, available: { needs: 'credential missing' } };",
      "const lookup = new Map().get('runtime'); // A lookup key is not prose.",
    ].join('\n'));
    const text = serverReaderStrings([source]).map((entry) => entry.text);
    for (const sentence of ['the runtime went away', 'Deployment could not run', 'harness refused it', 'lease expired', 'Observations found', 'runtime stopped', 'the Deployment waits for …', 'credential missing']) expect(text).toContain(sentence);
    expect(text).not.toContain('runtime');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
