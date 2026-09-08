/**
 * Transcript fixtures are reduced from real sessions, and this repository is
 * public. A fixture is a file someone will copy the next one from, so the
 * discipline has to be a gate rather than a habit: every file under
 * `tests/fixtures/` is walked, and anything shaped like a person's machine or a
 * credential fails BY NAME with the line that carries it.
 *
 * The patterns are deliberately blunt. A false positive costs one edit to a
 * fixture nobody reads for its realism; a false negative publishes something
 * that cannot be unpublished.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures');

/** What may not appear in a published fixture, and the name each failure reports. */
const FORBIDDEN: readonly { name: string; pattern: RegExp }[] = [
  { name: 'a home directory path', pattern: /\/(?:Users|home)\/(?!fixture\b|test\b)[A-Za-z0-9._-]+/ },
  { name: 'a Windows user profile path', pattern: /[A-Za-z]:\\\\?Users\\\\?(?!fixture\b|test\b)[A-Za-z0-9._-]+/i },
  { name: 'an ssh or pem private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { name: 'a Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'an Anthropic or OpenAI key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'a bearer credential', pattern: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}/ },
  { name: 'a Myco member credential', pattern: /\bmt_[A-Za-z0-9_-]{12,}\b/ },
  { name: 'an email address', pattern: /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)\b|fixture\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { name: 'a routable IPv4 address', pattern: /\b(?!0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|255\.)(?:\d{1,3}\.){3}\d{1,3}\b/ },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('published fixtures', () => {
  const files = walk(FIXTURES);

  it('holds at least the transcript fixtures the parsers are proved against', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('detects each thing it forbids, so a passing sweep means the patterns fired on nothing rather than never firing', () => {
    const samples: Record<string, string> = {
      'a home directory path': '"cwd":"/Users/dana/Repos/thing"',
      'a Windows user profile path': '"cwd":"C:\\\\Users\\\\Dana\\\\repo"',
      'an ssh or pem private key': '-----BEGIN OPENSSH PRIVATE KEY-----',
      'an AWS access key id': 'AKIAIOSFODNN7EXAMPLE',
      'a GitHub token': 'ghp_0123456789abcdefghijABCDEFGHIJ',
      'a Slack token': 'xoxb-0123456789-abcdefghij',
      'an Anthropic or OpenAI key': 'sk-abcdefghijklmnopqrstuvwxyz',
      'a bearer credential': 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'a Myco member credential': 'mt_dfA3kS2nYJaoV35O',
      'an email address': 'someone@somewhere.net',
      'a routable IPv4 address': 'connected to 203.0.113.7',
    };
    for (const { name, pattern } of FORBIDDEN) {
      expect({ name, detects: pattern.test(samples[name] ?? '') }).toEqual({ name, detects: true });
    }
  });

  it('admits the placeholders a fixture is allowed to carry', () => {
    const allowed = ['"cwd":"/tmp/fixture"', '"cwd":"/Users/fixture/repo"', 'someone@example.com', 'listening on 127.0.0.1', 'peer 10.0.0.4', 'gateway 192.168.1.1'];
    for (const line of allowed) {
      const hit = FORBIDDEN.find(({ pattern }) => pattern.test(line));
      expect({ line, forbiddenBy: hit?.name ?? null }).toEqual({ line, forbiddenBy: null });
    }
  });

  it('carries no home path, address, or credential-shaped string', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(REPO_ROOT, file);
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const { name, pattern } of FORBIDDEN) {
          const found = pattern.exec(line);
          if (found !== null) offenders.push(`${relative}:${i + 1} carries ${name}: ${found[0].slice(0, 40)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
