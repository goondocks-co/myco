import { describe, expect, test } from 'bun:test';
import { unzipSync, strFromU8 } from 'fflate';
import { createZip } from '../../../packages/myco/src/capture/diagnostics/zip.js';

describe('createZip', () => {
  test('round-trips string and binary entries', () => {
    const zipped = createZip([
      { path: 'manifest.json', data: '{"bundle_format":1}' },
      { path: 'buffers/a.jsonl', data: new Uint8Array([104, 105]) },
    ]);
    const out = unzipSync(zipped);
    expect(strFromU8(out['manifest.json']!)).toBe('{"bundle_format":1}');
    expect(strFromU8(out['buffers/a.jsonl']!)).toBe('hi');
  });
});
