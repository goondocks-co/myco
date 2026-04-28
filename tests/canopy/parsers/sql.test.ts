import { describe, it, expect } from 'bun:test';
import { sqlParser } from '@myco/canopy/parsers/sql';

function input(content: string, path = 'a.sql') {
  return { path, content, sizeBytes: Buffer.byteLength(content), lineCount: content.split(/\r?\n/).length };
}

describe('sqlParser', () => {
  it('emits CREATE TABLE / INDEX / VIEW / TRIGGER targets', () => {
    const out = sqlParser(input(`
      CREATE TABLE IF NOT EXISTS users (id INTEGER);
      CREATE UNIQUE INDEX users_email ON users (email);
      CREATE VIEW recent AS SELECT * FROM users;
      CREATE TRIGGER bump AFTER INSERT ON users BEGIN END;
    `));
    expect(out.language).toBe('sql');
    expect(out.exports).toContain('table:users');
    expect(out.exports).toContain('index:users_email');
    expect(out.exports).toContain('view:recent');
    expect(out.exports).toContain('trigger:bump');
  });

  it('emits ALTER TABLE targets', () => {
    const out = sqlParser(input(`ALTER TABLE users ADD COLUMN created_at INTEGER;`));
    expect(out.exports).toContain('alter:users');
  });

  it('ignores commented-out statements (line and block)', () => {
    const out = sqlParser(input(`
      -- CREATE TABLE ghost (id INTEGER);
      /* CREATE TABLE phantom (id INTEGER); */
      CREATE TABLE real (id INTEGER);
    `));
    expect(out.exports).toContain('table:real');
    expect(out.exports).not.toContain('table:ghost');
    expect(out.exports).not.toContain('table:phantom');
  });

  it('strips quote/backtick wrappers on identifiers', () => {
    const out = sqlParser(input(`CREATE TABLE "Quoted" (id INT);\nCREATE TABLE \`backtick\` (id INT);`));
    expect(out.exports).toContain('table:Quoted');
    expect(out.exports).toContain('table:backtick');
  });
});
