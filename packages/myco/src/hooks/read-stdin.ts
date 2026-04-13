import { STDIN_TIMEOUT_MS } from '../constants.js';

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk: Buffer) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data || '{}'), STDIN_TIMEOUT_MS);
  });
}
