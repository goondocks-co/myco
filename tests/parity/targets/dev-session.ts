import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface Reply { id: string; url?: string; headers?: Record<string, string>; error?: string; results?: Array<{ results: Record<string, unknown>[] }>;records?:unknown[] }
const COMMAND_TIMEOUT_MS = 120_000;

interface Command { op: 'start' | 'sql' | 'stop' | 'close'|'read-trace'|'alarm'|'embedding'; tag?: string; sql?: string; config?: string; persist?: string; vars?: Record<string, string>;clockName?:string;at?:number;projectId?:string }

/** One Wrangler dev controller per shard; HTTP goes directly to its local workerd listener. */
export function devSession(serverDir: string) {
  const logDir = path.join(serverDir, '.wrangler');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `parity-dev-session-${process.pid}.log`);
  const providerLog = path.join(logDir, `parity-dev-session-${process.pid}-provider.log`);
  let output = '';
  let logFailure: string | undefined;
  let exitCode: number | null = null;
  const awaiting = new Map<string, { resolve(reply: Reply): void; reject(error: Error): void }>();
  const proc = Bun.spawn(['node', path.join(import.meta.dir, 'dev-session.mjs'), path.join(serverDir, 'package.json')], {
    cwd: os.tmpdir(), stdout: 'pipe', stderr: 'pipe', serialization: 'json', detached: true,
    env: { ...process.env, WRANGLER_LOG_PATH: providerLog, WRANGLER_SEND_METRICS: 'false' },
    ipc(message: Reply) {
      const waiter = awaiting.get(message.id);
      if (!waiter) return;
      awaiting.delete(message.id);
      if (message.error !== undefined) waiter.reject(new Error(message.error));
      else waiter.resolve(message);
    },
  });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    const append = (text: string) => {
      output = (output + text).slice(-64_000);
      try { fs.appendFileSync(logPath, text); }
      catch (error) { logFailure ??= String(error); }
    };
    for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
    append(decoder.decode());
  };
  const drained = Promise.all([proc.stdout, proc.stderr].map(stream => drain(stream).catch(error => { logFailure ??= String(error); })));
  void proc.exited.then(code => {
    exitCode = code;
    void drained.then(() => {
      for (const waiter of awaiting.values()) waiter.reject(new Error(`Wrangler dev controller exited ${code}\n${output}`));
      awaiting.clear();
    });
  });
  const kill = () => {
    if (process.platform === 'win32') { proc.kill(); return; }
    try { process.kill(-proc.pid, 'SIGKILL'); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
    }
  };
  const exit = () => {
    try { kill(); }
    catch (error) { console.error('Wrangler dev controller termination failed:', error); }
  };
  process.on('exit', exit);
  let termination: Promise<void> | undefined;
  const terminate = () => termination ??= (async () => {
    try {
      kill();
      await proc.exited;
      await drained;
    } finally { process.removeListener('exit', exit); }
  })();
  return {
    async command(command: Command): Promise<Reply> {
      if (exitCode !== null || termination !== undefined) throw new Error(`Wrangler dev controller is stopped (exit ${exitCode})\n${output}`);
      const id = crypto.randomUUID();
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await new Promise<Reply>((resolve, reject) => {
          timer = setTimeout(() => {
            awaiting.delete(id);
            const error = () => new Error(`Wrangler dev ${command.op} timed out\n${output}${logFailure === undefined ? '' : `\nlog sink failed: ${logFailure}`}`);
            void terminate().then(
              () => reject(error()),
              terminationError => reject(new AggregateError([error(), terminationError], 'Wrangler dev timeout cleanup failed')),
            );
          }, COMMAND_TIMEOUT_MS);
          awaiting.set(id, { resolve, reject });
          proc.send({ ...command, id });
        });
      } finally { clearTimeout(timer!); awaiting.delete(id); }
    },
    runtime: () => ({ alive: exitCode === null, exitCode, tail: output.slice(-16_000), ...(logFailure === undefined ? {} : { logFailure }) }),
    async close() {
      const errors: unknown[] = [];
      try { if (exitCode === null && termination === undefined) await this.command({ op: 'close' }); }
      catch (error) { errors.push(error); }
      try { await terminate(); }
      catch (error) { errors.push(error); }
      if (logFailure !== undefined) errors.push(new Error(`Wrangler dev log sink failed: ${logFailure}`));
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Wrangler dev shutdown failed');
    },
  };
}
