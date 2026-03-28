import { resolveVaultDir } from '../vault/resolve.js';
import { VAULT_GITIGNORE } from './shared.js';
import { detectSymbionts } from '../symbionts/detect.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function run(args: string[]): Promise<void> {
  const vaultDir = resolveVaultDir();
  if (!fs.existsSync(path.join(vaultDir, 'myco.yaml'))) {
    console.error(`No myco.yaml found in ${vaultDir}. Run 'myco init' first.`);
    process.exit(1);
  }

  console.log(`Updating Myco vault at ${vaultDir}\n`);

  let updatedCount = 0;

  // --- Update .gitignore to match current template ---

  const gitignorePath = path.join(vaultDir, '.gitignore');
  const currentGitignore = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf-8')
    : '';

  if (currentGitignore !== VAULT_GITIGNORE) {
    fs.writeFileSync(gitignorePath, VAULT_GITIGNORE, 'utf-8');
    console.log('  \u2713 Updated .gitignore');
    updatedCount++;
  } else {
    console.log('  \u2013 .gitignore is current');
  }

  // --- Update symbiont plugins ---

  const projectRoot = path.dirname(vaultDir);
  const detected = detectSymbionts(projectRoot);

  if (detected.length > 0) {
    for (const d of detected) {
      try {
        if (d.manifest.pluginInstallCommands.length > 0) {
          for (const cmd of d.manifest.pluginInstallCommands) {
            const [bin, ...cmdArgs] = cmd.split(' ');
            execFileSync(bin, cmdArgs, { stdio: 'inherit' });
          }
          console.log(`  \u2713 Updated ${d.manifest.displayName} plugin`);
          updatedCount++;
        } else {
          console.log(`  \u2013 ${d.manifest.displayName}: no automated update available`);
        }
      } catch (err) {
        console.error(`  \u2717 Failed to update ${d.manifest.displayName}: ${(err as Error).message}`);
      }
    }
  } else {
    console.log('  \u2013 No agents detected');
  }

  // --- Summary ---

  console.log('');
  if (updatedCount > 0) {
    console.log(`Updated ${updatedCount} item${updatedCount > 1 ? 's' : ''}.`);
  } else {
    console.log('Everything is up to date.');
  }
  console.log('Run `myco doctor` to verify setup health.');
}
