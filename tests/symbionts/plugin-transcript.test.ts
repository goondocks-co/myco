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
      'readFileSync', 'appendFileSync', 'mkdirSync', 'statSync', 'lstatSync', 'accessSync', 'openSync', 'closeSync',
      'fsConstants', 'join', 'dirname', 'resolve', 'homedir', 'execFileSync', 'process',
      `${js}; return transcriptPathFor;`,
    )(
      fs.readFileSync, fs.appendFileSync, fs.mkdirSync, fs.statSync, fs.lstatSync, fs.accessSync, fs.openSync, fs.closeSync,
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
  it('resolves every declared cwd path out of the bytes each agent really writes', async () => {
    // Attribution opens the file and reads a bounded head — 64 KiB, then its
    // first 40 lines — taking the first line where the declared dot path hits.
    // The bytes here are not composed by this test: for the two agents whose
    // plugin writes a transcript, the shipped plugin's own session record is
    // produced by running its template; for Pi they are the fixture its parser
    // is proven on. Renaming the record's `cwd` key fires this.
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

    for (const agent of NATIVE_PLUGIN_AGENTS) {
      const discovery = manifestTranscriptDiscovery(agent)!;
      const dotPath = discovery.transcriptCwdPath;
      expect({ agent, declared: dotPath !== undefined }).toEqual({ agent, declared: true });

      let file: string;
      if (discovery.retention === 'member') {
        // Run the shipped plugin's session-open path and read what it wrote.
        const env = sandboxEnv();
        const mod = snippetModule(env);
        const source = fs.readFileSync(path.join(TEMPLATES, agent, 'plugin.ts'), 'utf-8');
        const record = source.slice(source.indexOf('type: "session"'));
        const fields = record.slice(0, record.indexOf('});'));
        // The record the template composes, evaluated rather than restated.
        const built = new Function('sessionId', 'AGENT', 'directory', 'nowIso',
          `return { ${fields.replace(/\bsessionId,/, 'sessionId,').replace(/\bagent: AGENT,/, 'agent: AGENT,')} };`,
        )('s', agent, '/repo', () => 'now') as Record<string, unknown>;
        expect({ agent, claimed: mod.holdsSessionClaim('/repo', agent, 's') }).toEqual({ agent, claimed: true });
        mod.appendTranscriptLine('/repo', agent, 's', built);
        file = mod.transcriptPathFor('/repo', agent, 's');
      } else {
        file = path.resolve(import.meta.dirname ?? __dirname, '../fixtures/pi-parse-basic.jsonl');
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

/**
 * The shipped snippet's own functions, transpiled and run.
 *
 * Every gate below drives real plugin code rather than a restatement of it:
 * a rename or a changed rule inside the snippet moves what these observe.
 */
function snippetModule(
  env: NodeJS.ProcessEnv,
  spawns: { env?: NodeJS.ProcessEnv; args: string[] }[] = [],
  noted: string[] = [],
  execImpl?: (bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => string,
) {
  const snippet = fs.readFileSync(path.join(TEMPLATES, '_shared', 'plugin-helpers.ts.snippet'), 'utf-8');
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(snippet.split('{{mycoCredentialSource}}').join('registry'));
  return new Function(
    'readFileSync', 'appendFileSync', 'mkdirSync', 'statSync', 'lstatSync', 'accessSync', 'openSync', 'closeSync',
    'writeSync', 'unlinkSync', 'fsConstants', 'join', 'dirname', 'resolve', 'homedir', 'execFileSync', 'process',
    `${js}; return { transcriptPathFor, appendTranscriptLine, holdsSessionClaim, runMycoHook };`,
  )(
    fs.readFileSync, fs.appendFileSync, fs.mkdirSync, fs.statSync, fs.lstatSync, fs.accessSync, fs.openSync, fs.closeSync,
    fs.writeSync, fs.unlinkSync, fs.constants, path.join, path.dirname, path.resolve, () => env.HOME,
    execImpl ?? ((_bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => { spawns.push({ env: opts?.env, args }); return '{}'; }),
    { ...process, env, platform: process.platform, stderr: { write: (line: string) => { noted.push(String(line)); return true; } } },
  ) as {
    transcriptPathFor: (d: string, a: string, s: string) => string;
    appendTranscriptLine: (d: string, a: string, s: string, r: Record<string, unknown>) => void;
    holdsSessionClaim: (d: string, a: string, s: string) => boolean;
    runMycoHook: (d: string, a: string, s: string, v: string, p: Record<string, unknown>) => unknown;
    CLAIM_STALE_MS: number;
  };
}

/** A member home of its own, so one gate's claims and transcripts never reach another's. */
function sandboxEnv(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-gate-'));
  return { HOME: home, MYCO_HOME: path.join(home, '.myco') } as NodeJS.ProcessEnv;
}

describe('one instance speaks for a session', () => {
  it('lets only the first live instance write, so two installs do not double every turn', () => {
    const env = sandboxEnv();
    const first = snippetModule(env);
    const second = snippetModule(env);
    // Asserted before the file is read: a claim that could not be taken would
    // otherwise surface as a missing transcript, which reads like the write
    // path failing rather than the claim.
    expect({ first: first.holdsSessionClaim('/repo', 'opencode', 'ses_1'), second: second.holdsSessionClaim('/repo', 'opencode', 'ses_1') })
      .toEqual({ first: true, second: false });
    for (const mod of [first, second]) {
      mod.appendTranscriptLine('/repo', 'opencode', 'ses_1', { type: 'prompt', text: 'x' });
      mod.appendTranscriptLine('/repo', 'opencode', 'ses_1', { type: 'response', text: 'y' });
    }
    const written = fs.readFileSync(first.transcriptPathFor('/repo', 'opencode', 'ses_1'), 'utf-8')
      .split('\n').filter(Boolean).length;
    expect(written).toBe(2);
  });

  it('lets a resumed session write, because the claim names a live writer and not a file', () => {
    const env = sandboxEnv();
    const first = snippetModule(env);
    first.appendTranscriptLine('/repo', 'opencode', 'ses_2', { type: 'prompt', text: 'x' });

    // The runtime that held the session is gone; its claim names a dead pid.
    const claim = path.join(env.MYCO_HOME!, 'member', 'claims', 'opencode-ses_2.lock');
    fs.writeFileSync(claim, `gone-instance ${Date.now() - 60 * 60 * 1000}`);

    const resumed = snippetModule(env);
    expect(resumed.holdsSessionClaim('/repo', 'opencode', 'ses_2')).toBe(true);
    resumed.appendTranscriptLine('/repo', 'opencode', 'ses_2', { type: 'prompt', text: 'z' });
    const written = fs.readFileSync(first.transcriptPathFor('/repo', 'opencode', 'ses_2'), 'utf-8')
      .split('\n').filter(Boolean).length;
    expect(written).toBe(2);
  });

  it('takes over a session whose claim went stale, whatever pid it names', () => {
    // A pid recycled onto an unrelated live process would otherwise hold a
    // session nobody is writing, and that session would capture nothing for
    // its whole life. The claim records when it was last written, so liveness
    // is "still writing" rather than "a pid answers".
    const env = sandboxEnv();
    const mod = snippetModule(env);
    const claim = path.join(env.MYCO_HOME!, 'member', 'claims', 'opencode-ses_stale.lock');
    fs.mkdirSync(path.dirname(claim), { recursive: true });
    // This process is live and is not the holder: exactly the recycled-pid case.
    fs.writeFileSync(claim, `other-instance ${Date.now() - mod.CLAIM_STALE_MS - 1000}`);

    expect(mod.holdsSessionClaim('/repo', 'opencode', 'ses_stale')).toBe(true);
    mod.appendTranscriptLine('/repo', 'opencode', 'ses_stale', { type: 'prompt', text: 'x' });
    expect(fs.readFileSync(mod.transcriptPathFor('/repo', 'opencode', 'ses_stale'), 'utf-8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('leaves a freshly touched claim alone, so a live writer is never displaced', () => {
    const env = sandboxEnv();
    const mod = snippetModule(env);
    const claim = path.join(env.MYCO_HOME!, 'member', 'claims', 'opencode-ses_fresh.lock');
    fs.mkdirSync(path.dirname(claim), { recursive: true });
    fs.writeFileSync(claim, `other-instance ${Date.now()}`);

    expect(mod.holdsSessionClaim('/repo', 'opencode', 'ses_fresh')).toBe(false);
    mod.appendTranscriptLine('/repo', 'opencode', 'ses_fresh', { type: 'prompt', text: 'x' });
    expect(fs.existsSync(mod.transcriptPathFor('/repo', 'opencode', 'ses_fresh'))).toBe(false);
  });

  it('stops writing when another instance has taken the session', () => {
    // The other half of a takeover: the instance that lost the session must
    // not keep appending beside the one that took it.
    const env = sandboxEnv();
    const first = snippetModule(env);
    expect(first.holdsSessionClaim('/repo', 'opencode', 'ses_lost')).toBe(true);
    first.appendTranscriptLine('/repo', 'opencode', 'ses_lost', { type: 'prompt', text: 'one' });

    const claim = path.join(env.MYCO_HOME!, 'member', 'claims', 'opencode-ses_lost.lock');
    fs.writeFileSync(claim, `other-instance ${Date.now()}`);

    first.appendTranscriptLine('/repo', 'opencode', 'ses_lost', { type: 'prompt', text: 'two' });
    expect(fs.readFileSync(first.transcriptPathFor('/repo', 'opencode', 'ses_lost'), 'utf-8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('runs no hook from an instance displaced while it was idle', () => {
    // The write path re-reads the claim; the hook path has to as well. An
    // instance that remembered holding the session would keep injecting after
    // another took it — and an agent that never appends, like Pi, reaches that
    // state on every session once its claim ages.
    const env = sandboxEnv();
    const firstSpawns: { args: string[] }[] = [];
    const secondSpawns: { args: string[] }[] = [];
    const first = snippetModule(env, firstSpawns);
    const second = snippetModule(env, secondSpawns);

    expect(first.runMycoHook('/repo', 'opencode', 'ses_idle', 'session-start', {})).not.toBeNull();

    // The holder falls idle long enough for its claim to age, and the other
    // instance takes the session through the real path.
    const claim = path.join(env.MYCO_HOME!, 'member', 'claims', 'opencode-ses_idle.lock');
    const [instance] = fs.readFileSync(claim, 'utf-8').split(/\s+/);
    fs.writeFileSync(claim, `${instance} ${Date.now() - first.CLAIM_STALE_MS - 1000}`);
    expect(second.holdsSessionClaim('/repo', 'opencode', 'ses_idle')).toBe(true);

    first.runMycoHook('/repo', 'opencode', 'ses_idle', 'user-prompt-submit', {});
    second.runMycoHook('/repo', 'opencode', 'ses_idle', 'user-prompt-submit', {});
    expect({ displaced: firstSpawns.length, holder: secondSpawns.length }).toEqual({ displaced: 1, holder: 1 });
  });

  it('says once per session when it cannot write, and once when it cannot run the hook', () => {
    // Capture that stops has to be findable on the machine where it stopped.
    const env = sandboxEnv();
    const noted: string[] = [];
    const mod = snippetModule(env, [], noted, () => { throw new Error('no binary'); });

    mod.runMycoHook('/repo', 'opencode', 'ses_note', 'session-start', {});
    mod.runMycoHook('/repo', 'opencode', 'ses_note', 'user-prompt-submit', {});
    const hookLines = noted.filter((l) => l.includes('myco hook'));
    expect(hookLines).toHaveLength(1);
    expect(hookLines[0]).toContain('opencode');
    expect(hookLines[0]).toContain('ses_note');
    // The verb too: two sessions failing on different hooks must not be
    // indistinguishable from one session failing twice.
    expect(hookLines[0]).toContain('session-start');

    // A write failure the claim does not mask: the claim is takeable and the
    // transcript directory is not, which is what a per-agent permission or a
    // file in the way looks like. Blocking the whole home instead would fail
    // the claim first and this line would never be reached — the earlier
    // version of this test asserted a count that zero satisfied, and zero was
    // what it got.
    const blocked = sandboxEnv();
    fs.mkdirSync(path.join(blocked.MYCO_HOME!, 'member'), { recursive: true });
    fs.writeFileSync(path.join(blocked.MYCO_HOME!, 'member', 'transcripts'), 'not a directory');
    const notedWrite: string[] = [];
    const blockedMod = snippetModule(blocked, [], notedWrite);
    expect(blockedMod.holdsSessionClaim('/repo', 'opencode', 'ses_blocked')).toBe(true);
    blockedMod.appendTranscriptLine('/repo', 'opencode', 'ses_blocked', { type: 'prompt' });
    blockedMod.appendTranscriptLine('/repo', 'opencode', 'ses_blocked', { type: 'response' });
    expect(notedWrite.filter((l) => l.includes('not captured'))).toHaveLength(1);
  });

  it('runs no hook from an instance that does not hold the session, so nothing injects twice', () => {
    const env = sandboxEnv();
    const firstSpawns: { args: string[] }[] = [];
    const secondSpawns: { args: string[] }[] = [];
    const first = snippetModule(env, firstSpawns);
    const second = snippetModule(env, secondSpawns);
    first.runMycoHook('/repo', 'opencode', 'ses_3', 'user-prompt-submit', {});
    second.runMycoHook('/repo', 'opencode', 'ses_3', 'user-prompt-submit', {});
    expect({ first: firstSpawns.length, second: secondSpawns.length }).toEqual({ first: 1, second: 0 });
  });

  it('tells the binary which home it resolved, so a pinned project keeps one', () => {
    // Both sides walk the pin, and the plugin names the home it chose on the
    // spawn anyway: the child then resolves from an environment rather than
    // from a cwd that a harness is free to move.
    const sandbox = sandboxEnv();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pinned-'));
    const pinnedHome = path.join(dir, 'dev-home');
    fs.mkdirSync(path.join(dir, '.myco'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.myco', 'runtime.home'), pinnedHome);
    fs.chmodSync(path.join(dir, '.myco', 'runtime.home'), 0o644);

    // A GUI-launched harness carries no MYCO_HOME: the project's pin decides.
    const pinned: { env?: NodeJS.ProcessEnv; args: string[] }[] = [];
    snippetModule({ HOME: sandbox.HOME } as NodeJS.ProcessEnv, pinned)
      .runMycoHook(dir, 'opencode', 'ses_4', 'session-start', {});
    expect(pinned).toHaveLength(1);
    expect(pinned[0].env?.MYCO_HOME).toBe(pinnedHome);

    // An explicit MYCO_HOME outranks the pin, in the plugin exactly as in the binary.
    const declared: { env?: NodeJS.ProcessEnv; args: string[] }[] = [];
    snippetModule(sandbox, declared).runMycoHook(dir, 'opencode', 'ses_5', 'session-start', {});
    expect(declared[0].env?.MYCO_HOME).toBe(sandbox.MYCO_HOME);
  });
});
