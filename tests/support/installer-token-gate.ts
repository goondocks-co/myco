import { expect } from 'bun:test';

export function assertTokenFree(value: string, tokens: readonly string[]) {
  expect(tokens.filter(Boolean).some(token => value.includes(token)), 'output must contain no credentials').toBe(false);
}

export function assertPrivate(calls: { argv: string[]; config: string }[], token: string) {
  for (const call of calls) {
    assertTokenFree(call.argv.join('\n'), [token]);
    expect(call.argv[0] === '-q', 'curl must disable implicit config first').toBe(true);
    expect(call.argv.includes('--config'), 'curl must read explicit config').toBe(true);
    expect(call.argv[call.argv.indexOf('--config') + 1] === '-', 'config must arrive on stdin').toBe(true);
    expect(call.argv.includes('Accept: application/vnd.github+json')).toBe(true);
    expect(call.argv.includes('User-Agent: myco-installer/goondocks-co/myco')).toBe(true);
    const escaped = token.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    expect(call.config === (token ? `header = "Authorization: Bearer ${escaped}"\n` : ''), 'config must carry the expected authorization').toBe(true);
  }
}
