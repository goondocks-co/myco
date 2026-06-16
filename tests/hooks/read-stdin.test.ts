import { describe, it, expect, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStdin, setBufferedStdin } from '@myco/hooks/read-stdin.js';

function spawnReadStdinChild() {
  const moduleUrl = pathToFileURL(path.resolve('packages/myco/src/hooks/read-stdin.ts')).href;
  const script = `
    import { readStdin } from ${JSON.stringify(moduleUrl)};
    const data = await readStdin();
    process.stdout.write(JSON.stringify({ data }));
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
  });
}

async function collect(child: ReturnType<typeof spawn>) {
  let stdout = '';
  let stderr = '';

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
    setBufferedStdin(Buffer.from('{"a":1}', 'utf-8'));
    expect(await readStdin()).toBe('{"a":1}');
    // Second read must fall through to fd 0; under bun test fd 0 is empty/closed,
    // so the fall-through path coerces to '{}'.
    expect(await readStdin()).toBe('{}');
  });

  it('clearing with null removes a previously injected buffer', async () => {
    setBufferedStdin(Buffer.from('{"a":1}', 'utf-8'));
    setBufferedStdin(null);
    expect(await readStdin()).toBe('{}');
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
