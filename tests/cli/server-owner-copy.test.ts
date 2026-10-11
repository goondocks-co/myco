import { expect, it } from 'bun:test';
import { run } from '@myco/cli/server.js';

for (const target of ['cloudflare', 'local']) {
  it(`setup-owner ${target} names expiry recovery and signing each machine in`, async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...parts) => { lines.push(parts.join(' ')); };
    const answer = { memberId: 'mem_fixture', url: 'https://fixture.invalid/link#private', expiresAt: Date.now() + 900_000 };
    try {
      await run(['setup-owner', '--target', target, '--account-id', 'a'.repeat(32)], {
        cloudflareOwner: async () => answer,
        localOwner: async () => answer,
      });
    } finally { console.log = log; }
    const text = lines.join('\n');
    expect(text).toContain('expires in 15 minutes');
    expect(text).toContain(`myco server setup-owner --target ${target} again`);
    expect(text).toContain('Then on each machine you use: myco login https://fixture.invalid.');
    expect(text).not.toContain('invite this machine');
    if (target === 'local') {
      expect(text).toContain('myco server uninstall --target local');
      expect(text).toContain('myco server install --target local');
    }
  });
}
