import { terminalText } from '@myco/utils/terminal-text.js';
import type { DoctorCheck, DoctorReason } from './doctor-member.js';

const attention = (check: DoctorCheck): boolean => check.status === 'warn' || check.status === 'fail';
const label = (check: DoctorCheck): string => check.status === 'fail' ? 'FAIL' : check.status === 'warn' ? 'WARN' : check.status === 'not-checked' ? 'not checked' : check.status;
const oneLine = (text: string): string => terminalText(text, text.length).replace(/\s+/g, ' ').trim();
const names: Record<string, string> = { 'Member MCP resolution': 'Agent tools', 'Worker service': 'Agent work', 'Credential': 'Sign-in', 'Membership': 'Myco connection', 'Setup': 'Agent setup', 'Memberships': 'Myco connections', 'Migration': 'Earlier history' };
const toolProblems: Partial<Record<DoctorReason, string>> = {
  mcp_entry_absent: 'has no Myco tools configured',
  mcp_entry_no_credential: 'cannot sign in to Myco tools',
  mcp_entry_unknown_transport: 'has an incomplete Myco tools connection',
  mcp_target_unreadable: 'has a tools configuration that could not be read',
  mcp_cwd_ambiguous: 'cannot select this repository for Myco tools',
  mcp_cwd_elsewhere: 'selects another repository for Myco tools',
  mcp_server_mismatch: 'signs in to a different Myco than its tools use',
  mcp_server_stale: 'uses another Myco for tools',
  mcp_home_mismatch: 'uses another Myco home for tools',
  mcp_project_untrusted: 'needs your approval before its Myco tools can connect',
  mcp_project_override: 'uses this repository’s own Myco tools configuration',
};

function shortDetail(check: DoctorCheck): string {
  if (check.summary) return check.summary;
  if (check.name === 'Member MCP resolution' && check.status === 'ok') return `${check.symbiont}'s tools are configured; runtime access not checked.`;
  if (check.name === 'Capture' && check.status === 'not-checked') return `${check.symbiont}'s capture is connected; execution not checked.`;
  const problem = check.reason === undefined ? undefined : toolProblems[check.reason];
  if (check.reason === 'mcp_project_untrusted') return `${check.symbiont}: approve this repository in the agent's trust dialog, then reconnect Myco with /mcp.`;
  if (problem && !['mcp_entry_absent', 'mcp_entry_no_credential', 'mcp_entry_unknown_transport'].includes(check.reason!)) return `${check.symbiont ?? 'This agent'} ${problem}. Review its Myco connection in the agent's settings; use \`myco doctor --all\` to locate it.`;
  if (problem) return `${check.symbiont ?? 'This agent'} ${problem}. Run \`myco member join --provision ${check.symbiont ?? '<agent>'}\` from this repository.`;
  if (check.name === 'Capture' && check.detail.includes('offline latch')) return 'Capture delivery could not be checked. Run `myco member drain` from this repository.';
  return check.detail;
}

/** Details retain every check; the default lists attention and healthy totals by kind. */
export function doctorOutput(checks: readonly DoctorCheck[], options: { all: boolean }): string[] {
  const visible = checks.filter(check => check.name !== 'Capture backlog');
  const failed = visible.filter(check => check.status === 'fail').length;
  const warned = visible.filter(check => check.status === 'warn').length;
  const unchecked = checks.filter(check => check.status === 'not-checked').length;
  const lines = [`myco doctor (member): ${failed + warned === 0 ? 'nothing needs attention' : `${failed + warned} ${failed + warned === 1 ? 'check needs' : 'checks need'} attention (${failed} failed, ${warned} ${warned === 1 ? 'warning' : 'warnings'})`}`];
  if (options.all) {
    for (const check of checks) {
      const summary = oneLine(shortDetail(check));
      lines.push(`  ${check.name}: ${label(check)} ${summary}`);
      const details = oneLine(check.detail) === summary ? [] : [oneLine(check.detail)];
      if (check.configPath !== undefined) details.push(`folder: ${oneLine(check.folder ?? '')}; config: ${oneLine(check.configPath)}; context: ${check.context}; Myco home: ${oneLine(check.memberHome ?? '')} (${check.homeSource})`);
      if (details.length > 0) lines.push(`    ${details.join('; ')}`);
    }
  } else {
    const healthy = visible.filter(check => !attention(check));
    const repositories = healthy.filter(check => check.name === 'Repository');
    const agents = new Set(healthy.filter(check => check.name === 'Capture' && check.symbiont).map(check => check.symbiont));
    const tools = new Set(healthy.filter(check => check.name === 'Member MCP resolution' && check.symbiont).map(check => check.symbiont));
    const projectToolsChecked = checks.some(check => check.name === 'Member MCP resolution');
    if (!projectToolsChecked) for (const check of healthy) for (const agent of check.toolsAgents ?? []) tools.add(agent);
    const toolSummary = projectToolsChecked || tools.size > 0 ? `tools configured for ${tools.size} agents (runtime access not checked)` : 'tools configuration not checked here; see --all';
    lines.push(`  ${repositories.length} repositories connected`, `  ${agents.size} agents connected (configuration checked; capture execution not checked)`, `  ${toolSummary}`);
    const groups = new Map<string, DoctorCheck[]>();
    for (const check of healthy) {
      if (['Repository', 'Capture', 'Member MCP resolution', 'Capture waiting', 'Capture losses'].includes(check.name)) continue;
      const name = names[check.name] ?? check.name;
      groups.set(name, [...(groups.get(name) ?? []), check]);
    }
    for (const [name, items] of groups) lines.push(`  ${name}: ${items.length} ${items.every(check => check.status === 'ok') ? 'checked' : 'reported; see --all'}`);
    for (const check of visible.filter(check => ['Capture waiting', 'Capture losses'].includes(check.name))) lines.push(`  ${label(check)} ${check.name}: ${oneLine(shortDetail(check))}`);
    for (const check of visible.filter(check => attention(check) && !['Capture waiting', 'Capture losses'].includes(check.name))) lines.push(`  ${label(check)} ${names[check.name] ?? check.name}: ${oneLine(shortDetail(check))}`);
    lines.push(`  ${unchecked} checks not verified at runtime; use myco doctor --all for every check and detail.`);
  }
  return lines;
}
