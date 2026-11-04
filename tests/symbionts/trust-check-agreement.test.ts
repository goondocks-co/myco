import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript-v6';

const root = path.resolve(import.meta.dir, '../..');
const copies = [
  ['packages/myco/src/paths/pin-trust.ts', 'checkPinTrust', 'PIN_INSECURE_MODE_MASK'],
  ['tests/fixtures/install/binary-resolution.cjs', 'checkPinTrust', 'PIN_INSECURE_MODE_MASK'],
  ['tests/fixtures/install/myco-run.cjs', 'checkRuntimePinTrust', 'RUNTIME_COMMAND_INSECURE_MODE_MASK'],
  ...['cline', 'opencode', 'pi'].map(agent => [
    `packages/myco/src/symbionts/templates/${agent}/plugin.ts`, 'readTrustedPin', 'RUNTIME_PIN_INSECURE_MODE_MASK',
  ]),
];

for (const [file, name, mask] of copies) it(`${file} refuses unsafe pins through its trust owner`, () => {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const owner = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  const constant = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(source) === mask));
  expect(owner).toBeDefined();
  expect(constant).toBeDefined();
  const code = ts.transpile(`${constant!.getText(source).replace(/^export /, '')}\n${owner!.getText(source).replace(/^export /, '')}\nanswer = ${name}('/pin');`);
  for (const [platform, uid, mode, symlink, missing, trusted] of [
    ['darwin', 42, 0o644, false, false, true],
    ['darwin', 41, 0o644, false, false, false],
    ['darwin', 42, 0o664, false, false, false],
    ['darwin', 42, 0o646, false, false, false],
    ['darwin', 42, 0o644, true, false, false],
    ['darwin', 42, 0o644, false, true, false],
    ['win32', 41, 0o666, true, false, true],
  ] as const) {
    const lstatSync = () => {
      if (missing) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { uid, mode, isSymbolicLink: () => symlink };
    };
    const readFileSync = () => '/trusted';
    const context = { fs: { lstatSync, readFileSync }, lstatSync, readFileSync, PIN_MISSING_REASON: 'pin file missing',
      process: { platform, getuid: () => 42 }, answer: undefined as unknown };
    vm.runInNewContext(code, context);
    expect({ platform, uid, mode, symlink, missing, trusted: name === 'readTrustedPin' ? context.answer === '/trusted' : (context.answer as { ok: boolean }).ok })
      .toEqual({ platform, uid, mode, symlink, missing, trusted });
  }
});
