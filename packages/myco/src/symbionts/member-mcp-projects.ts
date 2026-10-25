import { MYCO_MCP_SERVER_NAME } from '@myco/member/registration-ownership.js';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

/** Private project scopes held in the agent's user configuration. */
export function privateMcpProjects(data: JsonObject): Array<{ root: string; entry: unknown; trusted: boolean }> {
  const projects = object(data.projects, 'projects');
  const trusted = (root: string): boolean => {
    for (let folder = path.resolve(root); ; folder = path.dirname(folder)) {
      if (object(projects[folder], `projects[${folder}]`).hasTrustDialogAccepted === true) return true;
      if (path.dirname(folder) === folder) return false;
    }
  };
  return Object.entries(projects).map(([root, value]) => {
    const project = object(value, `projects[${root}]`);
    const servers = object(project.mcpServers, `projects[${root}].mcpServers`);
    return { root, entry: servers[MYCO_MCP_SERVER_NAME], trusted: trusted(root) };
  });
}

/** Reconcile private entries and retire the owned global entry in one configuration value. */
export function reconcilePrivateMcpProjects(data: JsonObject, roots: readonly string[], entryFor: (root: string) => unknown,
  owns: { local: (entry: unknown) => boolean; global: (entry: unknown) => boolean }): JsonObject {
  const next = structuredClone(data);
  const projects = object(next.projects, 'projects');
  const wanted = new Set(roots);
  for (const scope of privateMcpProjects(next)) {
    if (scope.entry === undefined) continue;
    if (wanted.has(scope.root) && !owns.local(scope.entry)) throw new Error(`the Myco tools for ${scope.root} belong to another installation`);
    if (!wanted.has(scope.root) && owns.local(scope.entry)) {
      const project = object(projects[scope.root], 'project');
      const servers = object(project.mcpServers, 'mcpServers');
      delete servers[MYCO_MCP_SERVER_NAME];
      if (Object.keys(servers).length === 0) delete project.mcpServers;
      if (Object.keys(project).length === 0) delete projects[scope.root];
    }
  }
  for (const root of roots) {
    const project = object(projects[root], `projects[${root}]`);
    project.mcpServers = { ...object(project.mcpServers, 'mcpServers'), [MYCO_MCP_SERVER_NAME]: entryFor(root) };
    projects[root] = project;
  }
  if (Object.keys(projects).length > 0) next.projects = projects;
  else delete next.projects;
  const global = object(next.mcpServers, 'mcpServers');
  if (global[MYCO_MCP_SERVER_NAME] !== undefined) {
    if (!owns.global(global[MYCO_MCP_SERVER_NAME])) throw new Error('the global Myco tools belong to another installation');
    delete global[MYCO_MCP_SERVER_NAME];
    if (Object.keys(global).length === 0) delete next.mcpServers;
  }
  return next;
}
