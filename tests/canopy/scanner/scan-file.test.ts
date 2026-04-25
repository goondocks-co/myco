import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanFile } from '@myco/canopy/scanner/scan-file';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-scan-file-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(relPath: string, content: string | Buffer) {
  const abs = path.join(tmp, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const baseOpts = () => ({
  projectId: 'p1',
  machineId: 'local',
  projectRoot: tmp,
  now: 1_700_000_000,
});

describe('scanFile', () => {
  it('produces a CanopyEntry for a small TypeScript file', () => {
    write('src/a.ts', 'export const x = 1;\n');
    const r = scanFile({ ...baseOpts(), relPath: 'src/a.ts' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.path).toBe('src/a.ts');
    expect(r.entry.language).toBe('typescript');
    expect(r.entry.size_bytes).toBeGreaterThan(0);
    expect(r.entry.line_count).toBe(1);
    expect(r.entry.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(r.entry.exports_json!)).toContain('x');
    expect(r.entry.mechanical_updated_at).toBe(1_700_000_000);
    expect(r.entry.llm_description).toBeNull();
  });

  it('skips files larger than maxBytes', () => {
    write('big.ts', 'x'.repeat(100));
    const r = scanFile({ ...baseOpts(), relPath: 'big.ts', maxBytes: 50 });
    expect(r).toEqual({ ok: false, reason: 'too_large' });
  });

  it('skips binary content (NUL byte in prefix)', () => {
    write('blob.bin', Buffer.from([0x68, 0x00, 0x65]));
    const r = scanFile({ ...baseOpts(), relPath: 'blob.bin' });
    expect(r).toEqual({ ok: false, reason: 'binary' });
  });

  it('skips symlinks', () => {
    write('real.txt', 'hello\n');
    fs.symlinkSync(path.join(tmp, 'real.txt'), path.join(tmp, 'link.txt'));
    const r = scanFile({ ...baseOpts(), relPath: 'link.txt' });
    expect(r).toEqual({ ok: false, reason: 'symlink' });
  });

  it('reports missing files as missing', () => {
    const r = scanFile({ ...baseOpts(), relPath: 'nope.ts' });
    expect(r).toEqual({ ok: false, reason: 'missing' });
  });

  it('emits null exports_json/imports_json when arrays are empty', () => {
    write('notes.md', '# hello\n');
    const r = scanFile({ ...baseOpts(), relPath: 'notes.md' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.exports_json).toBeNull();
    expect(r.entry.imports_json).toBeNull();
    expect(r.entry.top_comment).toContain('hello');
  });
});
