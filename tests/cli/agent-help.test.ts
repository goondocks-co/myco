import { afterEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';

const connectToDaemon = vi.fn(async () => ({
  get: vi.fn(),
  post: vi.fn(async () => ({ ok: true, data: {} })),
  delete: vi.fn(),
}));

mock.module('@myco/cli/shared.js', () => ({
  connectToDaemon,
  isHelpRequest: (args: readonly string[]) => args.includes('--help') || args.includes('-h'),
  printHelpIfRequested: (args: readonly string[], usage: string) => {
    if (!args.includes('--help') && !args.includes('-h')) return false;
    process.stdout.write(usage);
    return true;
  },
}));

describe('agent CLI help', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    connectToDaemon.mockClear();
  });

  it('prints agent help without connecting to the daemon', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { run } = await import('@myco/cli/agent-run.js');

    await run(['--help'], '/tmp/myco-test-vault');

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: myco agent'));
    expect(connectToDaemon).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it('prints task help without treating --help as an unknown subcommand', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as unknown as typeof process.exit;
    const { run } = await import('@myco/cli/agent-tasks.js');

    await run(['--help'], '/tmp/myco-test-vault');

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: myco task'));
    expect(connectToDaemon).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints task run help without dispatching an agent run', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { run } = await import('@myco/cli/agent-tasks.js');

    await run(['run', '--help'], '/tmp/myco-test-vault');

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: myco task run'));
    expect(connectToDaemon).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});
