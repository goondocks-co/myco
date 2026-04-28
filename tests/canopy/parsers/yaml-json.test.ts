import { describe, it, expect } from 'bun:test';
import { yamlJsonParser } from '@myco/canopy/parsers/yaml-json';

function input(content: string, path: string) {
  return { path, content, sizeBytes: Buffer.byteLength(content), lineCount: content.split(/\r?\n/).length };
}

describe('yamlJsonParser', () => {
  it('emits JSON top-level object keys as exports', () => {
    const out = yamlJsonParser(input(`{"name":"x","version":"1","scripts":{}}`, 'package.json'));
    expect(out.language).toBe('json');
    expect(out.exports.sort()).toEqual(['name', 'scripts', 'version']);
  });

  it('marks JSON arrays and primitives explicitly', () => {
    expect(yamlJsonParser(input(`[1,2,3]`, 'a.json')).exports).toEqual(['[array]']);
    expect(yamlJsonParser(input(`42`, 'a.json')).exports).toEqual(['[primitive]']);
  });

  it('returns empty exports for malformed JSON', () => {
    expect(yamlJsonParser(input(`{not: json,}`, 'a.json')).exports).toEqual([]);
  });

  it('emits column-zero YAML keys', () => {
    const out = yamlJsonParser(input(`name: foo\nversion: 1.0\nscripts:\n  build: tsc\n`, 'config.yaml'));
    expect(out.language).toBe('yaml');
    expect(out.exports.sort()).toEqual(['name', 'scripts', 'version']);
  });

  it('ignores YAML document markers and comments', () => {
    const out = yamlJsonParser(input(`---\n# comment\nkey: val\n...\n`, 'a.yml'));
    expect(out.exports).toEqual(['key']);
  });
});
