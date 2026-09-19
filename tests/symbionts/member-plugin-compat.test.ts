/**
 * The 1.4 OpenCode plugin and Pi extension step aside for a project that
 * carries a Myco 2.0 member plugin, so one session is captured once: OpenCode
 * loads every `.opencode/plugins/` from the launch directory up to the
 * worktree, and Pi loads a trusted project's member extension first, which
 * marks itself active once registered.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { MycoPlugin } from '@myco/symbionts/templates/opencode/plugin.ts';

const MEMBER_LINE = '// myco:' + 'member-plugin — a global Myco plugin steps aside for a project that carries this line.\n';
const templatePath = (agent: string): string => path.resolve(import.meta.dirname ?? __dirname, `../../packages/myco/src/symbionts/templates/${agent}/plugin.ts`);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-compat-')));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true });
  return root;
}

function plugin(dir: string, content: string): void {
  fs.mkdirSync(path.join(dir, '.opencode', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.opencode', 'plugins', 'myco.ts'), content);
}

const client = () => ({ app: { log: vi.fn(async () => undefined) }, session: { messages: vi.fn(async () => ({ data: [] })) } });

describe('1.4 plugins step aside for a Myco 2.0 member plugin', () => {
  it('both templates declare the step-aside line and neither carries the member line itself', () => {
    for (const agent of ['opencode', 'pi']) {
      const source = fs.readFileSync(templatePath(agent), 'utf8');
      expect(source).toContain('// myco:defers-to-member-plugin');
      expect(source).not.toContain('// myco:member-plugin');
    }
  });

  it('OpenCode returns no hooks when a member plugin is at the worktree root or in a directory between it and the launch directory', async () => {
    const root = project();
    plugin(root, MEMBER_LINE);
    expect(await MycoPlugin({ client: client(), directory: path.join(root, 'sub', 'deeper'), worktree: root })).toEqual({});

    const nested = project();
    plugin(path.join(nested, 'sub'), MEMBER_LINE);
    expect(await MycoPlugin({ client: client(), directory: path.join(nested, 'sub', 'deeper'), worktree: nested })).toEqual({});
  });

  it('OpenCode keeps its hooks with no member plugin, with a 1.4 project plugin, and for a member plugin outside the loaded range', async () => {
    const plain = project();
    expect(Object.keys(await MycoPlugin({ client: client(), directory: plain, worktree: plain })).length).toBeGreaterThan(0);

    const legacy = project();
    plugin(legacy, fs.readFileSync(templatePath('opencode'), 'utf8'));
    expect(Object.keys(await MycoPlugin({ client: client(), directory: legacy, worktree: legacy })).length).toBeGreaterThan(0);

    // A member plugin only in a subdirectory the session did not launch from is not loaded, so it is not deferred to.
    const sibling = project();
    plugin(path.join(sibling, 'sub'), MEMBER_LINE);
    expect(Object.keys(await MycoPlugin({ client: client(), directory: sibling, worktree: sibling })).length).toBeGreaterThan(0);
  });

  it('Pi returns from its factory before registering anything while a member extension has marked itself active', () => {
    // Pi's runtime supplies the extension's imports, so the factory is checked
    // by shape here, as tests/symbionts/pi-steering.test.ts checks the rest of it.
    const source = fs.readFileSync(templatePath('pi'), 'utf8');
    const factory = source.slice(source.indexOf('export default function (pi: ExtensionAPI) {'));
    const firstStatement = factory.split('\n').slice(1).find((line) => line.trim() !== '' && !line.trim().startsWith('//'));
    expect(firstStatement?.trim()).toBe('if ((globalThis as Record<symbol, unknown>)[Symbol.for("myco.member-extension")]) return;');
  });
});
