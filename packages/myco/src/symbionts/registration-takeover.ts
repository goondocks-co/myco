/** Ownership admission for replacing another home's managed agent entries. */
import fs from 'node:fs';
import path from 'node:path';
import { rawHasMycoOwnershipSignal } from '../member/registration-ownership.js';
import { commandWords, mcpCommand, pluginBinaries, MEMBER_PLUGIN_MARKER } from './legacy-verdict.js';
import { readClaim, SYMBIONT_CONFIG_SUBSYSTEM } from '../member/subsystem-claim.js';
import type { LegacyFinding } from '../member/legacy-registration-files.js';
import { CREDENTIAL_FLAG } from '../member/constants.js';

const mycoBinary = (binary: string | undefined): binary is string => binary !== undefined && path.isAbsolute(binary) && /^myco(?:\.exe)?$/.test(path.basename(binary));

export function ownedHookBinary(command: string): string | undefined {
  const binary = commandWords(command).words[0];
  return rawHasMycoOwnershipSignal(command) && mycoBinary(binary) ? binary : undefined;
}

export function ownedMcpBinary(entry: unknown): string | undefined {
  const { binary, helper } = mcpCommand(entry);
  if (helper !== undefined) {
    const words = commandWords(helper).words;
    const credential = words.indexOf(CREDENTIAL_FLAG);
    const managed = rawHasMycoOwnershipSignal(helper) || credential > 2 && words[credential + 1] === 'registry';
    if (managed && mycoBinary(words[0]) && words[1] === 'member' && words[2] === 'mcp-headers') return words[0];
  }
  if (entry && typeof entry === 'object') {
    const server = entry as Record<string, unknown>;
    const argv = Array.isArray(server.command) ? server.command : [server.command, ...(Array.isArray(server.args) ? server.args : [])];
    const credential = argv.indexOf(CREDENTIAL_FLAG);
    if (mycoBinary(binary) && argv[1] === 'mcp' && credential > 1 && argv[credential + 1] === 'registry') return binary;
  }
  return rawHasMycoOwnershipSignal(JSON.stringify(entry) ?? '') && mycoBinary(binary) ? binary : undefined;
}

export function ownedPluginBinary(content: string): string | undefined {
  return content.includes(MEMBER_PLUGIN_MARKER) || rawHasMycoOwnershipSignal(content) ? pluginBinaries(content).find(mycoBinary) : undefined;
}

export function findingOwnedBinary(finding: LegacyFinding): string | undefined {
  if (finding.location.kind === 'mcp') return ownedMcpBinary(JSON.parse(finding.subject));
  return finding.keyPath === 'plugin' ? ownedPluginBinary(fs.readFileSync(finding.file, 'utf8')) : ownedHookBinary(finding.subject);
}

export function mayTakeOverBinary(binary: string | undefined, home: string): boolean {
  if (binary === undefined) return false;
  if (readClaim(SYMBIONT_CONFIG_SUBSYSTEM)?.owner === path.resolve(home)) return true;
  try { fs.statSync(binary); return false; } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return true;
    throw error;
  }
}
