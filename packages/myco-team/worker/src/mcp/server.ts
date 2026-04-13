import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../index';
import { handleSearch } from './tools/search';
import { handleContext } from './tools/context';
import { handleGet } from './tools/get';
import { handleSessions } from './tools/sessions';
import { handleGraph } from './tools/graph';
import { handleSkills } from './tools/skills';
import { handleTeam } from './tools/team';

export function createMcpServerInstance(env: Env): McpServer {
  const server = new McpServer({ name: 'myco', version: '1.0.0' });

  server.tool('myco_search', 'Semantic and keyword search across all project knowledge — spores, sessions, plans, artifacts. Returns ranked results with content previews.', {
    query: z.string().describe('The search query'),
    types: z.array(z.string()).optional().describe('Filter to content types: spores, sessions, plans, artifacts'),
    limit: z.number().min(1).max(50).default(10).describe('Maximum results'),
  }, async (args) => handleSearch(args, env));

  server.tool('myco_context', 'Pre-synthesized project digest. Start here to understand the project. Three tiers: 1500 (executive), 5000 (deep onboarding), 10000 (comprehensive).', {
    tier: z.number().optional().describe('Digest depth: 1500, 5000 (default), or 10000'),
  }, async (args) => handleContext(args, env));

  server.tool('myco_get', 'Retrieve a specific item by ID and type. Use after search to get full details.', {
    id: z.string().describe('The item ID'),
    type: z.enum(['session', 'spore', 'plan', 'artifact', 'skill']).describe('The item type'),
  }, async (args) => handleGet(args, env));

  server.tool('myco_sessions', 'List and filter coding sessions. Useful for recent activity, work by branch or agent.', {
    limit: z.number().min(1).max(100).default(20).optional().describe('Maximum sessions'),
    status: z.string().optional().describe('Filter: active, completed'),
    agent: z.string().optional().describe('Filter: claude, codex, cursor, etc.'),
    branch: z.string().optional().describe('Filter by git branch'),
    since: z.string().optional().describe('ISO date — sessions after this date'),
  }, async (args) => handleSessions(args, env));

  server.tool('myco_graph', 'Traverse the knowledge graph from an entity or note. Returns edges and connected entities.', {
    node_id: z.string().describe('Entity or note ID to traverse from'),
    direction: z.enum(['incoming', 'outgoing', 'both']).default('both').optional().describe('Edge direction'),
  }, async (args) => handleGraph(args, env));

  server.tool('myco_skills', 'List project skills — reusable patterns extracted from project knowledge.', {
    status: z.string().optional().describe('Filter: active, draft, retired'),
    limit: z.number().min(1).max(100).default(50).optional().describe('Maximum skills'),
  }, async (args) => handleSkills(args, env));

  // handleTeam takes only env (no args) since it has no parameters
  server.tool('myco_team', 'List team nodes — machines/developers connected to this project with sync status.', {},
    async () => handleTeam(env));

  return server;
}
