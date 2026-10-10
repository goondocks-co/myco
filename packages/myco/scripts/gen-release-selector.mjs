import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderReleaseSelector, renderPowerShellReleaseSelector } from './release-policy.mjs';
for (const [name, render] of [['install.sh', renderReleaseSelector], ['install.ps1', renderPowerShellReleaseSelector]]) {
  const file = fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url));
  const source = fs.readFileSync(file, 'utf8');
  const next = source.replace(/# release-selector:start\n[\s\S]*?# release-selector:end/, () => `# release-selector:start\n${render()}# release-selector:end`);
  if (process.argv.includes('--check')) {
    if (next !== source) throw new Error('Run node packages/myco/scripts/gen-release-selector.mjs');
  } else fs.writeFileSync(file, next);
}
