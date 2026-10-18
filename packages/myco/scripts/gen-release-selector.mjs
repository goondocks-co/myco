import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderReleaseSelector, renderPowerShellReleaseSelector } from './release-policy.mjs';
import { renderJqSourceMarkerValidator, renderAwkSourceMarkerValidator, renderPowerShellSourceMarkerValidator } from './render-install-marker-schema.mjs';
const generated = [
  ['install-path', [['install.sh', () => fs.readFileSync(new URL('./install-path.sh', import.meta.url), 'utf8')]]],
  ['release-selector', [['install.sh', renderReleaseSelector], ['install.ps1', renderPowerShellReleaseSelector]]],
  ['source-marker-jq', [['install.sh', renderJqSourceMarkerValidator]]],
  ['source-marker-awk', [['install.sh', renderAwkSourceMarkerValidator]]],
  ['source-marker-ps', [['install.ps1', renderPowerShellSourceMarkerValidator]]],
];
for (const [block, targets] of generated) for (const [name, render] of targets) {
  const file = fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url));
  const source = fs.readFileSync(file, 'utf8');
  const marker = new RegExp(`# ${block}:start\\n[\\s\\S]*?# ${block}:end`);
  if (!marker.test(source)) throw new Error(`Missing generated ${block} block in ${name}`);
  const next = source.replace(marker, () => `# ${block}:start\n${render()}# ${block}:end`);
  if (process.argv.includes('--check')) {
    if (next !== source) throw new Error('Run node packages/myco/scripts/gen-release-selector.mjs');
  } else fs.writeFileSync(file, next);
}
