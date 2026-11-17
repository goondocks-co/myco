import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const isTestFile = file => /^tests\/.*\.test\.[cm]?[jt]sx?$/.test(file);
const MODULE_FILE = /\.[cm]?[jt]sx?$/;
const INDEX_FILE = /(?:^|\/)index\.[cm]?[jt]sx?$/;
const require = createRequire(import.meta.url);
let compiler;

function moduleResolver(root, virtualFiles) {
  const ts = compiler ??= require('typescript-v6');
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const converted = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, root);
  if (converted.errors.length) throw new Error(converted.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  const options = { ...converted.options, baseUrl: converted.options.baseUrl ?? root, paths: {
    ...converted.options.paths,
    '@goondocks/myco-shared/*': ['packages/myco-shared/src/*'],
  } };
  const virtual = new Set(virtualFiles.map(file => path.resolve(root, file)));
  const host = { ...ts.sys, fileExists: file => ts.sys.fileExists(file) || virtual.has(path.resolve(file)) };
  const cache = ts.createModuleResolutionCache(root, file => file, options);
  const resolve = (specifier, file) => ts.resolveModuleName(specifier, file, options, host, cache).resolvedModule?.resolvedFileName;
  return { ts, resolve };
}

/** Imports and explicit module locations used as subprocess entry points. */
function moduleSpecifiers(ts, file, text) {
  const specifiers = ts.preProcessFile(text, true, true).importedFiles.map(imported => imported.fileName);
  if (text.includes('import.meta.resolve')) {
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText() === 'import.meta.resolve'
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  }
  return specifiers;
}

/** Whether any entry imports a target, transitively, including an as-yet ungenerated module. */
export function reachesModule({ root, entries, target }) {
  const { ts, resolve } = moduleResolver(root, [target]);
  const destination = path.resolve(root, target);
  const seen = new Set();
  const visit = file => {
    if (file === destination) return true;
    if (seen.has(file) || file.includes(`${path.sep}node_modules${path.sep}`) || !MODULE_FILE.test(file)) return false;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    return moduleSpecifiers(ts, file, text).some(specifier => {
      const resolved = resolve(specifier, file);
      return resolved && visit(resolved);
    });
  };
  return entries.some(file => visit(path.resolve(root, file)));
}

/** Static imports, one re-exporting index, one non-test module under tests/, and a changed JSON file a test imports. */
export function affectedTests({ root, files, changed }) {
  const { ts, resolve: resolveModule } = moduleResolver(root, changed);
  const relative = file => path.relative(root, file).split(path.sep).join('/');
  const changedSet = new Set(changed);
  const dependencies = new Map();
  const exports = new Map();
  for (const file of files.filter(file => MODULE_FILE.test(file) && fs.existsSync(path.join(root, file)))) {
    const absolute = path.join(root, file);
    const text = fs.readFileSync(absolute, 'utf8');
    const resolve = specifier => {
      const resolved = resolveModule(specifier, absolute);
      return resolved && relative(resolved);
    };
    dependencies.set(file, new Set(moduleSpecifiers(ts, file, text).map(resolve).filter(Boolean)));
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
