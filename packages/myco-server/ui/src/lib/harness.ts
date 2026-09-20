/** The harness name a person reads, from the id a worker, a run or a transcript carries. */
const HARNESS_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  windsurf: 'Windsurf',
  unrecorded: 'Agent not recorded',
};

export function harnessLabel(id: string): string {
  return HARNESS_LABEL[id] ?? id;
}
