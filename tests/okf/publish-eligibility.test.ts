import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanStagedBundle } from '@myco/okf/publish-eligibility.js';
import { OKF_MARKER_FILENAME } from '@myco/okf/types.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-pubelig-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const CLEAN = '---\ntype: decision\ntitle: T\ndescription: D\ntimestamp: 2026-07-05\nmyco_id: d1\n---\n\nA normal decision about retries.\n';

function codes(root_: string): string[] {
  return scanStagedBundle(root_).map((f) => f.code);
}

describe('scanStagedBundle', () => {
  it('returns no findings for a clean bundle', () => {
    write('index.md', '---\nokf_version: "0.1"\ntype: Myco OKF Bundle\n---\n\n# Bundle\n');
    write('spores/decisions/d1.md', CLEAN);
    expect(scanStagedBundle(root)).toEqual([]);
  });

  it('flags an AWS access key in a concept body', () => {
    write('spores/decisions/d1.md', CLEAN.replace('retries.', 'retries. key AKIAIOSFODNN7EXAMPLE here'));
    const findings = scanStagedBundle(root);
    expect(findings.map((f) => f.code)).toEqual(['likely_secret']);
    expect(findings[0].path).toBe('spores/decisions/d1.md');
    // The excerpt masks the middle of the key.
    expect(findings[0].excerpt).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('flags a private key header', () => {
    write('concepts/leak.md', CLEAN + '\n-----BEGIN RSA PRIVATE KEY-----\n');
    expect(codes(root)).toContain('likely_secret');
  });

  it('flags an absolute local path', () => {
    write('canopy/files/src/a.ts.md', CLEAN.replace('retries.', 'retries. see /Users/chris/secret/notes.txt'));
    const findings = scanStagedBundle(root);
    expect(findings.map((f) => f.code)).toContain('absolute_local_path');
  });

  it('flags a raw session identifier by key name and by UUID shape', () => {
    write('a.md', CLEAN.replace('retries.', 'retries. session_id: abc'));
    expect(codes(root)).toContain('raw_session_identifier');

    fs.rmSync(path.join(root, 'a.md'));
    write('b.md', CLEAN.replace('retries.', 'retries. 550e8400-e29b-41d4-a716-446655440000'));
    expect(codes(root)).toContain('raw_session_identifier');
  });

  it('flags a sensitive filename represented as a canopy concept', () => {
    // A canopy concept whose repo path is a secret file.
    write(
      'canopy/files/.env.md',
      '---\ntype: Source File\ntitle: .env\ndescription: env\ntimestamp: 2026-07-05\nmyco_path: .env\n---\n\n# Summary\n\nenv file.\n',
    );
    const findings = scanStagedBundle(root);
    expect(findings.map((f) => f.code)).toContain('sensitive_filename');
    expect(findings.find((f) => f.code === 'sensitive_filename')?.excerpt).toBe('.env');
  });

  it('derives the sensitive path from the bundle path when frontmatter is unparseable', () => {
    write('canopy/files/id_rsa.md', 'not a valid concept doc');
    expect(codes(root)).toContain('sensitive_filename');
  });

  it('skips the marker file and non-markdown files', () => {
    write(OKF_MARKER_FILENAME, '{"generator":"myco","secret":"AKIAIOSFODNN7EXAMPLE"}');
    write('data.json', 'AKIAIOSFODNN7EXAMPLE');
    write('spores/decisions/d1.md', CLEAN);
    expect(scanStagedBundle(root)).toEqual([]);
  });

  it('returns findings in deterministic path order', () => {
    write('z.md', CLEAN.replace('retries.', 'retries. AKIAIOSFODNN7EXAMPLE'));
    write('a.md', CLEAN.replace('retries.', 'retries. /home/chris/x'));
    const findings = scanStagedBundle(root);
    expect(findings.map((f) => f.path)).toEqual(['a.md', 'z.md']);
  });
});
