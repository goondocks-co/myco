import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN, scanFixture } from '../../scripts/fixture-redaction.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures');

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
      for (const finding of scanFixture(readFileSync(file, 'utf8'))) {
        offenders.push(`${relative}:${finding.line} carries ${finding.rule}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
