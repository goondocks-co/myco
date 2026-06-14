import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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

  it('does NOT re-exec when the pin is bare "myco" (resolves to self)', () => {
    const h = makeHarness({ pin: 'myco', execPath: '/usr/local/bin/myco' });
    expect(() => runLaunchPreamble('tool', ['call', 'myco_search'], h.deps)).not.toThrow();
    expect(h.execCalls).toHaveLength(0);
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
