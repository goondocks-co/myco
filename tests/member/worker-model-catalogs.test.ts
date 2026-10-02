/**
 * How a worker lists its harnesses' models, and when it reports them.
 *
 * One path lists every harness from its manifest's declaration, so the cases here are the two declaration kinds run
 * against real processes: a command whose output is one id per line, and an exchange of JSON lines whose answer holds
 * the list. A listing that never answers is stopped, and leaves no process behind. The reporter sends what was listed
 * one harness at a time, keeps a report the Deployment could not be reached for, and never holds up its caller.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_CATALOG_REFRESH_MS, PROFILE_HARNESSES, type ModelCatalog } from '@goondocks/myco-shared/execution-profile';
import { HARNESSES, type ModelListing } from '@myco/runner/harnesses.js';
import { runListing, valuesAt, type HarnessListing } from '@myco/runner/models.js';
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
    expect(await runListing(binary, listing, { cwd: tmpdir(), signal: signal() })).toEqual([
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
    expect(await runListing(binary, listing, { cwd: tmpdir(), signal: signal() })).toEqual([
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
      await expect(runListing(binary, listing, { cwd: dir, signal: signal(), timeoutMs: 500 })).rejects.toThrow('it did not answer within 0.5s');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await Bun.sleep(100);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says how a command that fails ended, with what it said', async () => {
    const { binary, args } = node(`console.error('not logged in'); process.exit(3)`);
    await expect(runListing(binary, { kind: 'command', args, format: 'lines' }, { cwd: tmpdir(), signal: signal() })).rejects.toThrow('it exited 3 without listing models: not logged in');
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
  const catalog = (harness: string): ModelCatalog => ({ harness, source: { kind: 'command', command: harness }, fetchedAt: 1, models: [{ id: `${harness}/m`, label: `${harness}/m` }] });
  const ANSWERED: WorkerAnswer = { kind: 'answered', body: { persisted: true, recorded: true }, accounting: true, executionProfile: true, profileOutcome: true, modelCatalog: true };
  const settle = () => Bun.sleep(5);

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
