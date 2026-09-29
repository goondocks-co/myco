/**
 * Meta gate: a member admits a server URL by one rule (`member/server-url.ts`).
 *
 * The registry once refused the loopback http URL that `myco login`, the join
 * code and the env source all accepted, so a laptop joined to its own native
 * Deployment captured nothing (#1459). Two copies of a rule drift; this gate
 * keeps one.
 *
 *   1. No member-side module outside the rule compares a URL's protocol, or
 *      tests a URL string for its scheme. A new check appears only in the rule.
 *   2. Every entry point that admits a member's server URL reads the rule.
 *
 * Static source scan.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../packages/myco/src/', import.meta.url));

/** The member-side trees: what a hook, a member verb, a bridge, the installer or the worker runner runs. */
const MEMBER_TREES = ['member', 'cli', 'hooks', 'mcp', 'symbionts', 'runner', 'install'] as const;

const RULE = 'member/server-url.ts';

/** Protocol checks that admit nothing, each with why it is not an admission. */
const ADMITTED: Record<string, string> = {
  [RULE]: 'the rule itself',
  'member/diagnostics.ts': 'strips userinfo, query and fragment from a URL it exports in a support bundle; it admits nothing',
};

/** The modules that admit a member's server URL, and so must read the rule. */
const ENTRY_POINTS = [
  'member/credential.ts', // registry resolution and the env source
  'member/join-code.ts', // `myco login` and `MYCO_JOIN_CODE`
  'cli/member.ts', // `myco member join` and `myco member mcp-headers`
  'symbionts/installer.ts', // which Deployment a member's MCP entry names
] as const;

/** A comparison against a URL scheme, or a scheme test on a URL string. */
const PROTOCOL_CHECK = [
  /\.protocol\s*[!=]==?\s*['"`]https?:['"`]/,
  /['"`]https?:['"`]\s*[!=]==?\s*[\w.]*\.protocol\b/,
  /\[\s*['"`]https?:['"`]\s*,/,
  /\.startsWith\(\s*['"`]https?:/,
  /\/\^https\??:?/,
];

const allFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const f = join(dir, e);
    return statSync(f).isDirectory() ? allFiles(f) : [f];
  });

/** The lines of `source` that check a scheme, with comments left out. */
function protocolChecks(source: string): string[] {
  return source.split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => PROTOCOL_CHECK.some((p) => p.test(line)))
    .map((line) => line.trim());
}

describe('the member server URL rule', () => {
  it('recognises every shape of scheme check it guards against', () => {
    const planted = [
      "if (new URL(v).protocol === 'https:') return true;",
      'if (url.protocol !== "http:") return null;',
      "if ('https:' === url.protocol) ok();",
      "return ['http:', 'https:'].includes(url.protocol);",
      "if (!value.startsWith('https://')) refuse();",
      'const ok = /^https:\\/\\//.test(value);',
    ];
    for (const line of planted) expect({ line, found: protocolChecks(line).length }).toEqual({ line, found: 1 });
    expect(protocolChecks(" * a comment naming `protocol === 'https:'` checks nothing")).toEqual([]);
  });

  it('is the only scheme check in member-side code', () => {
    const offenders: string[] = [];
    for (const tree of MEMBER_TREES) {
      for (const file of allFiles(join(SRC, tree)).filter((f) => f.endsWith('.ts'))) {
        const rel = relative(SRC, file);
        if (rel in ADMITTED) continue;
        for (const line of protocolChecks(readFileSync(file, 'utf8'))) offenders.push(`${rel}: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is read by every entry point that admits a member server URL', () => {
    const missing = ENTRY_POINTS.filter((rel) => !/\bisMemberServerUrl\(/.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(missing).toEqual([]);
  });

  it('admits only files that still exist and still check a scheme', () => {
    for (const rel of Object.keys(ADMITTED)) expect({ rel, checks: protocolChecks(readFileSync(join(SRC, rel), 'utf8')).length > 0 }).toEqual({ rel, checks: true });
  });
});
