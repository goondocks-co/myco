#!/usr/bin/env node
// One-off: rewrite vitest-style `mock.module(path, async (importOriginal) => {
//   const original = await importOriginal<...>();
// ...})` into a pre-import + spread shape bun's module mocker can handle.
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const TESTS = path.join(REPO, 'tests');

/**
 * For each file, collect all (modulePath, localName) pairs that use
 * importOriginal, emit a top-level `import * as <localName> from
 * '<modulePath>';`, and rewrite the factory to reference the pre-imported
 * namespace.
 */
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

let touched = 0;
for (const file of walk(TESTS)) {
  let src = fs.readFileSync(file, 'utf8');
  if (!src.includes('importOriginal')) continue;

  // Match: mock.module('<path>', async (importOriginal) => {
  //          const <var> = await importOriginal<...>();
  const RE =
    /mock\.module\((['"])([^'"]+)\1,\s*async\s*\(\s*importOriginal\s*\)\s*=>\s*\{\s*\n\s*const\s+(\w+)\s*=\s*await\s+importOriginal(?:<[^>]*>)?\(\s*\);\s*\n/g;

  const imports = [];
  let counter = 0;
  const localNames = new Map();

  src = src.replace(RE, (_m, quote, modPath, origVar) => {
    counter += 1;
    let ns = localNames.get(modPath);
    if (!ns) {
      ns = `__orig_${modPath.replace(/[^a-zA-Z0-9]/g, '_')}_${counter}`;
      localNames.set(modPath, ns);
      // Snapshot the namespace eagerly. Bun's `import * as` binding is live,
      // so a subsequent `mock.module(<modPath>)` would eclipse the original's
      // exports and cause a recursive loop when the factory calls back into
      // them. Copying the keys into a plain object locks in the real impl.
      imports.push(`import * as ${ns}__ns from ${quote}${modPath}${quote};`);
      imports.push(`const ${ns} = { ...${ns}__ns };`);
    }
    return `mock.module(${quote}${modPath}${quote}, () => {\n  const ${origVar} = ${ns};\n`;
  });

  if (imports.length === 0) continue;

  // Insert imports after the last existing `import ... from ...;` line.
  const lines = src.split('\n');
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^import\s/.test(lines[i]) || /^\s*\/\//.test(lines[i])) {
      if (/^import\s/.test(lines[i])) lastImportIdx = i;
    } else if (lines[i].trim() === '') {
      continue;
    } else {
      break;
    }
  }
  lines.splice(lastImportIdx + 1, 0, ...imports);
  src = lines.join('\n');

  fs.writeFileSync(file, src);
  touched += 1;
}
console.log(`fix-import-original: rewrote ${touched} files`);
