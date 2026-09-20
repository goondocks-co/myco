import { describe, it, expect, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStdin, setBufferedStdin } from '@myco/hooks/read-stdin.js';

const STDIN_CHILD_TIMEOUT_MS = 4_000;

function spawnReadStdinChild(body = `
    const data = await readStdin();
    process.stdout.write(JSON.stringify({ data }));
  `) {
  const moduleUrl = pathToFileURL(path.resolve('packages/myco/src/hooks/read-stdin.ts')).href;
  const script = `
    import { readStdin, setBufferedStdin } from ${JSON.stringify(moduleUrl)};
    ${body}
  `;

  // Under bun test, process.execPath is bun itself — which accepts TypeScript
  // files natively and runs `-e <script>` as an ES module. Under node test
  // runs we fall back to the tsx-import path.
  const isBun = typeof (process as unknown as { isBun?: boolean }).isBun !== 'undefined'
    || process.execPath.endsWith('bun') || process.execPath.endsWith('bun.exe');
  const args = isBun
    ? ['-e', script]
    : ['--import', 'tsx', '--input-type=module', '-e', script];

  return spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: STDIN_CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
}

async function collect(child: ReturnType<typeof spawn>) {
  let stdout = '';
  let stderr = '';

  if (!child.stdout || !child.stderr) throw new Error('the child was spawned without piped output');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  return { code, stdout, stderr };
}

describe('setBufferedStdin', () => {
  afterEach(() => { setBufferedStdin(null); });

  it('returns the injected buffer before touching fd 0', async () => {
    const payload = JSON.stringify({ workspacePaths: ['/tmp/x'] });
    setBufferedStdin(Buffer.from(payload, 'utf-8'));
    expect(await readStdin()).toBe(payload);
  });

  it('clears the injected buffer after one read', async () => {
    const child = spawnReadStdinChild(`
      setBufferedStdin(Buffer.from('{"a":1}', 'utf-8'));
      const buffered = await readStdin();
      const fallback = await readStdin();
      process.stdout.write(JSON.stringify({ buffered, fallback }));
    `);
    child.stdin.end('{"b":2}');

    const result = await collect(child);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ buffered: '{"a":1}', fallback: '{"b":2}' });
  });

  it('clearing with null removes a previously injected buffer', async () => {
    const child = spawnReadStdinChild(`
      setBufferedStdin(Buffer.from('{"a":1}', 'utf-8'));
      setBufferedStdin(null);
      const data = await readStdin();
      process.stdout.write(JSON.stringify({ data }));
    `);
    child.stdin.end('{"b":2}');

    const result = await collect(child);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ data: '{"b":2}' });
  });
});

describe('readStdin', () => {
  it('returns {} when stdin ends without any bytes', async () => {
    const child = spawnReadStdinChild();
    child.stdin.end();

    const result = await collect(child);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ data: '{}' });
  });

  it('waits for a delayed first chunk and returns the full payload', async () => {
    const child = spawnReadStdinChild();
    const payload = JSON.stringify({
      conversation_id: 'chunked-session',
      prompt: 'x'.repeat(2000),
      transcript_path: '/tmp/chunked.jsonl',
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    child.stdin.write(payload);
    child.stdin.end();

    const result = await collect(child);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ data: payload });
  });
});
