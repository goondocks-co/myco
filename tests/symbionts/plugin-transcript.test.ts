import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'bun:test';

import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';
import { expandRoot, manifestTranscriptDiscovery } from '@myco/symbionts/transcript-discovery.js';
import { memberOwnedTranscriptRoots } from '@myco/member/retention.js';
import { TOOL_DEFINITIONS } from '@myco/tools/definitions.js';

/**
 * The native plugins' transcript contract.
 *
 * Three agents run an in-process plugin rather than hook commands. Two of them
 * keep no append-only store of their own, so the plugin writes one and Myco
 * ages it; the third writes its own and Myco only reads it. Everything below
 * holds those two facts to the manifests rather than to the plugin source,
 * because a template and a manifest that disagree fail silently — the
 * transcript is written to one path and looked for at another.
 */

const TEMPLATES = path.resolve(
  import.meta.dirname ?? __dirname,
  '../../packages/myco/src/symbionts/templates',
);

/** The environment every path in these tests resolves against. */
const ENV = { HOME: '/tmp/myco-fixture-home', MYCO_HOME: '/tmp/myco-fixture-home/.myco' } as NodeJS.ProcessEnv;

const NATIVE_PLUGIN_AGENTS = ['cline', 'opencode', 'pi'] as const;

function pluginSource(agent: string): string {
  return fs.readFileSync(path.join(TEMPLATES, agent, 'plugin.ts'), 'utf-8');
}

describe('native plugin transcripts', () => {
  it('declares discovery for every agent whose plugin the installer writes', () => {
    const missing = NATIVE_PLUGIN_AGENTS.filter((agent) => manifestTranscriptDiscovery(agent) === undefined);
    expect(missing).toEqual([]);
  });

  /**
   * The path the plugin writes and the root discovery reads must be one
   * directory. They are derived from different places — the template composes
   * it, the manifest declares it — so nothing but a comparison catches a
   * divergence, and the symptom is a transcript that exists and is never found.
   */
  it('writes each plugin transcript where that agent\'s manifest says to look for it', async () => {
    // Both sides are resolved by running code, never by restating it: the
    // template's own `transcriptPathFor` is evaluated out of the shipped
    // snippet, and the manifest's root through the discovery resolver. A
    // rename inside the snippet moves one and not the other.
    const snippet = fs.readFileSync(path.join(TEMPLATES, '_shared', 'plugin-helpers.ts.snippet'), 'utf-8');
    const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(snippet);
    const composed = new Function(
      'readFileSync', 'appendFileSync', 'mkdirSync', 'statSync', 'accessSync', 'openSync', 'closeSync',
      'fsConstants', 'join', 'dirname', 'resolve', 'homedir', 'execFileSync', 'process',
      `${js}; return transcriptPathFor;`,
    )(
      fs.readFileSync, fs.appendFileSync, fs.mkdirSync, fs.statSync, fs.accessSync, fs.openSync, fs.closeSync,
      fs.constants, path.join, path.dirname, path.resolve, () => ENV.HOME, () => '',
      { ...process, env: ENV, platform: process.platform },
    ) as (d: string, a: string, s: string) => string;

    for (const agent of NATIVE_PLUGIN_AGENTS) {
      const discovery = manifestTranscriptDiscovery(agent)!;
      if (discovery.retention !== 'member') continue;
      const declared = expandRoot(discovery.roots[0], ENV);
      const written = path.dirname(composed('/repo', agent, 'sid'));
      expect({ agent, root: written }).toEqual({ agent, root: declared });
    }
  });

  /**
   * The pruner's safety boundary. A store any manifest declares `harness` is
   * the agent's own and holds the user's history; deleting one is not
   * recoverable. Today the pruner only looks in one directory, which is a
   * property held by construction rather than asserted — so it is asserted.
   */
  it('never prunes a store any manifest declares the harness owns', () => {
    const pruned = memberOwnedTranscriptRoots(ENV);
    const harnessOwned = BUNDLED_MANIFESTS
      .filter((m) => m.capture?.transcriptDiscovery && m.capture.transcriptDiscovery.retention !== 'member')
      .flatMap((m) => m.capture!.transcriptDiscovery!.roots.map((root) => expandRoot(root, ENV)));

    expect(harnessOwned.length).toBeGreaterThan(0);
    for (const root of harnessOwned) {
      for (const target of pruned) {
        expect({ root, insidePruned: root === target || root.startsWith(`${target}${path.sep}`) })
          .toEqual({ root, insidePruned: false });
      }
    }
  });

  it('prunes exactly the stores its own plugin writes', () => {
    expect(memberOwnedTranscriptRoots(ENV).sort()).toEqual([
      path.join(ENV.MYCO_HOME!, 'member', 'transcripts', 'cline'),
      path.join(ENV.MYCO_HOME!, 'member', 'transcripts', 'opencode'),
    ]);
  });

  it('keeps every member-written root clear of the member\'s own state', () => {
    // An over-broad root under the member home would ship the spool, the
    // refusal log or staged blob bytes as if they were transcript content, and
    // the server would parse them as real.
    const forbidden = ['spool', 'deployments', 'projects'].map((dir) => path.join(ENV.MYCO_HOME!, 'member', dir));
    for (const root of memberOwnedTranscriptRoots(ENV)) {
      for (const dir of forbidden) {
        expect({ root, collides: root === dir || root.startsWith(`${dir}${path.sep}`) }).toEqual({ root, collides: false });
      }
    }
  });

  /**
   * Attribution reads the working directory from a bounded head of the file —
   * 64 KiB, then its first 40 lines — and takes the first line where the
   * declared dot-path hits. A `session` record that stopped being written first
   * would make every transcript for these agents unattributable, and nothing
   * would announce it.
   */
  it('resolves every declared cwd path out of a real transcript head', async () => {
    // Attribution opens the file and reads a bounded head — 64 KiB, then its
    // first 40 lines — taking the first line where the declared dot path hits.
    // This runs that read against real bytes for each agent: the fixture the
    // parser is proven on for Pi, and a transcript the shipped plugin writes
    // for the two whose plugin writes one. A `session` record that stopped
    // being first would make every transcript for that agent unattributable
    // with nothing to show for it.
    const HEAD_BYTES = 64 * 1024;
    const MAX_HEADER_LINES = 40;
    const readCwd = (file: string, dotPath: string): unknown => {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(HEAD_BYTES);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      for (const line of buf.subarray(0, read).toString('utf8').split('\n').slice(0, MAX_HEADER_LINES)) {
        if (!line.trim()) continue;
        try {
          let held: unknown = JSON.parse(line);
          for (const seg of dotPath.split('.')) {
            if (held === null || typeof held !== 'object') { held = undefined; break; }
            held = (held as Record<string, unknown>)[seg];
          }
          if (held !== undefined) return held;
        } catch { /* a line that is not JSON is not the header */ }
      }
      return undefined;
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cwd-'));
    for (const agent of NATIVE_PLUGIN_AGENTS) {
      const discovery = manifestTranscriptDiscovery(agent)!;
      const dotPath = discovery.transcriptCwdPath;
      expect({ agent, declared: dotPath !== undefined }).toEqual({ agent, declared: true });

      const file = path.join(dir, `${agent}.jsonl`);
      if (discovery.retention === 'member') {
        // The bytes the shipped plugin writes for its first record.
        fs.writeFileSync(file, `${JSON.stringify({ v: 1, type: 'session', sessionId: 's', agent, cwd: '/repo', at: 'now' })}\n`);
      } else {
        fs.copyFileSync(path.resolve(import.meta.dirname ?? __dirname, '../fixtures/pi-parse-basic.jsonl'), file);
      }
      expect({ agent, cwd: readCwd(file, dotPath!) }).toEqual({ agent, cwd: expect.any(String) });
    }
  });

});

describe('pi tool registration', () => {
  const source = pluginSource('pi');

  /**
   * Pi has no MCP, so its tools are registered natively. They are enumerated
   * from the binary rather than declared here: a schema written in the template
   * is a third copy the server/member parity gate cannot see, and since #1183
   * the Deployment refuses an argument its schema does not declare — so a
   * drifted copy fails at call time, by name.
   */
  it('enumerates tools from the binary instead of declaring them', () => {
    expect(source).toContain('"tool", "list", "--json"');
    expect(source).toContain('pi.registerTool(');
  });

  it('spells no served tool name, so no schema can drift from the catalogue', () => {
    // Names come from the member's own catalogue, never spelled here.
    const named = TOOL_DEFINITIONS.map((tool) => tool.name).filter((name) => source.includes(name));
    expect(named).toEqual([]);
  });
});
