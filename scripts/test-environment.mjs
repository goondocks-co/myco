import fs from 'node:fs';
import path from 'node:path';

// Only test tooling is reachable by name; installed harnesses and Myco are excluded.
export function sandboxPath(home, incomingPath = process.env.PATH ?? '') {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const tools = [
    'bun', 'node', 'make', 'npm', 'npx', 'git', 'sh', 'bash', 'env', 'cat', 'tee',
    'ls', 'ps', 'lsof', 'sample', 'kill', 'sleep', 'printf', 'chmod', 'mkdir', 'rm', 'cp', 'mv', 'ln',
    'touch', 'head', 'tail', 'sed', 'awk', 'grep', 'rg', 'wc', 'sort', 'uniq',
    'find', 'xargs', 'dirname', 'basename', 'codesign', 'xattr', 'launchctl', 'plutil', 'cut', 'tr', 'date', 'uname', 'id', 'whoami', 'which',
    'taskkill', 'tasklist', 'cmd', 'powershell', 'pwsh', 'where',
    'perl', 'python', 'python3', 'ruby', 'file', 'stat', 'readlink', 'realpath', 'getconf',
    'cmp', 'diff', 'dd', 'mktemp', 'du', 'df',
    'openssl', 'curl', 'tar', 'gzip', 'unzip', 'setsid', 'setpriv', 'prlimit', 'timeout',
  ];
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')]
    : [''];
  for (const name of tools) {
    const executable = incomingPath.split(path.delimiter)
      .flatMap((dir) => extensions.map((extension) => path.join(dir, name + extension)))
      .find((candidate) => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
      catch { return false; }
    });
    if (executable) {
      const suffix = process.platform === 'win32' ? path.extname(executable) : '';
      fs.symlinkSync(executable, path.join(bin, name + suffix), 'file');
    }
  }
  return bin;
}

