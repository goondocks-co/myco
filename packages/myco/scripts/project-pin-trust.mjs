import pinFs from 'node:fs';
import pinOs from 'node:os';
import pinPath from 'node:path';
import { createHash as pinHash, randomUUID as pinNonce } from 'node:crypto';

const PROJECT_PIN_TRUST_DIRECTORY = 'project-pin-trust';

function pinDigest(value) {
  return pinHash('sha256').update(value).digest('hex');
}

function projectPinIdentity(filePath) {
  const directory = pinPath.dirname(filePath);
  const root = pinFs.realpathSync(pinPath.dirname(directory));
  if (pinFs.realpathSync(directory) !== pinPath.join(root, '.myco')) throw new Error('pin directory is a symlink');
  let repo = root;
  while (true) {
    const dotGit = pinPath.join(repo, '.git');
    if (pinFs.existsSync(dotGit)) {
      const stat = pinFs.lstatSync(dotGit);
      if (stat.isSymbolicLink()) throw new Error('git directory is a symlink');
      let common = dotGit;
      if (!stat.isDirectory()) {
        const match = /^gitdir: (.+)\s*$/.exec(pinFs.readFileSync(dotGit, 'utf8').trim());
        if (!match) throw new Error('invalid git directory');
        const admin = pinFs.realpathSync(pinPath.resolve(repo, match[1]));
        common = pinFs.realpathSync(pinPath.resolve(admin, pinFs.readFileSync(pinPath.join(admin, 'commondir'), 'utf8').trim()));
        const backlink = pinFs.realpathSync(pinPath.resolve(admin, pinFs.readFileSync(pinPath.join(admin, 'gitdir'), 'utf8').trim()));
        if (backlink !== pinFs.realpathSync(dotGit) || pinPath.dirname(admin) !== pinPath.join(common, 'worktrees')) throw new Error('unregistered worktree');
      }
      return JSON.stringify([pinFs.realpathSync(common), pinPath.relative(repo, root), pinPath.basename(filePath)]);
    }
    const parent = pinPath.dirname(repo);
    if (parent === repo) return JSON.stringify([root, pinPath.basename(filePath)]);
    repo = parent;
  }
}

function projectPinRecord(filePath, homeDir) {
  const base = pinPath.join(homeDir, '.myco', PROJECT_PIN_TRUST_DIRECTORY);
  return pinPath.join(base, `${pinDigest(projectPinIdentity(filePath))}.json`);
}

function outsideCheckout(directory) {
  let dir = pinFs.realpathSync(directory);
  while (true) {
    if (pinFs.existsSync(pinPath.join(dir, '.git'))) throw new Error('project pin trust must live outside a checkout');
    const parent = pinPath.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Project pins require this user's approval of the local repository and pin path. */
export function projectPinIsTrusted(filePath, homeDir = process.env.HOME || process.env.USERPROFILE || pinOs.homedir()) {
  try {
    const record = projectPinRecord(filePath, homeDir);
    outsideCheckout(pinPath.dirname(record));
    const stat = pinFs.lstatSync(record);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (process.platform !== 'win32' && ((stat.mode & 0o022) || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) return false;
    const approved = JSON.parse(pinFs.readFileSync(record, 'utf8'));
    return approved.identity === projectPinIdentity(filePath);
  } catch {
    return false;
  }
}

/** Explicit pin-writing and approval commands are the only callers of this writer. */
export function trustProjectPin(filePath, homeDir = process.env.HOME || process.env.USERPROFILE || pinOs.homedir()) {
  const stat = pinFs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('pin must be a regular file');
  if (process.platform !== 'win32' && ((stat.mode & 0o022) || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) throw new Error('pin ownership or permissions are unsafe');
  const value = pinFs.readFileSync(filePath, 'utf8').trim();
  if (!value) throw new Error('pin is empty');
  const record = projectPinRecord(filePath, homeDir);
  pinFs.mkdirSync(pinPath.dirname(record), { recursive: true, mode: 0o700 });
  outsideCheckout(pinPath.dirname(record));
  const temporary = `${record}.${pinNonce()}`;
  try {
    pinFs.writeFileSync(temporary, JSON.stringify({ identity: projectPinIdentity(filePath) }) + '\n', { mode: 0o600, flag: 'wx' });
    pinFs.renameSync(temporary, record);
  } finally {
    pinFs.rmSync(temporary, { force: true });
  }
}
