import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promptSelectionText } from '@myco/member/prompt-files.js';
import { readPromptFiles } from '@myco/member/prompt-file-reader.js';
import { PROMPT_FILE_CONTEXT_CHARS, PROMPT_FILE_OPENING_CHARS } from '@myco/member/prompt-file-policy.js';
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
const ask = async (text: string, over = {}) => {
  text = text.slice(0, PROMPT_ASK_MAX_CHARS);
  const additions: string[] = [];
  await readPromptFiles({ text, cwd: root, projectRoot: root, env, deadline: Date.now() + 30_000, references: promptFileReferences(text), ...over }, part => additions.push(part));
  return text + additions.join('');
};

it('recognizes prose, quoted spaces, relative paths, mentions and trailing punctuation in appearance order', async () => {
  write(path.join(root, 'docs', 'task.md'), 'Repair ownership.');
  write(path.join(root, 'notes with spaces.md'), 'Preserve history.');
  const text = 'Fix capture using docs/task.md. Then read "notes with spaces.md" and @./docs/task.md; ignore https://host/file.md and user@host.txt.';
  expect(promptFileReferences(text)).toEqual(['docs/task.md', 'notes with spaces.md', './docs/task.md']);
  const selected = await ask(text);
  expect(selected).toBe(`${text}\n\n[File opening]\nRepair ownership.\n\n[File opening]\nPreserve history.`);
  expect(promptReferencesFile('Read @docs/task.md.', '/workspace/docs/task.md')).toBe(true);
  expect(promptReferencesFile('Read docs/other-work.md.', '/workspace/docs/task.md')).toBe(false);
});

it('admits project, temporary and approved home work files but keeps unapproved roots private', async () => {
  const local = write(path.join(root, 'work.txt'), 'Project task');
  const work = write(path.join(home, 'work', 'task.txt'), 'Home task');
  const temp = write(path.join(dir, 'temp', 'task.txt'), 'Temporary task');
  const outside = write(path.join(dir, 'other', 'task.txt'), 'UNRELATED');
  const prompt = `Read ${local}, ~/work/task.txt and ${temp}. Also ${outside}.`;
  const selected = await ask(prompt, { roots: ['~/work'] });
  expect(selected).toContain('Project task'); expect(selected).toContain('Home task'); expect(selected).toContain('Temporary task');
  expect(selected).not.toContain('UNRELATED');
  expect(await ask(`Read ${work}.`)).toBe(`Read ${work}.`);
  expect(await ask(`Read ${work}.`, { roots: ['~', '~/', '/', home, path.dirname(home)] })).toBe(`Read ${work}.`);
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
  expect(await ask(text, { roots: ['~/linked-work'] })).toBe(text);
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

it('refuses unapproved personal roots, non-prose files, private names, hard links and unsafe cwd fallback', async () => {
  const key = write(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE');
  fs.linkSync(key, path.join(root, 'hard.txt'));
  for (const file of ['config/secrets.yml', 'settings.local.json', '.dev.vars', 'credentials.md', 'private/token-notes.txt']) write(path.join(root, file), 'PRIVATE');
  write(path.join(home, 'Documents', 'taxes-2025.txt'), 'PRIVATE');
  write(path.join(dir, 'other-repo', 'notes.md'), 'PRIVATE');
  write(path.join(home, '.config', 'gh', 'hosts.yml'), 'PRIVATE');
  const text = 'Read ~/Documents/taxes-2025.txt ../other-repo/notes.md config/secrets.yml settings.local.json .dev.vars hard.txt credentials.md private/token-notes.txt.';
  expect(await ask(text)).toBe(text);
  const fromHome = 'Read ~/.config/gh/hosts.yml.';
  expect(await ask(fromHome, { cwd: home, projectRoot: undefined })).toBe(fromHome);
  const personal = 'Read Documents/taxes-2025.txt.';
  expect(await ask(personal, { cwd: home, projectRoot: undefined })).toBe(personal);
  const nonProse = 'use and/or e.g. Node.js @username @types/node "settings.local.json"';
  expect(promptFileReferences(nonProse)).toEqual([]);
  write(path.join(root, 'notes', 'plan.md'), 'Approved plan');
  expect(await ask('Read @notes/plan.md.')).toContain('Approved plan');
  expect(await ask('Read @notes/plan.md.', { projectRoot: undefined })).toBe('Read @notes/plan.md.');
  expect(await ask('Read @notes/plan.md.', { projectRoot: undefined, env: { ...env, MYCO_PROJECT_ROOT: root } })).toContain('Approved plan');
});

it('refuses secrets under a prose name, a declared root that is not the working directory, and broad temporary roots', async () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----\n';
  for (const file of ['id_rsa.txt', 'id_ed25519.md', '.netrc.txt', 'pgpass.txt', 'passwd.txt', 'creds.md']) write(path.join(root, file), 'PRIVATE');
  for (const [file, text] of [['deploy.txt', pem], ['aws.txt', 'aws_access_key_id = AKIAABCDEFGHIJKLMNOP'], ['notes.md', 'Setup\npassword: hunter2hunter2\n'],
    ['ci.md', `token ghp_${'a'.repeat(36)}`]] as const) write(path.join(root, file), text);
  const named = 'Read id_rsa.txt id_ed25519.md .netrc.txt pgpass.txt passwd.txt creds.md deploy.txt aws.txt notes.md ci.md.';
  expect(await ask(named)).toBe(named);
  write(path.join(root, 'plan.md'), 'The plan mentions a password policy in prose.');
  expect(await ask('Read plan.md.')).toContain('password policy');

  write(path.join(home, 'Documents', 'notes.md'), 'PRIVATE');
  const elsewhere = 'Read notes.md.';
  const documents = path.join(home, 'Documents');
  expect(await ask(elsewhere, { cwd: documents, projectRoot: undefined, env: { ...env, MYCO_PROJECT_ROOT: root } })).toBe(elsewhere);
  expect(await ask(elsewhere, { cwd: documents, projectRoot: undefined, env: { ...env, MYCO_VAULT_DIR: root } })).toBe(elsewhere);

  const personal = 'Read ~/Documents/notes.md.';
  for (const broad of [home, path.dirname(home), path.parse(home).root]) {
    expect(await ask(personal, { env: { ...env, MYCO_TEMPORARY_FOLDERS: broad } })).toBe(personal);
  }
});

it('preserves the typed prompt through the spawned reader, with only a prefix-preserving append', async () => {
  const opening = 'Task prose — café. 🌱';
  write(path.join(root, 'task.txt'), opening);
  const text = 'Read task.txt.';
  const selected = await promptSelectionText({ text, cwd: root, projectRoot: root, env, deadline: Date.now() + 30_000 });
  expect(selected.startsWith(text)).toBe(true);
  expect(('\n\n[File opening]\n' + opening).startsWith(selected.slice(text.length))).toBe(true);
});
