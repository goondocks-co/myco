import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import { runLaunchPreamble, type LaunchPreambleDeps } from '@myco/cli/launch-preamble.js';
import { readStdin, setBufferedStdin } from '@myco/hooks/read-stdin.js';

/**
 * Sentinel thrown by the injected `exit` stub so a test can observe the exit
 * code without the process actually terminating. runLaunchPreamble's exit
 * decisions all flow through `deps.exit`, which the real entry point binds to
 * `process.exit` (never-returns); under test it throws this instead.
 */
class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`);
    this.name = 'ExitSignal';
  }
}

interface ExecCall {
  file: string;
  args: string[];
  options: { input?: Buffer; stdio?: unknown; env?: NodeJS.ProcessEnv };
}

interface Harness {
  deps: LaunchPreambleDeps;
  execCalls: ExecCall[];
  chdirCalls: string[];
  cwd: string;
  pinReturns: string | null;
}

/**
 * Build a deps harness with every side-effecting seam stubbed. `pin` is what
 * the runtime-pin resolver returns; `execResult` simulates the re-exec child's
 * exit (numeric status, or an Error to model ENOENT/signal).
 */
function makeHarness(opts: {
  pin?: string | null;
  execPath?: string;
  realpaths?: Record<string, string>;
  execResult?: { status?: number } | Error;
  /** Simulated host platform; defaults to `'darwin'` so POSIX paths run. */
  platform?: NodeJS.Platform;
  /** Set of paths that `existsSync` should report present (Windows resolver). */
  existing?: string[];
  /** PATH search dirs for the bare-alias resolver. */
  pathDirs?: string[];
  /** PATHEXT extensions (lowercased) for the Windows resolver. */
  pathExts?: string[];
} = {}): Harness {
  const execCalls: ExecCall[] = [];
  const chdirCalls: string[] = [];
  const h: Harness = {
    execCalls,
    chdirCalls,
    cwd: '/start/cwd',
    pinReturns: opts.pin ?? null,
    deps: {} as LaunchPreambleDeps,
  };

  const existing = new Set(opts.existing ?? []);
  h.deps = {
    execPath: opts.execPath ?? '/usr/local/bin/myco',
    cwd: () => h.cwd,
    chdir: (dir: string) => { chdirCalls.push(dir); h.cwd = dir; },
    exit: (code: number) => { throw new ExitSignal(code); },
    resolveRuntimePin: () => h.pinReturns,
    realpathSync: (p: string) => {
      if (opts.realpaths && p in opts.realpaths) return opts.realpaths[p];
      return p;
    },
    execFileSync: (file: string, args: string[], options: ExecCall['options']) => {
      execCalls.push({ file, args, options });
      if (opts.execResult instanceof Error) throw opts.execResult;
      if (opts.execResult && typeof opts.execResult.status === 'number') {
        const err = new Error('child exited nonzero') as Error & { status: number };
        err.status = opts.execResult.status;
        throw err;
      }
      return Buffer.alloc(0);
    },
    platform: opts.platform ?? 'darwin',
    existsSync: (p: string) => existing.has(p),
    pathDirs: () => opts.pathDirs ?? [],
    pathExts: () => opts.pathExts ?? ['.com', '.exe', '.bat', '.cmd'],
  };
  return h;
}

/** Read fd 0 (Antigravity path) from an injected buffer for the test. */
function withInjectedFd0(buf: Buffer | null, deps: LaunchPreambleDeps): LaunchPreambleDeps {
  return { ...deps, readFd0: () => (buf === null ? Buffer.alloc(0) : buf) };
}

const SAVED_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.MYCO_AGENT_SESSION;
  delete process.env.MYCO_TRAMPOLINED;
  delete process.env.CURSOR_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.WINDSURF_PROJECT_DIR;
  delete process.env.MYCO_PROJECT_ROOT;
});
afterEach(() => {
  for (const k of ['MYCO_AGENT_SESSION', 'MYCO_TRAMPOLINED', 'CURSOR_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'WINDSURF_PROJECT_DIR', 'MYCO_PROJECT_ROOT']) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  setBufferedStdin(null);
});

describe('runLaunchPreamble — recursion guard is hook-only (MYCO_AGENT_SESSION)', () => {
  it('hook exits 0 when MYCO_AGENT_SESSION is set', () => {
    process.env.MYCO_AGENT_SESSION = '1';
    const h = makeHarness();
    expect(() => runLaunchPreamble('hook', ['session-start', '--symbiont', 'claude-code'], h.deps))
      .toThrow(/exit\(0\)/);
  });

  it('tool still reaches the binary under a Myco agent session (no guard)', () => {
    process.env.MYCO_AGENT_SESSION = '1';
    const h = makeHarness({ pin: null });
    // No pin → falls through and returns; never calls exit.
    expect(() => runLaunchPreamble('tool', ['call', 'myco_search'], h.deps)).not.toThrow();
    expect(h.execCalls).toHaveLength(0);
  });

  it('mcp still reaches the binary under a Myco agent session (no guard)', () => {
    process.env.MYCO_AGENT_SESSION = '1';
    const h = makeHarness({ pin: null });
    expect(() => runLaunchPreamble('mcp', [], h.deps)).not.toThrow();
    expect(h.execCalls).toHaveLength(0);
  });
});

describe('runLaunchPreamble — cwd anchor (hook only)', () => {
  it('chdirs to CLAUDE_PROJECT_DIR when set', () => {
    process.env.CLAUDE_PROJECT_DIR = '/work/project';
    const h = makeHarness({ pin: null });
    runLaunchPreamble('hook', ['session-start', '--symbiont', 'claude-code'], h.deps);
    expect(h.chdirCalls).toContain('/work/project');
  });

  it('first matching project-dir env var wins (CURSOR before CLAUDE)', () => {
    process.env.CURSOR_PROJECT_DIR = '/work/cursor';
    process.env.CLAUDE_PROJECT_DIR = '/work/claude';
    const h = makeHarness({ pin: null });
    runLaunchPreamble('hook', ['session-start', '--symbiont', 'cursor'], h.deps);
    expect(h.chdirCalls).toEqual(['/work/cursor']);
  });

  it('ignores a "." project-dir value', () => {
    process.env.CLAUDE_PROJECT_DIR = '.';
    const h = makeHarness({ pin: null });
    runLaunchPreamble('hook', ['session-start'], h.deps);
    expect(h.chdirCalls).toHaveLength(0);
  });

  it('does NOT anchor cwd for mcp', () => {
    process.env.CLAUDE_PROJECT_DIR = '/work/project';
    const h = makeHarness({ pin: null });
    runLaunchPreamble('mcp', [], h.deps);
    expect(h.chdirCalls).toHaveLength(0);
  });

  it('does NOT anchor cwd for tool', () => {
    process.env.CLAUDE_PROJECT_DIR = '/work/project';
    const h = makeHarness({ pin: null });
    runLaunchPreamble('tool', ['call', 'myco_search'], h.deps);
    expect(h.chdirCalls).toHaveLength(0);
  });
});

describe('runLaunchPreamble — Antigravity stdin', () => {
  it('chdirs to workspacePaths[0] and re-injects the buffer for the handler', async () => {
    const payload = Buffer.from(JSON.stringify({ workspacePaths: ['/tmp/x'] }), 'utf-8');
    const h = makeHarness({ pin: null });
    runLaunchPreamble('hook', ['session-start', '--symbiont', 'antigravity'], withInjectedFd0(payload, h.deps));
    expect(h.chdirCalls).toContain('/tmp/x');
    // The handler's readStdin() must see the buffered payload, not a drained fd 0.
    expect(await readStdin()).toBe(payload.toString('utf-8'));
  });

  it('non-JSON stdin falls through silently (no chdir, no throw)', () => {
    const h = makeHarness({ pin: null });
    expect(() => runLaunchPreamble('hook', ['--symbiont', 'antigravity'], withInjectedFd0(Buffer.from('not json'), h.deps))).not.toThrow();
    expect(h.chdirCalls).toHaveLength(0);
  });

  it('only reads Antigravity stdin when --symbiont antigravity is present', () => {
    const payload = Buffer.from(JSON.stringify({ workspacePaths: ['/tmp/x'] }), 'utf-8');
    const h = makeHarness({ pin: null });
    runLaunchPreamble('hook', ['session-start', '--symbiont', 'claude-code'], withInjectedFd0(payload, h.deps));
    expect(h.chdirCalls).toHaveLength(0);
  });
});

describe('runLaunchPreamble — pin re-exec', () => {
  it('re-execs when the pin resolves to a different absolute path', () => {
    const h = makeHarness({
      pin: '/opt/myco-dev/bin/myco',
      execPath: '/usr/local/bin/myco',
    });
    expect(() => runLaunchPreamble('hook', ['session-start', '--symbiont', 'claude-code'], h.deps))
      .toThrow(/exit\(0\)/); // propagates child's clean exit
    expect(h.execCalls).toHaveLength(1);
    expect(h.execCalls[0].file).toBe('/opt/myco-dev/bin/myco');
    expect(h.execCalls[0].args).toEqual(['hook', 'session-start', '--symbiont', 'claude-code']);
    expect(h.execCalls[0].options.env?.MYCO_TRAMPOLINED).toBe('1');
  });

  it('does NOT re-exec when the pin realpath equals this binary', () => {
    const h = makeHarness({
      pin: '/usr/local/bin/myco',
      execPath: '/opt/real/myco',
      realpaths: { '/usr/local/bin/myco': '/opt/real/myco', '/opt/real/myco': '/opt/real/myco' },
    });
    expect(() => runLaunchPreamble('hook', ['session-start'], h.deps)).not.toThrow();
    expect(h.execCalls).toHaveLength(0);
  });

  it('re-execs a bare-alias pin ("myco-dev") so the PATH-resolved alias handles the hook (loop-guarded)', () => {
    // The runtime.command alias contract (hook-guard alias tests): a bare alias
    // redirects to its PATH-resolved binary, exactly as the retired launcher did.
    // We can't cheaply prove a bare alias resolves to self, so we exec it; the
    // MYCO_TRAMPOLINED guard the re-exec sets stops a self-alias from recursing.
    const h = makeHarness({ pin: 'myco-dev', execPath: '/usr/local/bin/myco' });
    expect(() => runLaunchPreamble('hook', ['session-start', '--symbiont', 'codex'], h.deps))
      .toThrow(/exit\(0\)/);
    expect(h.execCalls).toHaveLength(1);
    expect(h.execCalls[0].file).toBe('myco-dev');
    expect(h.execCalls[0].args).toEqual(['hook', 'session-start', '--symbiont', 'codex']);
    expect(h.execCalls[0].options.env?.MYCO_TRAMPOLINED).toBe('1');
  });

  it('does NOT re-exec when MYCO_TRAMPOLINED is already set', () => {
    process.env.MYCO_TRAMPOLINED = '1';
    const h = makeHarness({ pin: '/opt/myco-dev/bin/myco', execPath: '/usr/local/bin/myco' });
    expect(() => runLaunchPreamble('hook', ['session-start'], h.deps)).not.toThrow();
    expect(h.execCalls).toHaveLength(0);
  });

  it('returns immediately when MYCO_TRAMPOLINED set and no pin (production idempotent path)', () => {
    process.env.MYCO_TRAMPOLINED = '1';
    const h = makeHarness({ pin: null });
    expect(() => runLaunchPreamble('hook', ['session-start'], h.deps)).not.toThrow();
    expect(h.execCalls).toHaveLength(0);
  });

  it('re-exec for mcp passes [mcp, ...argv]', () => {
    const h = makeHarness({ pin: '/opt/myco-dev/bin/myco', execPath: '/usr/local/bin/myco' });
    expect(() => runLaunchPreamble('mcp', [], h.deps)).toThrow(/exit\(0\)/);
    expect(h.execCalls[0].args).toEqual(['mcp']);
  });

  it('tool re-execs on a pin alone — the decision is vault-independent', () => {
    // The preamble consults only the runtime pin (a filesystem walk), never a
    // myco.yaml vault gate, so a pinned `myco tool call` re-execs even on a
    // host with no project vault. cli.ts runs this BEFORE its myco.yaml gate.
    const h = makeHarness({ pin: '/opt/myco-dev/bin/myco', execPath: '/usr/local/bin/myco' });
    expect(() => runLaunchPreamble('tool', ['call', 'myco_search', '--json'], h.deps)).toThrow(/exit\(0\)/);
    expect(h.execCalls[0].file).toBe('/opt/myco-dev/bin/myco');
    expect(h.execCalls[0].args).toEqual(['tool', 'call', 'myco_search', '--json']);
    expect(h.execCalls[0].options.env?.MYCO_TRAMPOLINED).toBe('1');
  });

  it('feeds the Antigravity buffer to the child via input on re-exec', () => {
    const payload = Buffer.from(JSON.stringify({ workspacePaths: ['/tmp/x'] }), 'utf-8');
    const h = makeHarness({ pin: '/opt/myco-dev/bin/myco', execPath: '/usr/local/bin/myco' });
    expect(() => runLaunchPreamble('hook', ['--symbiont', 'antigravity'], withInjectedFd0(payload, h.deps)))
      .toThrow(/exit\(0\)/);
    expect(h.execCalls[0].options.input).toEqual(payload);
  });

  it('does NOT setBufferedStdin on the re-exec path (buffer goes to the child, not this process)', async () => {
    const payload = Buffer.from(JSON.stringify({ workspacePaths: ['/tmp/x'] }), 'utf-8');
    const h = makeHarness({ pin: '/opt/myco-dev/bin/myco', execPath: '/usr/local/bin/myco' });
    expect(() => runLaunchPreamble('hook', ['--symbiont', 'antigravity'], withInjectedFd0(payload, h.deps)))
      .toThrow(/exit\(0\)/);
    // This process re-exec'd, so no in-process buffer was set; readStdin falls
    // through to fd 0 (empty under bun test) → '{}'.
    expect(await readStdin()).toBe('{}');
  });
});

describe('runLaunchPreamble — Windows pin PATHEXT resolution', () => {
  it('resolves a bare-alias pin to <dir>/myco-dev.cmd on win32 and execs THAT', () => {
    // execFileSync with shell:false does not apply PATHEXT, so the bare alias
    // must be resolved to its `.cmd` shim before exec or it ENOENTs → exit(0)
    // → capture goes dark for the pinned project.
    const aliasDir = 'C:\\tools\\bin';
    const resolved = path.join(aliasDir, 'myco-dev.cmd');
    const h = makeHarness({
      pin: 'myco-dev',
      execPath: 'C:\\Program Files\\myco\\myco.exe',
      platform: 'win32',
      pathDirs: [aliasDir],
      existing: [resolved],
    });
    expect(() => runLaunchPreamble('hook', ['session-start', '--symbiont', 'codex'], h.deps))
      .toThrow(/exit\(0\)/);
    expect(h.execCalls).toHaveLength(1);
    expect(h.execCalls[0].file).toBe(resolved);
    expect(h.execCalls[0].args).toEqual(['hook', 'session-start', '--symbiont', 'codex']);
    expect(h.execCalls[0].options.env?.MYCO_TRAMPOLINED).toBe('1');
  });

  it('honors PATHEXT order — picks .exe over .cmd when both exist', () => {
    const aliasDir = 'C:\\tools\\bin';
    const exe = path.join(aliasDir, 'myco-dev.exe');
    const cmd = path.join(aliasDir, 'myco-dev.cmd');
    const h = makeHarness({
      pin: 'myco-dev',
      platform: 'win32',
      pathDirs: [aliasDir],
      pathExts: ['.exe', '.cmd'],
      existing: [exe, cmd],
    });
    expect(() => runLaunchPreamble('hook', ['session-start'], h.deps)).toThrow(/exit\(0\)/);
    expect(h.execCalls[0].file).toBe(exe);
  });

  it('searches PATH dirs in order and stops at the first match', () => {
    const dir1 = 'C:\\a';
    const dir2 = 'C:\\b';
    const hit = path.join(dir2, 'myco-dev.cmd');
    const h = makeHarness({
      pin: 'myco-dev',
      platform: 'win32',
      pathDirs: [dir1, dir2],
      existing: [hit],
    });
    expect(() => runLaunchPreamble('hook', ['session-start'], h.deps)).toThrow(/exit\(0\)/);
    expect(h.execCalls[0].file).toBe(hit);
  });

  it('resolves an extensionless absolute pin to pin + ext on win32', () => {
    const pin = 'C:\\opt\\myco-dev\\myco-dev';
    const resolved = pin + '.cmd';
    const h = makeHarness({
      pin,
      platform: 'win32',
      existing: [resolved],
    });
    expect(() => runLaunchPreamble('hook', ['session-start'], h.deps)).toThrow(/exit\(0\)/);
    expect(h.execCalls[0].file).toBe(resolved);
  });

  it('leaves an absolute extensioned pin unchanged when it exists', () => {
    const pin = 'C:\\Program Files\\myco-dev\\myco.exe';
    const h = makeHarness({
      pin,
      platform: 'win32',
      existing: [pin],
    });
    expect(() => runLaunchPreamble('hook', ['session-start'], h.deps)).toThrow(/exit\(0\)/);
    expect(h.execCalls[0].file).toBe(pin);
  });

  it('falls back to the original pin when nothing resolves (ENOENT path still applies)', () => {
    const h = makeHarness({
      pin: 'myco-dev',
      platform: 'win32',
      pathDirs: ['C:\\nowhere'],
      existing: [], // nothing on disk
    });
    expect(() => runLaunchPreamble('hook', ['session-start'], h.deps)).toThrow(/exit\(0\)/);
    // Original bare alias is exec'd unchanged, so the existing ENOENT→exit(0)
    // guard governs the outcome exactly as before.
    expect(h.execCalls[0].file).toBe('myco-dev');
  });

  it('POSIX: never juggles extensions — a bare-alias pin is exec\'d verbatim', () => {
    const h = makeHarness({
      pin: 'myco-dev',
      platform: 'darwin',
      // existing/pathDirs present but must be ignored off-Windows.
      pathDirs: ['/usr/local/bin'],
      existing: ['/usr/local/bin/myco-dev.cmd'],
    });
    expect(() => runLaunchPreamble('hook', ['session-start'], h.deps)).toThrow(/exit\(0\)/);
    expect(h.execCalls[0].file).toBe('myco-dev');
  });

  it('POSIX: an absolute extensionless pin is exec\'d verbatim', () => {
    const pin = '/opt/myco-dev/bin/myco';
    const h = makeHarness({ pin, platform: 'darwin', existing: [pin + '.cmd'] });
    expect(() => runLaunchPreamble('hook', ['session-start'], h.deps)).toThrow(/exit\(0\)/);
    expect(h.execCalls[0].file).toBe(pin);
  });
});

describe('runLaunchPreamble — re-exec exit semantics', () => {
  it('propagates a numeric child status', () => {
    const h = makeHarness({
      pin: '/opt/myco-dev/bin/myco',
      execPath: '/usr/local/bin/myco',
      execResult: { status: 3 },
    });
    expect(() => runLaunchPreamble('hook', ['session-start'], h.deps)).toThrow(/exit\(3\)/);
  });

  it('ENOENT on a hook re-exec exits 0 (fail-open)', () => {
    const enoent = new Error('spawn ENOENT') as Error & { code: string };
    enoent.code = 'ENOENT';
    const h = makeHarness({
      pin: '/opt/myco-dev/bin/myco',
      execPath: '/usr/local/bin/myco',
      execResult: enoent,
    });
    expect(() => runLaunchPreamble('hook', ['session-start'], h.deps)).toThrow(/exit\(0\)/);
  });

  it('ENOENT on a tool re-exec exits 1', () => {
    const enoent = new Error('spawn ENOENT') as Error & { code: string };
    enoent.code = 'ENOENT';
    const h = makeHarness({
      pin: '/opt/myco-dev/bin/myco',
      execPath: '/usr/local/bin/myco',
      execResult: enoent,
    });
    expect(() => runLaunchPreamble('tool', ['call', 'x'], h.deps)).toThrow(/exit\(1\)/);
  });

  it('a signal/spawn failure (no numeric status) exits 0 for hook', () => {
    const h = makeHarness({
      pin: '/opt/myco-dev/bin/myco',
      execPath: '/usr/local/bin/myco',
      execResult: new Error('killed by signal'),
    });
    expect(() => runLaunchPreamble('hook', ['session-start'], h.deps)).toThrow(/exit\(0\)/);
  });

  it('a signal/spawn failure (no numeric status) exits 1 for mcp', () => {
    const h = makeHarness({
      pin: '/opt/myco-dev/bin/myco',
      execPath: '/usr/local/bin/myco',
      execResult: new Error('killed by signal'),
    });
    expect(() => runLaunchPreamble('mcp', [], h.deps)).toThrow(/exit\(1\)/);
  });
});
