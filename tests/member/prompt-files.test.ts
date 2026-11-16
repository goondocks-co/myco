import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promptSelectionText } from '@myco/member/prompt-files.js';
import { PROMPT_FILE_CONTEXT_CHARS, PROMPT_FILE_OPENING_CHARS, PROMPT_FILE_READ_BUDGET_MS } from '@myco/member/prompt-file-policy.js';
import { PROMPT_ASK_MAX_CHARS } from '@myco/member/context-cache.js';
import { promptFileReferences, promptReferencesFile } from '@goondocks/myco-shared/prompt-file-references';

let dir: string;
let root: string;
let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-files-'));
  root = path.join(dir, 'project'); home = path.join(dir, 'home');
  fs.mkdirSync(root); fs.mkdirSync(home);
  env = { HOME: home, MYCO_TEMPORARY_FOLDERS: path.join(dir, 'temp') };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const write = (file: string, text: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const ask = (text: string, over = {}) => promptSelectionText({ text, cwd: root, projectRoot: root, env, deadline: Date.now() + 1000, ...over });

it('recognizes prose, quoted spaces, relative paths, mentions and trailing punctuation in appearance order', async () => {
  write(path.join(root, 'docs', 'work@local.md'), 'Repair ownership.');
  write(path.join(root, 'notes with spaces.txt'), 'Preserve history.');
  const text = 'Fix capture using docs/work@local.md. Then read "notes with spaces.txt" and @./docs/work@local.md; ignore https://host/file.md and user@host.txt.';
  expect(promptFileReferences(text)).toEqual(['docs/work@local.md', 'notes with spaces.txt', './docs/work@local.md']);
  const selected = await ask(text);
  expect(selected).toBe(`${text}\n\n[File opening]\nRepair ownership.\n\n[File opening]\nPreserve history.`);
  expect(promptReferencesFile('Read @docs/work@local.md.', '/workspace/docs/work@local.md')).toBe(true);
  expect(promptReferencesFile('Read docs/other-work.md.', '/workspace/docs/work@local.md')).toBe(false);
});

it('admits explicitly named temporary and home work files but keeps unrelated host files private', async () => {
  const local = write(path.join(root, 'work.txt'), 'Project task');
  const work = write(path.join(home, 'work', 'task.txt'), 'Home task');
  const temp = write(path.join(dir, 'temp', 'task.txt'), 'Temporary task');
  const outside = write(path.join(dir, 'other', 'task.txt'), 'UNRELATED');
  const prompt = `Read ${local}, ~/work/task.txt and ${temp}. Also ${outside}.`;
  const selected = await ask(prompt);
  expect(selected).toContain('Project task'); expect(selected).toContain('Home task'); expect(selected).toContain('Temporary task');
  expect(selected).not.toContain('UNRELATED');
  expect(await ask(`Read ${work}.`)).toContain('Home task');
});

it('leaves missing, binary, credential, capture-excluded and symlinked files unread', async () => {
  const outside = write(path.join(dir, 'other', 'task.txt'), 'PRIVATE');
  fs.symlinkSync(outside, path.join(root, 'linked.txt'));
  fs.symlinkSync(path.dirname(outside), path.join(root, 'linked-dir'));
  fs.symlinkSync(path.dirname(outside), path.join(home, 'linked-work'));
  write(path.join(root, 'image.png'), 'Printable image header');
  write(path.join(root, 'binary.txt'), Buffer.from([0, 1, 2, 3]));
  write(path.join(root, '.env'), 'PRIVATE');
  const temporary = path.join(dir, 'claude-work');
  write(path.join(temporary, 'scratchpad', 'task.txt'), 'PRIVATE');
  const alias = path.join(dir, 'temporary-alias');
  fs.symlinkSync(temporary, alias);
  env.MYCO_TEMPORARY_FOLDERS = alias;
  const excluded = path.join(alias, 'scratchpad', 'task.txt');
  const text = `Read missing.txt image.png binary.txt .env linked.txt linked-dir/task.txt ~/linked-work/task.txt ${excluded}.`;
  expect(await ask(text)).toBe(text);
  expect(await ask('Investigate the capture issue.')).toBe('Investigate the capture issue.');
});

it('bounds file openings and the combined ask while preserving the prompt first', async () => {
  write(path.join(root, 'first.txt'), 'A'.repeat(PROMPT_FILE_OPENING_CHARS + 10));
  write(path.join(root, 'second.txt'), 'B'.repeat(PROMPT_FILE_OPENING_CHARS + 10));
  write(path.join(root, 'third.txt'), 'THIRD');
  const text = 'Read first.txt second.txt third.txt.';
  const selected = await ask(text);
  expect(selected.startsWith(text)).toBe(true);
  expect(selected).toContain('A'.repeat(PROMPT_FILE_OPENING_CHARS));
  expect(selected).not.toContain('THIRD');
  expect(selected.length).toBe(text.length + PROMPT_FILE_CONTEXT_CHARS);
  const long = 'Read first.txt ' + 'x'.repeat(PROMPT_ASK_MAX_CHARS);
  expect(await ask(long)).toBe(long.slice(0, PROMPT_ASK_MAX_CHARS));
});

it('abandons a slow read inside the read and hook budgets without changing the ask', async () => {
  write(path.join(root, 'task.txt'), 'Task text');
  const text = 'Read task.txt.';
  const started = performance.now();
  expect(await promptSelectionText({ text, cwd: root, projectRoot: root, env, deadline: Date.now() + 1000 },
    { path: process.execPath, args: ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)'] })).toBe(text);
  expect(performance.now() - started).toBeLessThan(PROMPT_FILE_READ_BUDGET_MS + 100);

});
