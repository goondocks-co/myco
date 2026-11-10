import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-v6';
import { sourceProgram } from '../../helpers/source-program.js';

it('hooks cannot import any session-state writer through aliases, namespaces or re-exports', () => {
  const root = path.resolve(import.meta.dir, '../../../packages/myco/src');
  const state = path.join(root, 'member/session-state.ts');
  const hooks = fs.readdirSync(path.join(root, 'hooks'), { recursive: true }).map(String)
    .filter(file => file.endsWith('.ts')).map(file => path.join(root, 'hooks', file));
  expect(hooks.length).toBeGreaterThan(0);
  const graph = sourceProgram([...hooks, state]);
  const source = graph.program.getSourceFile(state)!;
  expect(source).toBeDefined();
  const writers = new Set(source.statements.filter(node => ts.isFunctionDeclaration(node)
    && graph.reaches(node, (call) => /^(writePrivateFileAtomic|fs\.unlinkSync)$/.test(call.expression.getText()))));
  expect(writers.size).toBeGreaterThan(0);
  const offenders: string[] = [];
  for (const file of hooks) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && writers.has(graph.declaration(node) as ts.FunctionDeclaration)) offenders.push(path.relative(root, file) + ':' + node.text);
      ts.forEachChild(node, visit);
    };
    visit(graph.program.getSourceFile(file)!);
  }
  expect(offenders).toEqual([]);
});
