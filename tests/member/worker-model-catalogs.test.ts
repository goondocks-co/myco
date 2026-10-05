/**
 * How a worker lists its harnesses' models, and when it reports them.
 *
 * A listing is started as a run is, through its driver's launch, and stopped as a process group, so it leaves no
 * helper, home or temp file behind.
 *
 * One path lists every harness from its manifest's declaration, so the cases here are the two declaration kinds run
 * against real processes: a command whose output is one id per line, and an exchange of JSON lines whose answer holds
 * the list. A listing that never answers is stopped, and leaves no process behind. The reporter sends what was listed
 * one harness at a time, keeps a report the Deployment could not be reached for, and never holds up its caller.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "../support/fenced-fs.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_CATALOG_REFRESH_MS, PROFILE_HARNESSES, type ModelCatalog } from '@goondocks/myco-shared/execution-profile';
import { HARNESSES, type ModelListing } from '@myco/runner/harnesses.js';
import { listHarnessModels, MAX_LISTING_PAGES, runListing, valuesAt, type HarnessListing } from '@myco/runner/models.js';
import { startHarness } from '@myco/runner/drivers/stream.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';
import { modelCatalogs } from '@myco/runner/catalogs.js';
import type { WorkerAnswer } from '@myco/runner/loop.js';

const signal = (): AbortSignal => new AbortController().signal;
/** A process that writes `script`'s output, run by this test's own JavaScript runtime. */
const node = (script: string): { binary: string; args: string[] } => ({ binary: process.execPath, args: ['-e', script] });

describe('reading a listing', () => {
  it('reads every value at a dotted path, through each entry of a list marked []', () => {
    const answer = { result: { data: [{ id: 'a', efforts: [{ effort: 'low' }, { effort: 'high' }] }, { id: 'b' }] } };
    expect(valuesAt(answer, 'result.data[].id')).toEqual(['a', 'b']);
    expect(valuesAt(answer, 'result.data[].efforts[].effort')).toEqual(['low', 'high']);
    expect(valuesAt(answer, 'result.missing.id')).toEqual([]);
  });

  it('takes one id per line of a command, naming each one\'s provider by its first segment', async () => {
    const { binary, args } = node(`process.stdout.write('openrouter/~anthropic/claude-opus-latest\\nopenai/gpt-6\\n\\nbare-model\\n')`);
    const listing: ModelListing = { kind: 'command', args, format: 'lines', provider: 'id-prefix' };
    expect(await runListing(binary, listing, { cwd: tmpdir(), env: process.env, signal: signal() })).toEqual([
      { id: 'openrouter/~anthropic/claude-opus-latest', provider: 'openrouter' },
      { id: 'openai/gpt-6', provider: 'openai' },
      { id: 'bare-model' },
    ]);
  });

  it('answers an exchange from the first line holding every value its answer names, read through the declared fields', async () => {
    const script = `
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        process.stdout.write('not json\\n');
        process.stdout.write(JSON.stringify({ id: message.id, result: message.id === 2
          ? { data: [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
                     { id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: false, upgrade: 'gpt-6-sol' }] }
          : {} }) + '\\n');
      });`;
    const { binary, args } = node(script);
    const listing: ModelListing = {
      kind: 'exchange', args,
      send: [{ id: 1, method: 'initialize' }, { method: 'initialized' }, { id: 2, method: 'model/list' }],
      answer: { where: { id: 2 }, list: 'result.data' },
      fields: { id: 'id', label: 'displayName', isDefault: 'isDefault', upgrade: 'upgrade', efforts: 'supportedReasoningEfforts[].reasoningEffort' },
    };
    expect(await runListing(binary, listing, { cwd: tmpdir(), env: process.env, signal: signal() })).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', isDefault: true, resolvesTo: undefined, upgrade: undefined, efforts: ['low', 'high'] },
      { id: 'gpt-5.5', label: 'GPT-5.5', isDefault: false, resolvesTo: undefined, upgrade: 'gpt-6-sol', efforts: [] },
    ]);
  });

  it('stops a listing that never answers, leaving no process behind, and says why', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-listing-'));
    try {
      const pidFile = join(dir, 'pid');
      const { binary, args } = node(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
      const listing: ModelListing = { kind: 'exchange', args, send: [{ id: 1 }], answer: { where: { id: 1 }, list: 'result' }, fields: { id: 'id' } };
      await expect(runListing(binary, listing, { cwd: dir, env: process.env, signal: signal(), timeoutMs: 500 })).rejects.toThrow('it did not answer within 0.5s');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await Bun.sleep(100);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says how a command that fails ended, with what it said', async () => {
    const { binary, args } = node(`console.error('not logged in'); process.exit(3)`);
    await expect(runListing(binary, { kind: 'command', args, format: 'lines' }, { cwd: tmpdir(), env: process.env, signal: signal() })).rejects.toThrow('it exited 3 without listing models: not logged in');
  });
});

describe('the listings the manifests declare', () => {
  it('declare one for every harness whose model Settings sets, and none for one whose model a run cannot set', () => {
    for (const harness of HARNESSES) {
      expect({ harness: harness.id, lists: harness.models !== undefined })
        .toEqual({ harness: harness.id, lists: harness.profile.model !== 'none' });
    }
  });

  it('offer only presets whose every model the harness\'s settings accept, under the preset\'s provider', () => {
    const presets = Object.entries(PROFILE_HARNESSES).flatMap(([harness, spec]) => (spec.presets ?? []).map((preset) => ({ harness, preset })));
    expect(presets.map(({ harness, preset }) => `${harness}:${preset.id}`)).toEqual(['opencode:openrouter-claude-latest']);
    for (const { harness, preset } of presets) {
      for (const model of Object.values(preset.models)) {
        expect({ model, accepted: new RegExp(PROFILE_HARNESSES[harness]!.modelPattern).test(model), provider: model.startsWith(`${preset.provider}/`) })
          .toEqual({ model, accepted: true, provider: true });
      }
    }
  });
});

describe('reporting what was listed', () => {
  const catalog = (harness: string): ModelCatalog => ({ harness, source: { kind: 'command', command: harness }, signIn: 'worker-login', fetchedAt: 1, models: [{ id: `${harness}/m`, label: `${harness}/m` }] });
  const ANSWERED: WorkerAnswer = { kind: 'answered', body: { persisted: true, recorded: true }, accounting: true, executionProfile: true, profileOutcome: true, modelCatalog: true, steps: true };
  const settle = () => Bun.sleep(5);

  it('waits for a stopped listing to dispose before shutdown settles', async () => {
    let disposed = false;
    const reporter = modelCatalogs({
      harnesses: ['codex'], clock: () => 1, log: () => {},
      list: (_ids, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => { disposed = true; resolve([]); }, 20);
        }, { once: true });
      }),
      send: async () => ANSWERED,
    });
    reporter.due();
    await reporter.stop();
    expect(disposed).toBe(true);
  });

  it('aborts an obsolete listing and never publishes its late result after the ready set changes', async () => {
    let completeOld: (value: HarnessListing[]) => void = () => {};
    let oldSignal: AbortSignal | undefined;
    const sent: string[] = [];
    const reporter = modelCatalogs({
      harnesses: ['codex'], clock: () => 1, log: () => {},
      list: (ids, signal) => {
        if (ids.includes('codex')) {
          oldSignal = signal;
          return new Promise((resolve) => { completeOld = resolve; });
        }
        return Promise.resolve([{ ok: true, catalog: catalog('opencode') }]);
      },
      send: async (value) => { sent.push(value.harness); return ANSWERED; },
    });
    try {
      reporter.due();
      reporter.reconcile(['opencode']);
      expect(oldSignal?.aborted).toBe(true);
      reporter.due();
      await settle();
      completeOld([{ ok: true, catalog: catalog('codex') }]);
      await settle();
      reporter.due();
      await settle();
      expect(sent).toEqual(['opencode']);
    } finally { reporter.stop(); }
  });

  function rig(answers: WorkerAnswer[], listed: HarnessListing[] = [{ ok: true, catalog: catalog('codex') }, { ok: true, catalog: catalog('opencode') }]) {
    let now = 0;
    const sent: string[] = [];
    const lines: string[] = [];
    let listings = 0;
    const reporter = modelCatalogs({
      harnesses: ['codex', 'opencode'],
      list: async () => { listings += 1; return listed; },
      send: async (c) => { sent.push(c.harness); return answers.shift() ?? ANSWERED; },
      log: (line) => lines.push(line),
      clock: () => now,
    });
    return { reporter, sent, lines, listings: () => listings, advance: (ms: number) => { now += ms; } };
  }

  it('lists once, then sends each harness\'s catalog on its own pass, and lists again only once the refresh is due', async () => {
    const r = rig([]);
    r.reporter.due(); await settle();
    expect({ listings: r.listings(), sent: r.sent }).toEqual({ listings: 1, sent: [] });
    r.reporter.due(); await settle();
    r.reporter.due(); await settle();
    r.reporter.due(); await settle();
    expect({ listings: r.listings(), sent: r.sent }).toEqual({ listings: 1, sent: ['codex', 'opencode'] });
    r.advance(MODEL_CATALOG_REFRESH_MS - 1);
    r.reporter.due(); await settle();
    expect(r.listings()).toBe(1);
    r.advance(1);
    r.reporter.due(); await settle();
    expect(r.listings()).toBe(2);
  });

  it('sends again a report the Deployment could not be reached for, and drops one it refused, saying so', async () => {
    const r = rig([
      { kind: 'unreachable', detail: 'offline' },
      { kind: 'refused', code: 'not_admin', detail: '' },
    ]);
    r.reporter.due(); await settle();
    for (let pass = 0; pass < 4; pass += 1) { r.reporter.due(); await settle(); }
    expect(r.sent).toEqual(['codex', 'codex', 'opencode']);
    expect(r.lines).toEqual(['the Deployment refused the models codex offers: not_admin']);
  });

  it('says once why a harness could not list, and reports those that did', async () => {
    const r = rig([], [{ ok: false, harness: 'codex', reason: 'it exited 1 without listing models' }, { ok: true, catalog: catalog('opencode') }]);
    r.reporter.due(); await settle();
    r.reporter.due(); await settle();
    r.advance(MODEL_CATALOG_REFRESH_MS);
    r.reporter.due(); await settle();
    expect(r.sent).toEqual(['opencode']);
    expect(r.lines).toEqual(['could not list the models codex offers: it exited 1 without listing models']);
  });

  it('holds up no caller: due answers before a listing or a report does', () => {
    const reporter = modelCatalogs({
      harnesses: ['codex'], list: () => new Promise(() => {}), send: () => new Promise(() => {}), log: () => {}, clock: () => 0,
    });
    const started = performance.now();
    reporter.due();
    reporter.due();
    expect(performance.now() - started).toBeLessThan(50);
    reporter.stop();
  });
});

/** Whether process `pid` is alive. */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
/** A pid a process wrote, once it has. */
async function pidIn(file: string): Promise<number> {
  for (let i = 0; i < 100 && !existsSync(file); i += 1) await Bun.sleep(20);
  return Number(readFileSync(file, 'utf8'));
}

describe('a listing leaves nothing behind', () => {
  it('stops a helper its harness left running, though the harness itself exited after listing', async () => {
    const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-listing-group-')));
    const helper = join(dir, 'helper.pid');
    const { binary, args } = node(`
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(helper)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: 'ignore' });
      setTimeout(() => { process.stdout.write('openai/gpt-6\\n'); process.exit(0); }, 200);`);
    expect(await runListing(binary, { kind: 'command', args, format: 'lines' }, { cwd: dir, env: process.env, signal: signal() })).toEqual([{ id: 'openai/gpt-6' }]);
    expect(alive(await pidIn(helper))).toBe(false);
  });

  it('kills a harness that ignores SIGTERM once the grace has passed', async () => {
    const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-listing-term-')));
    const pidFile = join(dir, 'pid');
    const { binary, args } = node(`process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const listing: ModelListing = { kind: 'exchange', args, send: [{ id: 1 }], answer: { where: { id: 1 }, list: 'result' }, fields: { id: 'id' } };
    await expect(runListing(binary, listing, { cwd: dir, env: process.env, signal: signal(), timeoutMs: 300 })).rejects.toThrow('it did not answer within 0.3s');
    expect(alive(await pidIn(pidFile))).toBe(false);
  });

  it('stops a run harness\'s helpers with it when the run is stopped', async () => {
    const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-run-group-')));
    const helper = join(dir, 'helper.pid');
    const stopping = new AbortController();
    const { binary, args } = node(`
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(helper)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: 'inherit' });
      setInterval(() => {}, 1000);`);
    const started = startHarness(binary, args, { cwd: dir, env: {}, signal: stopping.signal });
    const helperPid = await pidIn(helper);
    stopping.abort();
    await started.exit;
    for (let i = 0; i < 100 && alive(helperPid); i += 1) await Bun.sleep(20);
    expect(alive(helperPid)).toBe(false);
  });
});

describe('a listing starts its harness as a run on the machine\'s own login starts it', () => {
  /** Stubs on PATH for `binaries`, a home of the test's own, and these variables set, for the length of `body`. */
  async function onStubs(binaries: Record<string, string>, set: Record<string, string>, body: (dir: string) => Promise<void>): Promise<void> {
    const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-listing-env-')));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const [name, script] of Object.entries(binaries)) writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const saved = Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', ...Object.keys(set)].map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
    process.env.HOME = join(dir, 'home');
    process.env.CODEX_HOME = join(dir, 'home', '.codex');
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'home', '.claude');
    mkdirSync(join(dir, 'home', '.codex'), { recursive: true });
    writeFileSync(join(dir, 'home', '.codex', 'auth.json'), '{"tokens":{"fixture":true}}');
    Object.assign(process.env, set);
    try { await body(dir); } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }
  const OPERATOR_OVERRIDES = { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_DEFAULT_OPUS_MODEL: 'operator-opus', ANTHROPIC_MODEL: 'operator-model', ANTHROPIC_BASE_URL: 'https://operator.example' };

  it('without the variables a Claude Code run never inherits, its user settings, or a session kept of the listing', async () => {
    await onStubs({
      claude: `env > "$(dirname "$0")/../claude-env"\nprintf '%s\\n' "$@" > "$(dirname "$0")/../claude-args"\nIFS= read -r line\nprintf '%s\\n' '{"type":"control_response","response":{"request_id":"myco-models","response":{"models":[{"value":"sonnet","displayName":"Sonnet"}]}}}'`,
    }, OPERATOR_OVERRIDES, async (dir) => {
      const listed = await listHarnessModels('claude-code', join(dir, 'runs'), signal());
      expect(listed).toMatchObject({ ok: true, catalog: { signIn: 'worker-login', models: [{ id: 'sonnet' }] } });
      const env = readFileSync(join(dir, 'claude-env'), 'utf8');
      for (const key of Object.keys(OPERATOR_OVERRIDES)) expect({ key, inherited: env.includes(`${key}=`) }).toEqual({ key, inherited: false });
      const args = readFileSync(join(dir, 'claude-args'), 'utf8').trim().split('\n');
      expect(args).toContain('--no-session-persistence');
      expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', 'project,local']);
    });
  });

  it('in a Codex home of its own that holds the machine\'s login, and leaves no home, temp file or helper behind', async () => {
    await onStubs({
      codex: [
        'printf \'%s\\n\' "$CODEX_HOME" > "$(dirname "$0")/../codex-home"',
        'ls "$CODEX_HOME" > "$(dirname "$0")/../codex-home-files"',
        'mkdir -p "$CODEX_HOME/.tmp/git-fetch" && touch "$CODEX_HOME/.tmp/git-fetch/pack"',
        'sleep 30 &',
        'printf \'%s\\n\' "$!" > "$(dirname "$0")/../helper.pid"',
        'while IFS= read -r line; do',
        '  case "$line" in',
        '    *\'"cursor":"p2"\'*) printf \'%s\\n\' \'{"id":2,"result":{"data":[{"id":"gpt-6-luna","displayName":"GPT-6-Luna"}],"nextCursor":null}}\' ;;',
        '    *\'"id":2\'*) printf \'%s\\n\' \'{"id":2,"result":{"data":[{"id":"gpt-6.1-sol","displayName":"GPT-6.1-Sol","isDefault":true}],"nextCursor":"p2"}}\' ;;',
        '  esac',
        'done',
      ].join('\n'),
    }, {}, async (dir) => {
      const root = join(dir, 'runs');
      const listed = await listHarnessModels('codex', root, signal());
      expect(listed).toMatchObject({ ok: true, catalog: { models: [{ id: 'gpt-6.1-sol', isDefault: true }, { id: 'gpt-6-luna' }] } });
      const home = readFileSync(join(dir, 'codex-home'), 'utf8').trim();
      expect(home.startsWith(`${root}/`)).toBe(true);
      expect(readFileSync(join(dir, 'codex-home-files'), 'utf8').split('\n').filter(Boolean).sort()).toEqual(['auth.json', 'config.toml']);
      expect(readdirSync(root)).toEqual([]);
      expect(existsSync(join(dir, 'home', '.codex', '.tmp'))).toBe(false);
      expect(alive(await pidIn(join(dir, 'helper.pid')))).toBe(false);
    });
  });

  it('under the run agent an OpenCode run asks under, with its extensions off', async () => {
    await onStubs({ opencode: 'env > "$(dirname "$0")/../opencode-env"\nprintf \'%s\\n\' openrouter/~anthropic/claude-opus-latest' }, {}, async (dir) => {
      expect(await listHarnessModels('opencode', join(dir, 'runs'), signal())).toMatchObject({ ok: true, catalog: { models: [{ id: 'openrouter/~anthropic/claude-opus-latest', provider: 'openrouter' }] } });
      const env = readFileSync(join(dir, 'opencode-env'), 'utf8');
      expect(env).toContain('OPENCODE_PURE=1');
      expect(env).toMatch(/^OPENCODE_CONFIG_CONTENT=.*"default_agent":"myco-run-/m);
    });
  });

  it('reads a Codex list no further than its page bound', async () => {
    await onStubs({
      codex: 'n=0\nwhile IFS= read -r line; do case "$line" in *\'"id":2\'*) n=$((n+1)); printf \'{"id":2,"result":{"data":[{"id":"gpt-page-%s","displayName":"page"}],"nextCursor":"next"}}\\n\' "$n" ;; esac; done',
    }, {}, async (dir) => {
      const listed = await listHarnessModels('codex', join(dir, 'runs'), signal());
      expect(listed?.ok === true ? listed.catalog.models.length : listed).toBe(MAX_LISTING_PAGES);
    });
  });
});
