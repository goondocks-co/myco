import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../index';
import { handleCollectiveProject, handleCollectiveProjects, handleCollectiveSearch, handleCollectiveSettings } from '../tools';

export function createMcpServerInstance(env: Env): McpServer {
  const server = new McpServer({ name: 'myco-collective', version: '0.1.0' });

  server.tool('collective_search', 'Search across connected Myco projects with project attribution.', {
    query: z.string(),
    project: z.string().optional(),
    limit: z.number().min(1).max(50).optional(),
  }, async (args) => handleCollectiveSearch(env, args));

  server.tool('collective_projects', 'List connected projects in the Collective.', {}, async () => handleCollectiveProjects(env));

  server.tool('collective_project', 'Get details for a single project in the Collective.', {
    project: z.string(),
    include_digest: z.boolean().optional(),
  }, async (args) => handleCollectiveProject(env, args));

  server.tool('collective_settings', 'View current Collective settings overrides.', {}, async () => handleCollectiveSettings(env));

  return server;
}
