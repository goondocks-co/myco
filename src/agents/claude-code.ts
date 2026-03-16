import type { AgentAdapter } from './adapter.js';
import { findJsonlInSubdirs, parseJsonlTurns } from './adapter.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TRANSCRIPT_BASE = path.join(os.homedir(), '.claude', 'projects');

export const claudeCodeAdapter: AgentAdapter = {
  name: 'claude-code',
  displayName: 'Claude Code',
  pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT',
  hookFields: {
    transcriptPath: 'transcript_path',
    lastResponse: 'last_assistant_message',
    sessionId: 'session_id',
  },

  findTranscript: (sessionId) => findJsonlInSubdirs(TRANSCRIPT_BASE, sessionId),

  parseTurns: (content) => parseJsonlTurns(content, {
    roleField: 'type',
    extractTimestamp: true,
    skipToolResultUsers: true,
    stripImageTextRefs: true,
  }),

  configureVaultEnv: (projectRoot, vaultDir) => {
    const settingsDir = path.join(projectRoot, '.claude');
    if (!fs.existsSync(settingsDir)) return false;

    const settingsPath = path.join(settingsDir, 'settings.json');
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* fresh */ }
    }
    const env = (settings.env ?? {}) as Record<string, string>;
    env.MYCO_VAULT_DIR = vaultDir;
    settings.env = env;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    return true;
  },
};
