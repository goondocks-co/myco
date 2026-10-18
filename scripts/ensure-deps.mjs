import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const installRoots = [
  { directory: '.', label: 'workspace' },
  { directory: 'packages/myco-server/ui', label: 'dashboard' },
];
export const excludedLockfiles = {
  'docs/package-lock.json': 'The documentation site is built separately; run npm ci --prefix docs before its scripts.',
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function command(tool, args) {
  return spawnSync(tool, args, { encoding: 'utf8' });
}

function requireTool(tool, remedy, args = ['--version']) {
  const result = command(tool, args);
  if (result.error || result.status !== 0) throw new Error(`${tool} is required. ${remedy}`);
  return result.stdout.trim();
}

function requireExecutable(tool, remedy) {
  const available = (process.env.PATH ?? '').split(path.delimiter).some(directory => {
    try { fs.accessSync(path.join(directory, tool), fs.constants.X_OK); return true; }
    catch (error) {
      if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) return false;
      throw error;
    }
  });
  if (!available) throw new Error(`${tool} is required. ${remedy}`);
}

export function checkTools(root, windows = false) {
  const floor = readJson(path.join(root, 'packages/myco/package.json')).engines.node;
  const minimum = Number(floor.replace('>=', ''));
  const node = requireTool('node', `Install Node.js ${floor} with npm from https://nodejs.org/.`);
  if (Number(node.replace(/^v/, '').split('.')[0]) < minimum) {
    throw new Error(`Node.js ${floor} is required (found ${node}). Install it from https://nodejs.org/.`);
  }
  requireExecutable('npm', 'Install Node.js with npm from https://nodejs.org/.');
  const bun = requireTool('bun', 'Install Bun: curl -fsSL https://bun.sh/install | bash');
  const pin = fs.readFileSync(path.join(root, '.bun-version'), 'utf8').trim();
  if (bun !== pin) console.error(`Notice: Bun ${bun} differs from .bun-version (${pin}); continuing.`);
  requireExecutable('bash', 'Install Bash with your package manager.');
  const target = windows ? 'windows-x64' : `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const native = command('bash', [path.join(root, 'packages/myco/scripts/check-native-build-tools.sh'), target]);
  if (native.error) throw native.error;
  if (native.status !== 0) throw new Error(native.stderr.trim() || `Native tool check failed (exit ${native.status}).`);
}

function identity(entry) {
  return JSON.stringify([entry.version, entry.resolved, entry.integrity, entry.link === true]);
}

export function staleReason(root) {
  if (!fs.existsSync(path.join(root, 'node_modules'))) return 'packages missing';
  let installed;
  try { installed = readJson(path.join(root, 'node_modules/.package-lock.json')).packages; }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return 'install record missing or invalid';
    throw error;
  }
  const locked = readJson(path.join(root, 'package-lock.json')).packages;
  if (!installed || !locked) return 'install record missing or invalid';
  for (const [name, entry] of Object.entries(locked)) {
    if (!name) continue;
    const present = installed[name];
    if (!present) {
      // npm may omit optional packages and their transitive dependencies.
      if (entry.optional) continue;
      return 'packages out of date';
    }
    if (identity(entry) !== identity(present) || !fs.existsSync(path.join(root, name))) return 'packages out of date';
  }
  if (Object.keys(installed).some(name => !locked[name])) return 'packages out of date';
  return null;
}

export function ensureDeps(root, uiOnly = false) {
  for (const item of installRoots.filter(item => !uiOnly || item.directory !== '.')) {
    const directory = path.resolve(root, item.directory);
    const reason = staleReason(directory);
    if (!reason) continue;
    console.log(`${item.label} ${reason}; reinstalling`);
    const result = spawnSync('npm', ['ci'], { cwd: directory, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm ci failed for ${item.label} (exit ${result.status ?? result.signal}).`);
    const remaining = staleReason(directory);
    if (remaining) throw new Error(`${item.label} installation is incomplete: ${remaining}. Check npm omit/optional settings.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--ui', '--windows'].includes(arg))) throw new Error('Usage: node scripts/ensure-deps.mjs [--ui] [--windows]');
    checkTools(repo, args.includes('--windows'));
    ensureDeps(repo, args.includes('--ui'));
  } catch (error) {
    console.error(`Myco: ${error.message}`);
    process.exitCode = 1;
  }
}
