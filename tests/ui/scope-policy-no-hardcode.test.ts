import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const UI_SRC = path.join(__dirname, '../../packages/myco/ui/src');
// Match the JSX-prop-assignment form (defaultScope={…} / lockScope="…" /
// allowPersonal={…}) so the gate catches the actual scope props without
// flagging unrelated identifiers like the provider-secrets `defaultScope:
// SecretScope` API-contract field.
const BANNED = /\b(defaultScope|lockScope|allowPersonal)=/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('scope flows from the registry, never hard-coded props', () => {
  it('no defaultScope/lockScope/allowPersonal anywhere in UI src', () => {
    const offenders = walk(UI_SRC).filter((f) => BANNED.test(fs.readFileSync(f, 'utf-8')));
    expect(offenders.map((f) => path.relative(UI_SRC, f))).toEqual([]);
  });
});
