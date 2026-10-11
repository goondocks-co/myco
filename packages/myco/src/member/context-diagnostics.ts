import { deploymentKeyFor, deploymentUrl } from './registry.js';

/** The exact prefix identifying one Deployment and Project's prompt answers in the shared helper log. */
export function promptContextLogPrefix(serverUrl: string, projectId: string): string {
  return `[myco] context ${deploymentKeyFor(serverUrl)} ${projectId}: `;
}

/** Matches the helper writer's timestamp and destination before reading the diagnostic marker. */
export function isPromptContextLogLine(line: string, serverUrl: string, projectId: string): boolean {
  const stamped = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (.*)$/.exec(line);
  return stamped !== null && stamped[1]!.startsWith(`${deploymentUrl(serverUrl)} ${projectId} ${promptContextLogPrefix(serverUrl, projectId)}`);
}
