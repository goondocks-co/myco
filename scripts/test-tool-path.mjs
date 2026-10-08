import fs from 'node:fs';
import path from 'node:path';

export function resolveTestTool(name, incomingPath = process.env.PATH ?? '') {
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')]
    : [''];
  for (const dir of incomingPath.split(path.delimiter)) for (const extension of extensions) {
    const candidate = path.resolve(dir, name + extension);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return null;
}

// Only test tooling is reachable by name; installed harnesses and Myco are excluded.
export function sandboxPath(home, incomingPath = process.env.PATH ?? '') {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const tools = [
    'bun', 'node', 'make', 'npm', 'npx', 'git', 'sh', 'bash', 'env', 'cat', 'tee',
    'ls', 'ps', 'lsof', 'sample', 'kill', 'sleep', 'printf', 'chmod', 'mkdir', 'rm', 'cp', 'mv', 'ln',
    'touch', 'head', 'tail', 'sed', 'awk', 'grep', 'rg', 'wc', 'sort', 'uniq',
    'find', 'xargs', 'dirname', 'basename', 'codesign', 'xattr', 'plutil', 'cut', 'tr', 'date', 'uname', 'id', 'whoami', 'which', 'jq',
    'taskkill', 'tasklist', 'cmd', 'powershell', 'pwsh', 'where',
    'perl', 'python', 'python3', 'ruby', 'file', 'stat', 'readlink', 'realpath', 'getconf',
    'cmp', 'diff', 'dd', 'mktemp', 'du', 'df', 'cc', 'as', 'ld',
    'sha256sum', 'shasum', 'openssl', 'curl', 'tar', 'gzip', 'unzip', 'setsid', 'setpriv', 'prlimit', 'timeout', 'sqlite3', 'shellcheck',
  ];
  for (const name of tools) {
    const executable = resolveTestTool(name, incomingPath);
    if (executable) {
      if (name === 'pwsh') process.env.MYCO_TEST_PWSH_EXECUTABLE = fs.realpathSync(executable);
      const suffix = process.platform === 'win32' ? path.extname(executable) : '';
      const target = path.join(bin, name + suffix);
      if (!fs.existsSync(target)) fs.symlinkSync(executable, target, 'file');
    }
  }
  return bin;
}
