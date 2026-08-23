/**
 * The two self-hosted adapters that carry security properties, driven directly.
 *
 * Source identity and rate limiting are the only things metering traffic before a
 * credential is checked. Both are asserted here against the adapter itself rather
 * than through a stubbed `sourceOf`, so a change that weakens either fails by name.
 */
import { describe, it, expect } from 'bun:test';
import { trustedProxySourceOf } from '@myco-server-worker/platform/bun/source.js';
import { cloudflareSourceOf } from '@myco-server-worker/platform/cloudflare/source.js';
import { inProcessRateLimiter } from '@myco-server-worker/platform/bun/limiter.js';
import { diskBlobStore, sweepPartialObjects, DIGEST_MISMATCH_MESSAGE } from '@myco-server-worker/platform/bun/blobs.js';
import { classifyR2BlobFailure } from '@myco-server-worker/platform/cloudflare/env.js';
import { classifyBlobFailureOf } from '@myco-server-worker/platform/bun/env.js';
import { classifyBlobStore } from '@myco-server-worker/telemetry.js';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const withHeader = (name: string, value: string) => new Request('https://s/events', { headers: { [name]: value } });

describe('source identity behind a trusted proxy', () => {
  const identify = trustedProxySourceOf({ header: 'x-forwarded-for' });

  it('establishes no identity when the operator declared no trusted header', () => {
    expect(trustedProxySourceOf({})(withHeader('x-forwarded-for', '203.0.113.9'))).toBeNull();
    expect(trustedProxySourceOf({ header: '' })(withHeader('x-forwarded-for', '203.0.113.9'))).toBeNull();
  });

  it('establishes no identity when the declared header is absent or empty', () => {
    expect(identify(new Request('https://s/events'))).toBeNull();
    expect(identify(withHeader('x-forwarded-for', ''))).toBeNull();
  });

  it('takes the address the trusted proxy observed, not the one the caller prepended', () => {
    // The common proxy configurations APPEND, so the left-most entry is caller-authored.
    expect(identify(withHeader('x-forwarded-for', 'ATTACKER-CHOSEN, 203.0.113.9'))).toBe('203.0.113.9');
    expect(identify(withHeader('x-forwarded-for', '203.0.113.9'))).toBe('203.0.113.9');
  });

  it('steps back exactly as many hops as the operator declares', () => {
    const behindTwo = trustedProxySourceOf({ header: 'x-forwarded-for', trustedHops: 2 });
    expect(behindTwo(withHeader('x-forwarded-for', '203.0.113.9, 10.0.0.1, 10.0.0.2'))).toBe('10.0.0.1');
  });

  it('yields no identity for text that is not an address, however long', () => {
    expect(identify(withHeader('x-forwarded-for', 'not-an-address'))).toBeNull();
    expect(identify(withHeader('x-forwarded-for', 'A'.repeat(8000)))).toBeNull();
    expect(identify(withHeader('x-forwarded-for', Array(64).fill('203.0.113.9').join(',')))).toBeNull();
  });

  it('reduces an address to the same key space as the hosted target', () => {
    expect(identify(withHeader('x-forwarded-for', '2001:db8:1:2:3:4:5:6'))).toBe('2001:db8:1:2::/64');
    expect(cloudflareSourceOf(withHeader('cf-connecting-ip', '2001:db8:1:2:3:4:5:6'))).toBe('2001:db8:1:2::/64');
    expect(identify(withHeader('x-forwarded-for', '::ffff:203.0.113.9')))
      .toBe(cloudflareSourceOf(withHeader('cf-connecting-ip', '::ffff:203.0.113.9')));
  });
});

describe('the in-process rate limiter', () => {
  const at = { now: 0 };
  const limiter = (over: Partial<Parameters<typeof inProcessRateLimiter>[0]> = {}) =>
    inProcessRateLimiter({ limit: 5, periodMs: 1_000, now: () => at.now, ...over });
  const admitted = async (l: ReturnType<typeof limiter>, key: string, times: number) => {
    let count = 0;
    for (let i = 0; i < times; i++) if ((await l.limit({ key })).success) count += 1;
    return count;
  };

  it('admits exactly the limit within one window and refuses beyond it', async () => {
    at.now = 0;
    expect(await admitted(limiter(), 'k', 10)).toBe(5);
  });

  it('meters each key independently', async () => {
    at.now = 0;
    const l = limiter();
    expect(await admitted(l, 'a', 5)).toBe(5);
    expect(await admitted(l, 'b', 5)).toBe(5);
    expect((await l.limit({ key: 'a' })).success).toBe(false);
  });

  it('does not admit a second full allowance by timing requests across the boundary', async () => {
    at.now = 0;
    const l = limiter();
    at.now = 999;
    const before = await admitted(l, 'k', 10);
    at.now = 1_001;
    expect(before + (await admitted(l, 'k', 10))).toBeLessThan(10);
  });

  it('recovers the full allowance once a whole window has elapsed', async () => {
    at.now = 0;
    const l = limiter();
    expect(await admitted(l, 'k', 10)).toBe(5);
    at.now = 5_000;
    expect(await admitted(l, 'k', 10)).toBe(5);
  });

  it('refuses rather than admits once the tracked key space is full', async () => {
    at.now = 0;
    const l = limiter({ maxKeys: 3 });
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await l.limit({ key: `key-${i}` })).success);
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('costs no more for keys that never repeat than for one that always does', async () => {
    at.now = 0;
    const l = limiter({ limit: 1_000_000, periodMs: 60_000, maxKeys: 50_000 });
    const time = async (key: (i: number) => string) => {
      const started = Bun.nanoseconds();
      for (let i = 0; i < 20_000; i++) await l.limit({ key: key(i) });
      return Bun.nanoseconds() - started;
    };
    const rotating = await time((i) => `rotating-${i}`);
    const repeated = await time(() => 'repeated');
    // A reclaim sweep on every miss makes rotating keys quadratic; this bounds the
    // ratio far below the ~445x that shape produced.
    expect(rotating / repeated).toBeLessThan(20);
  });
});

describe('the disk blob store', () => {
  const root = () => mkdtempSync(join(tmpdir(), 'myco-blobstore-'));
  const openDescriptors = () => readdirSync('/dev/fd').length;

  it('refuses a key that escapes the store root instead of reporting it absent', async () => {
    const store = diskBlobStore(root());
    for (const key of ['../../escape', 'a/../../escape']) {
      await expect(store.head(key)).rejects.toThrow(/escapes the store root/);
      await expect(store.get(key)).rejects.toThrow(/escapes the store root/);
    }
  });

  it('reports a genuinely absent object as absent', async () => {
    const store = diskBlobStore(root());
    expect(await store.head('proj_1/deadbeef')).toBeNull();
    expect(await store.get('proj_1/deadbeef')).toBeNull();
  });

  it('raises a read fault rather than reporting the object absent', async () => {
    // Presenting a recoverable storage fault as "this object does not exist" is
    // indistinguishable from data loss on a surface whose job is preservation.
    if (process.getuid?.() === 0) return;
    const dir = root();
    const store = diskBlobStore(dir);
    mkdirSync(join(dir, 'proj_1'));
    writeFileSync(join(dir, 'proj_1', 'abc'), 'bytes');
    chmodSync(join(dir, 'proj_1'), 0o000);
    try {
      await expect(store.head('proj_1/abc')).rejects.toThrow();
    } finally {
      chmodSync(join(dir, 'proj_1'), 0o700);
    }
  });

  it('holds no descriptor open for a body nothing ever reads', async () => {
    const dir = root();
    const store = diskBlobStore(dir);
    const bytes = new TextEncoder().encode('contract bytes');
    await store.put('proj_1/abc', new Response(bytes).body, {});
    const before = openDescriptors();
    for (let i = 0; i < 200; i++) await store.get('proj_1/abc');
    expect(openDescriptors() - before).toBeLessThan(50);
  });

  it('reclaims temporary objects a killed process left behind, and nothing else', async () => {
    const dir = root();
    mkdirSync(join(dir, 'proj_1'), { recursive: true });
    writeFileSync(join(dir, 'proj_1', 'abc'), 'kept');
    writeFileSync(join(dir, 'proj_1', 'abc.11111111.partial'), 'stranded');
    expect(await sweepPartialObjects(dir)).toBe(1);
    expect(readdirSync(join(dir, 'proj_1'))).toEqual(['abc']);
  });

  it('sweeps a store directory that does not exist yet without failing', async () => {
    expect(await sweepPartialObjects(join(root(), 'not-created'))).toBe(0);
  });
});

describe('digest rejection is recognised by each store\'s own platform', () => {
  // Shared code matches no message text, so if a platform stops recognising its own
  // store's wording a mismatch classifies as a generic failure, is rethrown, and the
  // member retries a permanently-bad upload forever. These pin both recognisers.
  const CAPTURED_HOSTED_FAILURES = [
    'put: The SHA-256 checksum you specified did not match what we received. (10037)',
    'The SHA-256 checksum you specified did not match what we received.',
    'R2 put failed (10037)',
  ];

  it('recognises the hosted store\'s rejection by code and by wording', () => {
    for (const message of CAPTURED_HOSTED_FAILURES) {
      expect({ message, classified: classifyR2BlobFailure(message) }).toEqual({ message, classified: 'digest' });
      expect({ message, classified: classifyBlobStore(new Error(message), classifyR2BlobFailure) }).toEqual({ message, classified: 'digest' });
    }
  });

  it('recognises the self-hosted store\'s own rejection', () => {
    expect(classifyBlobStore(new Error(DIGEST_MISMATCH_MESSAGE), classifyBlobFailureOf)).toBe('digest');
  });

  it('leaves shared code matching no message text of its own', () => {
    for (const message of [...CAPTURED_HOSTED_FAILURES, DIGEST_MISMATCH_MESSAGE]) {
      expect({ message, classified: classifyBlobStore(new Error(message)) }).toEqual({ message, classified: 'other' });
    }
  });

  it('classifies an unrelated failure as generic on both platforms', () => {
    for (const recogniser of [classifyR2BlobFailure, classifyBlobFailureOf]) {
      expect(classifyBlobStore(new Error('connection reset'), recogniser)).toBe('other');
    }
  });
});
