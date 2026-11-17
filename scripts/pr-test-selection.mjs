import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const isTestFile = file => /^tests\/.*\.test\.[cm]?[jt]sx?$/.test(file);
const MODULE_FILE = /\.[cm]?[jt]sx?$/;
const INDEX_FILE = /(?:^|\/)index\.[cm]?[jt]sx?$/;
const require = createRequire(import.meta.url);
let compiler;

/** Static imports, one re-exporting index, one non-test module under tests/, and a changed JSON file a test imports. */
export function affectedTests({ root, files, changed }) {
  const ts = compiler ??= require('typescript-v6');
  const relative = file => path.relative(root, file).split(path.sep).join('/');
  const changedSet = new Set(changed);
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const converted = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, root);
  if (converted.errors.length) throw new Error(converted.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  const options = { ...converted.options, baseUrl: converted.options.baseUrl ?? root, paths: {
    ...converted.options.paths,
    '@goondocks/myco-shared/*': ['packages/myco-shared/src/*'],
  } };
  const host = { ...ts.sys, fileExists: file => ts.sys.fileExists(file) || changedSet.has(relative(file)) };
  const cache = ts.createModuleResolutionCache(root, file => file, options);
  const dependencies = new Map();
  const exports = new Map();
  for (const file of files.filter(file => MODULE_FILE.test(file) && fs.existsSync(path.join(root, file)))) {
    const absolute = path.join(root, file);
    const text = fs.readFileSync(absolute, 'utf8');
    const resolve = specifier => {
      const resolved = ts.resolveModuleName(specifier, absolute, options, host, cache).resolvedModule;
      return resolved && relative(resolved.resolvedFileName);
    };
    dependencies.set(file, new Set(ts.preProcessFile(text, true, true).importedFiles.map(imported => resolve(imported.fileName)).filter(Boolean)));
    if (INDEX_FILE.test(file) && !file.startsWith('tests/')) {
      const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
      exports.set(file, new Set(tree.statements.filter(node => ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        .map(node => resolve(node.moduleSpecifier.text)).filter(Boolean)));
    }
  }
  const source = new Set(changed.filter(file => !file.startsWith('tests/') && MODULE_FILE.test(file)));
  const intersects = (imports, targets) => [...imports].some(file => targets.has(file));
  const throughIndex = new Set([...exports].filter(([, imports]) => intersects(imports, source)).map(([file]) => file));
  const direct = new Set([...source, ...changed.filter(file => file.startsWith('tests/') && !isTestFile(file))]);
  // A test that imports a changed JSON file (a duration table, a recorded workload) runs with the changed tests.
  const data = new Set(changed.filter(file => file.endsWith('.json')));
  const affected = new Set([...direct, ...throughIndex]);
  const helpers = new Set([...dependencies].filter(([file, imports]) => file.startsWith('tests/') && !isTestFile(file) && intersects(imports, affected)).map(([file]) => file));
  return [...dependencies].flatMap(([file, imports]) => {
    if (!isTestFile(file)) return [];
    const tier = changedSet.has(file) || intersects(imports, data) ? 0 : intersects(imports, direct) ? 1
      : intersects(imports, throughIndex) || intersects(imports, helpers) ? 2 : null;
    return tier === null ? [] : [{ file, tier }];
  });
}
