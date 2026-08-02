import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SchemaVersionTooNewError } from '@myco/db/schema.js';
import {
  clearSchemaRefusalMarker,
  handleBootSchemaRefusal,
  readSchemaRefusalMarker,
  schemaRefusalMarkerPath,
  writeSchemaRefusalMarker,
} from '@myco/daemon/schema-refusal.js';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-schema-refusal-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('schema refusal marker', () => {
  it('round-trips write/read and clears', () => {
    const written = writeSchemaRefusalMarker(stateDir, {
      found: 80,
      supported: 76,
      binary_version: '1.3.0',
    });
    expect(written.refused_at).toBeGreaterThan(0);

    const read = readSchemaRefusalMarker(stateDir);
    expect(read).toEqual(written);

    clearSchemaRefusalMarker(stateDir);
    expect(readSchemaRefusalMarker(stateDir)).toBeNull();
    // Clearing an already-clear dir is a no-op, not an error.
    clearSchemaRefusalMarker(stateDir);
  });

  it('returns null for a missing or malformed marker', () => {
    expect(readSchemaRefusalMarker(stateDir)).toBeNull();
    fs.writeFileSync(schemaRefusalMarkerPath(stateDir), 'not json');
    expect(readSchemaRefusalMarker(stateDir)).toBeNull();
    fs.writeFileSync(schemaRefusalMarkerPath(stateDir), JSON.stringify({ found: 'x' }));
    expect(readSchemaRefusalMarker(stateDir)).toBeNull();
  });

  it('creates the state dir if needed and leaves no temp file behind', () => {
    const nested = path.join(stateDir, 'deeper', 'state');
    writeSchemaRefusalMarker(nested, { found: 80, supported: 76, binary_version: '1.3.0' });
    expect(readSchemaRefusalMarker(nested)).not.toBeNull();
    expect(fs.existsSync(`${schemaRefusalMarkerPath(nested)}.tmp`)).toBe(false);
  });
});

describe('handleBootSchemaRefusal', () => {
  it('writes the marker, emits one stderr line, and exits 0', () => {
    const err = new SchemaVersionTooNewError(80, 76);
    const stderrLines: string[] = [];
    let exitCode: number | null = null;

    class ExitSignal extends Error {}
    expect(() =>
      handleBootSchemaRefusal(err, stateDir, '1.3.0', {
        exit: (code: number): never => {
          exitCode = code;
          throw new ExitSignal();
        },
        stderr: (line) => stderrLines.push(line),
      }),
    ).toThrow(ExitSignal);

    expect(exitCode).toBe(0);
    expect(stderrLines.length).toBe(1);
    expect(stderrLines[0]).toContain('refusing to start');
    expect(stderrLines[0]).toContain('v80');
    expect(stderrLines[0]).toContain('v76');
    expect(stderrLines[0]).toContain('has not been modified');

    const marker = readSchemaRefusalMarker(stateDir);
    expect(marker?.found).toBe(80);
    expect(marker?.supported).toBe(76);
    expect(marker?.binary_version).toBe('1.3.0');
  });

  it('refreshes refused_at on repeated refusals (marker written before exit)', () => {
    const err = new SchemaVersionTooNewError(80, 76);
    const io = {
      exit: (): never => {
        throw new Error('exit');
      },
      stderr: () => {},
    };
    expect(() => handleBootSchemaRefusal(err, stateDir, '1.3.0', io)).toThrow('exit');
    const first = readSchemaRefusalMarker(stateDir);
    expect(() => handleBootSchemaRefusal(err, stateDir, '1.3.1', io)).toThrow('exit');
    const second = readSchemaRefusalMarker(stateDir);
    expect(first).not.toBeNull();
    expect(second?.binary_version).toBe('1.3.1');
    expect(second!.refused_at).toBeGreaterThanOrEqual(first!.refused_at);
  });
});
