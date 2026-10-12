import type { ToolUsage } from '../../hooks/use-sessions';

export function ToolUsageLine({ tools }: { tools: ToolUsage[] }) {
  return <span className="break-words">{tools.length === 0 ? 'No tool calls recorded' : tools.map((tool) => tool.toolName + ' × ' + tool.count).join(' · ')}</span>;
}
