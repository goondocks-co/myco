/**
 * What a person types, and what comes back.
 *
 * Two properties beyond the flags. The verb RETURNS its outcome and never
 * stamps the process it runs in, so it can be called twice in one process and
 * the dispatcher stays the one thing that knows an invocation is the whole
 * purpose. And `--dry-run` reports without writing, which is the only way to
 * ask "what would this bring?" of a machine whose archive you have not seen.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { IMPORT_HELP, parseArgs, reportLines, run } from '@myco/cli/import.js';
import type { ImportReport } from '@myco/member/import.js';
import { SKIP_REASONS } from '@myco-server-worker/api/import.js';

const report = (over: Partial<ImportReport> = {}): ImportReport => ({
  projects: [{
    projectId: 'proj_1', root: '/w/repo',
    agents: [{ agent: 'claude-code', found: 7, imported: 3, trimmed: 0, skipped: { held: 4 } }],
  }],
  unbound: 0, unattributable: 0, active: 0, ...over,
});

describe('the import verb', () => {
  it('reads every flag its help advertises, and refuses the rest without echoing a value', () => {
    expect(parseArgs(['--days', '90', '--max', '10', '--agent', 'codex', '--project', 'proj_2', '--dry-run']).options)
      .toEqual({ windowDays: 90, maxPerAgent: 10, agent: 'codex', project: 'proj_2', dryRun: true });

    // Both directions, and one more. A help text free to disagree with its
    // parser drifts one way; a flag the parser accepts and the help never names
    // is undiscoverable; and a flag a REFUSAL tells someone to use, which no
    // parser accepts, is the worst of the three — it reads as advice and fails.
    // `--server` was exactly that until this gate existed.
    const accepted = (flag: string) => parseArgs([flag]).error !== `unknown option ${flag}`;
    const helpFlags = new Set([...IMPORT_HELP.matchAll(/--[a-z-]+/g)].map((m) => m[0]));
    for (const flag of helpFlags) expect({ flag, accepted: accepted(flag) }).toEqual({ flag, accepted: true });

    // Every flag the parser has a case for is named in the help.
    const parserSource = readFileSync(new URL('../../packages/myco/src/cli/import.ts', import.meta.url), 'utf8');
    const body = parserSource.slice(parserSource.indexOf('export function parseArgs'));
    for (const flag of new Set([...body.matchAll(/case '(--[a-z-]+)'/g)].map((m) => m[1]))) {
      expect({ flag, inHelp: helpFlags.has(flag) }).toEqual({ flag, inHelp: true });
    }

    // Every flag any refusal names is a flag that works. Read from both the
    // verb and the pass it drives, since either may tell someone what to type.
    const importSource = readFileSync(new URL('../../packages/myco/src/member/import.ts', import.meta.url), 'utf8');
    for (const source of [parserSource, importSource]) {
      for (const literal of source.matchAll(/`[^`]*`|'[^']*'/g)) {
        for (const flag of literal[0].matchAll(/--[a-z-]+/g)) {
          expect({ flag: flag[0], accepted: accepted(flag[0]) }).toEqual({ flag: flag[0], accepted: true });
        }
      }
    }

    expect(parseArgs(['--days', 'soon']).error).toBe('--days needs a whole number of at least 1');
    expect(parseArgs(['--days', '0']).error).toBe('--days needs a whole number of at least 1');
    // The value is never echoed: a mistyped flag must not print what followed it.
    const refusal = parseArgs(['--nope', 'super-secret-value']).error ?? '';
    expect(refusal.includes('super-secret-value')).toBe(false);
  });

  it('returns its outcome and leaves the exit status to the dispatcher', async () => {
    const before = process.exitCode;
    const lines: string[] = [];
    const ok = await run(['--help'], { stdout: (l) => lines.push(l) });
    expect({ ok, exitCode: process.exitCode }).toEqual({ ok: true, exitCode: before });
    expect(lines.join('\n')).toContain('myco import');

    const errors: string[] = [];
    const bad = await run(['--days', 'soon'], { stderr: (l) => errors.push(l) });
    // False, and still nothing stamped on the process.
    expect({ bad, exitCode: process.exitCode }).toEqual({ bad: false, exitCode: before });
    expect(errors[0]).toContain('--days needs a whole number');
  });

  it('reports found and imported per agent, which is what makes a small store visible', () => {
    expect(reportLines(report(), false)).toEqual([
      'proj_1 (/w/repo)',
      '  claude-code: 7 found, 3 imported (4 already here)',
    ]);
    expect(reportLines(report(), true)[1]).toContain('would import');
    expect(reportLines({ projects: [], unbound: 0, unattributable: 0 }, false)).toEqual(['Nothing to import.']);
  });

  it('names what it left alone rather than passing over it in silence', () => {
    const lines = reportLines(report({ unattributable: 2, unbound: 3, narrowed: ['proj_2'] }), false);
    expect(lines.some((l) => l.includes('2 transcripts name no project'))).toBe(true);
    expect(lines.some((l) => l.includes('3 transcripts belong to projects this Deployment does not hold'))).toBe(true);
    expect(lines.some((l) => l.includes('Skipped by --project: proj_2'))).toBe(true);
  });

  it('says which transcripts it left to the agent still writing them', () => {
    const lines = reportLines(report({ active: 2 }), false);
    expect(lines.some((l) => l.includes('2 transcripts are still being written and were left to the agent writing them'))).toBe(true);
  });

  it('says when the offer limit cut the tail, so a partial import does not read as a complete one', () => {
    const trimmed = report({ projects: [{ projectId: 'proj_1', root: '/w/repo',
      agents: [{ agent: 'claude-code', found: 1573, imported: 1000, trimmed: 573, skipped: {} }] }] });
    expect(reportLines(trimmed, false)[1]).toBe('  claude-code: 1573 found, 1000 imported (573 past the offer limit)');
  });

  it('tells a person what happened to their history, never the name of the rule that fired', () => {
    // Enumerated from the Deployment's own list, so a reason added there is
    // covered here without an edit — and a reason added there with no words
    // fails this rather than reaching a screen as jargon.
    const reasons: readonly string[] = SKIP_REASONS;
    const skipped = Object.fromEntries(reasons.map((r) => [r, 1]));
    const lines = reportLines(report({ projects: [{ projectId: 'proj_1', root: '/w/repo',
      agents: [{ agent: 'claude-code', found: 9, imported: 2, trimmed: 0, skipped }] }] }), false).join('\n');
    for (const reason of reasons) {
      expect({ reason, leaked: new RegExp(`\\b${reason}\\b`).test(lines) }).toEqual({ reason, leaked: false });
    }
    // And it still says how many, per reason: plain words, not fewer facts.
    expect(lines).toContain('1 already here under another name');

    for (const stop of ['parked', 'unauthorized', 'route_missing', 'protocol', 'retry']) {
      const stopped = reportLines(report({ projects: [{ projectId: 'proj_1', root: '/w/repo', agents: [], endedBy: stop }] }), false).join('\n');
      expect({ stop, leaked: new RegExp(`\\b${stop}\\b`).test(stopped) }).toEqual({ stop, leaked: false });
      expect(stopped).toContain('stopped — ');
    }
  });
});

describe('the join paths', () => {
  it('names the Deployment it just joined rather than letting the import choose', async () => {
    // A machine may hold several memberships, and the registry answers them in
    // the order its filenames hash. The join paths know which Deployment they
    // joined; passing it is what stops the join-time pass importing into
    // another one — or, when that one holds no bindings, into nothing at all.
    const login = readFileSync(new URL('../../packages/myco/src/cli/login.ts', import.meta.url), 'utf8');
    const member = readFileSync(new URL('../../packages/myco/src/cli/member.ts', import.meta.url), 'utf8');
    for (const [name, source] of [['login', login], ['member join', member]] as const) {
      const call = /runImport\(\{([^}]*)\}/.exec(source)?.[1] ?? '';
      expect({ verb: name, namesDeployment: call.includes('serverUrl') }).toEqual({ verb: name, namesDeployment: true });
    }
  });

  it('skips the import when an invite named no project, and never fails the sign-in', () => {
    const login = readFileSync(new URL('../../packages/myco/src/cli/login.ts', import.meta.url), 'utf8');
    // Guarded by the same `root !== undefined` the project binding is: an
    // invite that names no Project leaves nothing to import into.
    expect(/if \(root !== undefined\) \{\s*\n\s*const report = await runImport/.test(login)).toBe(true);
    // And a failed import is caught, so the machine stays signed in.
    expect(/runImport\([^)]*\)[\s\S]{0,220}?\.catch\(\(\) => null\)/.test(login)).toBe(true);
  });
});
