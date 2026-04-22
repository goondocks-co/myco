import { describe, it, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function spawnReadStdinChild() {
  const moduleUrl = pathToFileURL(path.resolve('packages/myco/src/hooks/read-stdin.ts')).href;
  const script = `
    import { readStdin } from ${JSON.stringify(moduleUrl)};
    const data = await readStdin();
    process.stdout.write(JSON.stringify({ data }));
  `;

  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
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

describe('readStdin', () => {
  // TODO(bun-migration): see vault spore decision-754d7dd5 — child-process stdin timing differs under bun test.
  it.skip('returns {} when stdin ends without any bytes', async () => {
    const child = spawnReadStdinChild();
    child.stdin.end();

    const result = await collect(child);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ data: '{}' });
  });

  // TODO(bun-migration): see vault spore decision-754d7dd5 — child-process stdin timing differs under bun test.
  it.skip('waits for a delayed first chunk and returns the full payload', async () => {
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
