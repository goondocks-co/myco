// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.join(__dirname, '../..');
const UI_ROOT = path.join(ROOT, 'packages/myco/ui');
const UI_SRC = path.join(UI_ROOT, 'src');
const DECLARATIONS = path.join(UI_SRC, 'types/myco-backend-modules.d.ts');
const TYPECHECK_TSCONFIG = path.join(UI_ROOT, 'tsconfig.typecheck.json');

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
      continue;
    }
    if (/\.[cm]?tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }

  return files;
}

function uiMycoImports(): string[] {
  const imports = new Set<string>();
  const sourceFiles = walk(UI_SRC);

  for (const file of sourceFiles) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier) {
        const specifier = statement.moduleSpecifier.getText(source).slice(1, -1);
        if (specifier.startsWith('@myco/')) {
          imports.add(specifier);
        }
      }
    }
  }

  return [...imports].sort();
}

function declaredModules(): string[] {
  const source = ts.createSourceFile(
    DECLARATIONS,
    fs.readFileSync(DECLARATIONS, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const modules = new Set<string>();

  for (const statement of source.statements) {
    if (ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name)) {
      modules.add(statement.name.text);
    }
  }

  return [...modules].sort();
}

interface ImportUsage {
  specifier: string;
  names: Set<string>;
}

function collectModuleExportNames(checker: ts.TypeChecker, symbol: ts.Symbol): Set<string> {
  const names = new Set(checker.getExportsOfModule(symbol).map((exportSymbol) => exportSymbol.getName()));
  for (const name of symbol.exports?.keys() ?? []) {
    names.add(name);
  }
  return names;
}

function declaredModuleExports(): Map<string, ImportUsage> {
  const program = ts.createProgram([DECLARATIONS], {
    allowJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(DECLARATIONS);
  if (!source) {
    throw new Error(`Unable to load declaration file ${DECLARATIONS}`);
  }
  const modules = new Map<string, ImportUsage>();

  for (const statement of source.statements) {
    if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)) {
      continue;
    }
    const symbol = checker.getSymbolAtLocation(statement.name);
    if (!symbol) {
      throw new Error(`Unable to read ambient module symbol for ${statement.name.text}`);
    }
    modules.set(statement.name.text, {
      specifier: statement.name.text,
      names: collectModuleExportNames(checker, symbol),
    });
  }

  return modules;
}

function moduleSourcePath(specifier: string): string {
  const relative = specifier.replace(/^@myco\//, 'packages/myco/src/').replace(/\.js$/, '');
  const candidates = [
    path.join(ROOT, `${relative}.ts`),
    path.join(ROOT, `${relative}.tsx`),
    path.join(ROOT, relative, 'index.ts'),
    path.join(ROOT, relative, 'index.tsx'),
  ];
  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error(`Unable to resolve backend source for ${specifier}`);
  }
  return match;
}

function exportedNames(sourcePath: string): Set<string> {
  const program = ts.createProgram([sourcePath], {
    allowJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const source = program.getSourceFile(sourcePath);
  if (!source) {
    throw new Error(`Unable to load source file ${sourcePath}`);
  }

  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(source);
  if (!symbol) {
    throw new Error(`Unable to read module symbol for ${sourcePath}`);
  }

  return collectModuleExportNames(checker, symbol);
}

function resolvedTypecheckConfig(): ts.ParsedCommandLine {
  const readResult = ts.readConfigFile(TYPECHECK_TSCONFIG, ts.sys.readFile);
  if (readResult.error) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext([readResult.error], {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => ROOT,
      getNewLine: () => '\n',
    }));
  }

  return ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    path.dirname(TYPECHECK_TSCONFIG),
    undefined,
    TYPECHECK_TSCONFIG,
  );
}

describe('ui typecheck boundary', () => {
  it('declares every @myco module imported by the UI', () => {
    const imports = uiMycoImports();
    const declared = declaredModules();
    const importedSet = new Set(imports);
    const declaredSet = new Set(declared);
    const missing = imports.filter((specifier) => !declaredSet.has(specifier));
    const stale = declared.filter((specifier) => !importedSet.has(specifier));
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('does not map @myco/* to backend source during UI typecheck', () => {
    const rawConfig = JSON.parse(fs.readFileSync(TYPECHECK_TSCONFIG, 'utf8')) as {
      compilerOptions?: { paths?: Record<string, unknown> };
    };
    expect(rawConfig.compilerOptions?.paths ?? {}).toEqual({});

    const resolvedConfig = resolvedTypecheckConfig();
    expect(resolvedConfig.options.paths?.['@myco/*']).toBeUndefined();
  });

  it('does not use bodyless or any-typed ambient modules', () => {
    const content = fs.readFileSync(DECLARATIONS, 'utf8');
    expect(content).not.toMatch(/declare\s+module\s+['"][^'"]+['"]\s*;/);
    expect(content).not.toMatch(/\bany\b/);
  });

  it('declared backend modules do not invent exports that real modules lack', () => {
    const missing: string[] = [];

    for (const usage of declaredModuleExports().values()) {
      const sourcePath = moduleSourcePath(usage.specifier);
      const exports = exportedNames(sourcePath);

      for (const name of usage.names) {
        if (!exports.has(name)) {
          missing.push(`${usage.specifier}: ${name}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
