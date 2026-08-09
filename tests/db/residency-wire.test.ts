/*
 * Copyright 2026 Myco Contributors
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */
/**
 * The residency wire codec — full fidelity, BLOB-safe. This is the pair that
 * replaced the team-SYNC sanitizer on the residency path: sync strips
 * local-only columns and never handled a BLOB, and residency (a lossless
 * round trip of your own project) can afford neither.
 */
import { describe, expect, test } from 'bun:test';
import { residencyEncodeRow, residencyDecodeRow } from '@myco/db/queries/residency-wire';

describe('residency wire codec', () => {
  test('a BLOB survives encode -> JSON -> decode byte-for-byte', () => {
    const data = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    const wire = JSON.parse(JSON.stringify(residencyEncodeRow('attachments', { id: 'a', data })));
    const back = residencyDecodeRow(wire);
    expect(Buffer.isBuffer(back.data) || back.data instanceof Uint8Array).toBe(true);
    expect(Buffer.from(back.data as Uint8Array).equals(Buffer.from(data))).toBe(true);
  });

  test('encode STRIPS NOTHING — every column, incl. nullable, passes through', () => {
    const row = { id: 'k', basis_ref: 'feat/x', basis_sha: 'abc', evidence_json: '{}', reason: null };
    expect(residencyEncodeRow('knowledge_release_state', row)).toEqual(row);
  });

  test('decode is idempotent on a row with no BLOB wrapper', () => {
    const row = { id: 'x', n: 7, s: 'hi', z: null };
    expect(residencyDecodeRow(row)).toEqual(row);
  });

  test('a real column value shaped like data is NOT mistaken for a BLOB wrapper', () => {
    // The tag is deliberately ungainly; a normal string/number column is untouched.
    const row = { id: 'x', payload: '{"0":1}', count: 3 };
    expect(residencyDecodeRow(residencyEncodeRow('t', row))).toEqual(row);
  });

  test('a Buffer encodes the same as the equivalent Uint8Array', () => {
    const bytes = [9, 8, 7];
    const a = residencyEncodeRow('t', { data: Buffer.from(bytes) });
    const b = residencyEncodeRow('t', { data: new Uint8Array(bytes) });
    expect(a).toEqual(b);
  });
});
