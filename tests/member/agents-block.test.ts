/**
 * The managed AGENTS.md block: one atomic replacement, the rest of the file
 * untouched, and a partial write that cannot corrupt the file.
 *
 * The write goes to a temporary file in the same directory and is renamed over
 * the target, so a fault mid-write leaves the original bytes standing. The
 * fault is injected at the one seam the writer exposes — the write of the
 * temporary — and the test reads the target back after it.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS_BLOCK_MAX_CHARS, AGENTS_MANAGED_END, AGENTS_MANAGED_START, managedBlockOf, renderManagedBlock, replaceManagedBlock } from '@goondocks/myco-shared/agents-block';
import { writeManagedBlock } from '@myco/runner/agents-block.js';

const PROJECT_TEXT = '# Project rules\n\nRun the tests before pushing.\n';
const OLD = renderManagedBlock('- old guidance');
const AFTER = '\n## Appendix\n\nKept as written.\n';

describe('replacing the managed block', () => {
  it('replaces the block between the markers and carries everything outside it byte for byte', () => {
    const file = `${PROJECT_TEXT}\n${OLD}${AFTER}`;
    const next = replaceManagedBlock(file, '- new guidance');
    expect(next).toBe(`${PROJECT_TEXT}\n${renderManagedBlock('- new guidance')}${AFTER}`);
    expect(managedBlockOf(next)).toBe('- new guidance');
    expect(next.startsWith(PROJECT_TEXT)).toBe(true);
    expect(next.endsWith(AFTER)).toBe(true);
  });

  it('appends a block to a file that has none, and writes one whole for an empty file', () => {
    expect(replaceManagedBlock('', '- first')).toBe(renderManagedBlock('- first'));
    expect(replaceManagedBlock(PROJECT_TEXT, '- first')).toBe(`${PROJECT_TEXT}\n${renderManagedBlock('- first')}`);
    expect(replaceManagedBlock('# Rules', '- first')).toBe(`# Rules\n\n${renderManagedBlock('- first')}`);
  });

  it('treats a stray opening marker with no close as no block, cutting nothing the project wrote', () => {
    const stray = `${PROJECT_TEXT}${AGENTS_MANAGED_START}\nunfinished\n`;
    const next = replaceManagedBlock(stray, '- new');
    expect(next.startsWith(stray)).toBe(true);
    expect(next.endsWith(renderManagedBlock('- new'))).toBe(true);
  });

  it('refuses a body past the ceiling rather than writing it', () => {
    expect(() => replaceManagedBlock(PROJECT_TEXT, 'x'.repeat(AGENTS_BLOCK_MAX_CHARS + 1))).toThrow(RangeError);
    expect(managedBlockOf(replaceManagedBlock(PROJECT_TEXT, 'x'.repeat(AGENTS_BLOCK_MAX_CHARS)))).toHaveLength(AGENTS_BLOCK_MAX_CHARS);
    expect(managedBlockOf(`${AGENTS_MANAGED_START}\nbody\n${AGENTS_MANAGED_END}`)).toBe('body');
    expect(managedBlockOf('no block')).toBeNull();
  });
});

describe('writing the managed block to disk', () => {
  it('writes the replacement over the file in one rename and answers whether anything changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-agents-block-'));
    const path = join(dir, 'AGENTS.md');
    writeFileSync(path, `${PROJECT_TEXT}\n${OLD}${AFTER}`);
    expect(writeManagedBlock(path, '- new guidance')).toEqual({ changed: true });
    expect(readFileSync(path, 'utf8')).toBe(`${PROJECT_TEXT}\n${renderManagedBlock('- new guidance')}${AFTER}`);
    expect(writeManagedBlock(path, '- new guidance')).toEqual({ changed: false });
    // Nothing of the staging is left beside the file.
    expect(readdirSync(dir)).toEqual(['AGENTS.md']);
  });

  it('creates the file where none exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-agents-block-'));
    const path = join(dir, 'AGENTS.md');
    expect(writeManagedBlock(path, '- first')).toEqual({ changed: true });
    expect(readFileSync(path, 'utf8')).toBe(renderManagedBlock('- first'));
  });

  it('leaves the original bytes standing when the write fails part way, and leaves no staging behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-agents-block-'));
    const path = join(dir, 'AGENTS.md');
    const original = `${PROJECT_TEXT}\n${OLD}${AFTER}`;
    writeFileSync(path, original);
    // The fault: half the bytes land in the temporary, then the disk gives out.
    const halfWrite = (file: string, text: string): void => {
      writeFileSync(file, text.slice(0, Math.floor(text.length / 2)), 'utf8');
      throw new Error('ENOSPC: no space left on device');
    };
    expect(() => writeManagedBlock(path, '- new guidance', halfWrite)).toThrow('ENOSPC');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readdirSync(dir)).toEqual(['AGENTS.md']);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
  });
});
