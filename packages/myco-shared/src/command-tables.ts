/**
 * The tables the command shaping rule (`command-shape.ts`) reads: the programs whose subcommands a reader needs, the
 * programs kept after an operator, and the extensions a bare word is read as a file by.
 *
 * They are data matched against what a run ran, never words a page says of its own: a word in them reaches a reader only
 * inside a command the run itself ran, as written. A module named `*-tables.ts` holds only such data, and the
 * dashboard's vocabulary gate skips it by that rule (`tests/meta/server-ui-vocabulary.test.ts`).
 */

/** The programs whose first positional word is a subcommand a reader needs, each with the subcommands it is read as. */
export const SUBCOMMAND_TABLE: Readonly<Record<string, readonly string[]>> = {
  git: ['status', 'diff', 'log', 'show', 'add', 'commit', 'push', 'pull', 'fetch', 'checkout', 'switch', 'branch', 'rebase', 'merge', 'stash', 'worktree', 'rev-parse', 'ls-files', 'grep', 'blame', 'remote', 'tag', 'clone', 'init', 'reset', 'restore', 'cherry-pick', 'rm', 'mv', 'config', 'describe', 'reflog', 'shortlog', 'bisect', 'apply', 'submodule', 'clean', 'revert', 'cat-file', 'ls-tree', 'merge-base'],
  npm: ['test', 'run', 'install', 'ci', 'exec', 'publish', 'pack', 'version', 'ls', 'outdated', 'update', 'uninstall', 'init', 'view', 'audit', 'link', 'start', 'build'],
  npx: ['tsc', 'tsx', 'eslint', 'prettier', 'vitest', 'jest', 'playwright', 'wrangler', 'vite', 'biome'],
  pnpm: ['test', 'run', 'install', 'add', 'remove', 'exec', 'dlx', 'build', 'publish', 'update', 'ls'],
  yarn: ['test', 'run', 'install', 'add', 'remove', 'build', 'dlx', 'workspace'],
  bun: ['test', 'run', 'install', 'add', 'remove', 'build', 'x', 'update', 'pm'],
  gh: ['pr', 'issue', 'run', 'repo', 'api', 'release', 'workflow', 'auth', 'browse', 'search', 'label', 'gist', 'secret', 'variable'],
  docker: ['build', 'run', 'ps', 'exec', 'logs', 'pull', 'push', 'images', 'compose', 'stop', 'start', 'restart', 'rm', 'rmi', 'inspect', 'login', 'logout', 'tag', 'network', 'volume', 'system', 'buildx'],
  cargo: ['build', 'test', 'run', 'check', 'clippy', 'fmt', 'add', 'install', 'doc', 'publish', 'update', 'bench', 'clean'],
  go: ['build', 'test', 'run', 'mod', 'vet', 'fmt', 'get', 'install', 'generate', 'env', 'version', 'work'],
  kubectl: ['get', 'describe', 'apply', 'delete', 'logs', 'exec', 'rollout', 'port-forward', 'config', 'create', 'edit', 'scale', 'top'],
  make: ['all', 'build', 'test', 'lint', 'check', 'install', 'clean', 'dev', 'release', 'deploy', 'format', 'run'],
  pip: ['install', 'uninstall', 'list', 'show', 'freeze', 'download', 'check'],
  uv: ['run', 'sync', 'add', 'remove', 'pip', 'venv', 'lock', 'tool', 'python', 'init', 'build'],
  brew: ['install', 'uninstall', 'upgrade', 'update', 'list', 'info', 'services', 'search', 'outdated', 'doctor'],
  myco: ['init', 'status', 'doctor', 'update', 'upgrade', 'login', 'join', 'search', 'session', 'stats', 'logs', 'restart', 'server', 'service', 'worker', 'settings', 'config', 'verify', 'open', 'import', 'remove', 'agent', 'grove', 'version', 'help'],
  wrangler: ['deploy', 'dev', 'tail', 'd1', 'kv', 'r2', 'secret', 'login', 'whoami', 'types', 'versions', 'deployments', 'queues'],
};

/** The programs a word after an operator, or a shell script's first word, is kept as, beside the subcommand programs: shell utilities and runtimes. */
export const PROGRAM_TABLE: readonly string[] = [
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'rg', 'ag', 'find', 'fd', 'sed', 'awk', 'sort', 'uniq', 'wc', 'cut', 'tr', 'xargs',
  'echo', 'printf', 'cd', 'pwd', 'pushd', 'popd', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln', 'touch', 'chmod', 'chown', 'stat', 'file', 'diff',
  'patch', 'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'jq', 'yq', 'sleep', 'date', 'env', 'export', 'true',
  'false', 'test', '[', 'which', 'type', 'command', 'kill', 'ps', 'df', 'du', 'uname', 'whoami', 'id', 'sudo', 'time', 'timeout', 'nohup', 'tee',
  'open', 'code', 'source', 'exec', 'set', 'unset', 'read', 'basename', 'dirname', 'realpath', 'readlink', 'tree', 'base64', 'shasum',
  'sha256sum', 'md5', 'md5sum', 'openssl', 'psql', 'mysql', 'sqlite3', 'redis-cli', 'mongosh',
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'node', 'deno', 'python', 'python3', 'pip3', 'ruby', 'perl', 'java', 'rustc', 'tsc', 'tsx', 'vitest',
  'jest', 'eslint', 'prettier', 'playwright', 'terraform',
];

/** The extensions a bare `name.ext` word with no `/` is read as a file by. */
export const EXTENSION_TABLE: readonly string[] = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'jsonc', 'md', 'mdx', 'txt', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'lock', 'log', 'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico',
  'pdf', 'py', 'pyi', 'ipynb', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish',
  'ps1', 'sql', 'db', 'sqlite', 'sqlite3', 'wasm', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'pem', 'crt', 'key', 'pub', 'cert', 'der', 'p12',
  'pfx', 'gitignore', 'gitattributes', 'dockerignore', 'npmrc', 'nvmrc', 'editorconfig', 'prettierrc', 'eslintrc', 'mod', 'sum', 'proto',
  'graphql', 'gql', 'vue', 'svelte', 'astro', 'lua', 'pl', 'r', 'scala', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj', 'dart', 'nix', 'tf', 'hcl',
  'patch', 'diff', 'bak', 'tmp', 'out', 'err', 'pid', 'plist', 'jar', 'vsix', 'map', 'snap', 'bin', 'dat', 'mp4', 'mp3', 'wav', 'ttf', 'woff',
  'woff2', 'otf', 'dockerfile', 'makefile', 'cmake', 'gradle', 'properties', 'storyboard', 'junit',
];

/** Commands whose positional arguments name filesystem paths. */
export const PATH_PROGRAM_TABLE = ['ls', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'diff', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'du', 'tree', 'realpath', 'readlink', 'basename', 'dirname'];

/** Commands whose first positional argument is a search pattern and subsequent arguments name paths. */
export const SEARCH_PROGRAM_TABLE = ['rg', 'grep', 'egrep', 'ag'];

/** Subcommands whose subsequent positional arguments name paths. */
export const PATH_SUBCOMMAND_TABLE: Readonly<Record<string, readonly string[]>> = {
  git: ['add', 'diff', 'restore', 'rm', 'mv', 'ls-files'],
};

/** Flags with no separate value, scoped to the command that declares them. */
export const BOOLEAN_FLAG_TABLE: Readonly<Record<string, readonly string[]>> = {
  ls: ['-l', '-a', '-h', '-la', '-al', '--all', '--long'],
  cat: ['-n', '-b', '-s'],
  cp: ['-r', '-R', '-f', '-i', '-a'], mv: ['-f', '-i'], rm: ['-r', '-R', '-f', '-rf'],
  rg: ['-n', '-i', '-l', '-q', '-c', '--line-number', '--ignore-case', '--files', '--hidden'],
  grep: ['-n', '-i', '-l', '-q', '-c', '-r', '-R', '-v'],
  egrep: ['-n', '-i', '-l', '-q', '-c'], ag: ['-n', '-i', '-l'],
  git: ['--oneline', '--cached', '--stat', '--name-only', '--staged'],
};

/** Flags whose one separate value names a filesystem path. */
export const PATH_FLAG_TABLE: Readonly<Record<string, readonly string[]>> = {
  git: ['-C', '--git-dir', '--work-tree'],
  openssl: ['-in', '-out'],
  curl: ['--output', '-o', '--cacert'],
};

/** Commands whose first positional, with no preceding flags, names a script file or working directory. */
export const FIRST_PATH_PROGRAM_TABLE = ['node', 'tsx', 'cd', 'pushd'];
