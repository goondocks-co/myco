import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../index';
import { handleSearch } from './tools/search';
import { handleContext } from './tools/context';
import { handlePlans } from './tools/plans';
import { handleSessions } from './tools/sessions';
import { handleSkills } from './tools/skills';
import { handleSpores } from './tools/spores';

export function createMcpServerInstance(env: Env): McpServer {
  const server = new McpServer({ name: 'myco', version: '1.0.0' });

  server.tool('myco_search', 'Semantic and keyword search across synced project knowledge — spores, sessions, plans, and skills. Results include stable IDs and retrieve hints for full-record entity tools.', {
    query: z.string().describe('The search query'),
    types: z.array(z.string()).optional().describe('Filter to content types: spores, sessions, plans, artifacts'),
    limit: z.number().min(1).max(50).default(10).describe('Maximum results'),
    status: z.string().optional().describe('Optional metadata filter for record status'),
    observation_type: z.string().optional().describe('Optional spore observation type filter'),
    since: z.number().optional().describe('Optional created_at lower bound in epoch seconds'),
    until: z.number().optional().describe('Optional created_at upper bound in epoch seconds'),
    session_id: z.string().optional().describe('Optional session id metadata filter'),
    source_path: z.string().optional().describe('Optional source path metadata filter'),
    name: z.string().optional().describe('Optional name metadata filter'),
  }, async (args) => handleSearch(args, env));

  server.tool('myco_cortex', 'Retrieve Cortex project intelligence. This team surface currently supports op="digest". Three tiers: 1500 (executive), 5000 (deep onboarding), 10000 (comprehensive).', {
    op: z.enum(['digest']).default('digest').optional().describe('Operation; only digest is available on the team worker surface'),
    tier: z.number().optional().describe('Digest depth: 1500, 5000 (default), or 10000'),
  }, async (args) => handleContext(args, env));

  server.tool('myco_plans', 'List or retrieve synced plans. op="list" returns summaries; op="get" returns one full plan by id and optional machine_id from search retrieve hints.', {
    op: z.enum(['list', 'get']).default('list').optional().describe('Operation; cloud plans are read-only'),
    id: z.string().optional().describe('Plan id for op="get"'),
    machine_id: z.string().optional().describe('Machine id from a search retrieve hint for disambiguation'),
    status: z.string().optional().describe('Filter by plan status'),
    session: z.string().optional().describe('Filter by session id'),
    limit: z.number().min(1).max(100).default(20).optional().describe('Maximum plans'),
  }, async (args) => handlePlans(args, env));

  server.tool('myco_sessions', 'List or retrieve synced coding sessions. Useful for recent activity, work by branch or agent.', {
    op: z.enum(['list', 'get']).default('list').optional().describe('Operation; cloud sessions are read-only'),
    id: z.string().optional().describe('Session id for op="get"'),
    machine_id: z.string().optional().describe('Machine id from a search retrieve hint for disambiguation'),
    limit: z.number().min(1).max(100).default(20).optional().describe('Maximum sessions'),
    status: z.string().optional().describe('Filter: active, completed'),
    agent: z.string().optional().describe('Filter: claude, codex, cursor, etc.'),
    branch: z.string().optional().describe('Filter by git branch'),
    since: z.string().optional().describe('ISO date — sessions after this date'),
  }, async (args) => handleSessions(args, env));

  server.tool('myco_skills', 'List or retrieve synced project skills — reusable patterns extracted from project knowledge.', {
    op: z.enum(['list', 'get']).default('list').optional().describe('Operation; cloud skills are read-only'),
    id: z.string().optional().describe('Skill id or name for op="get"'),
    machine_id: z.string().optional().describe('Machine id from a search retrieve hint for disambiguation'),
    status: z.string().optional().describe('Filter: active, draft, retired'),
    limit: z.number().min(1).max(100).default(50).optional().describe('Maximum skills'),
  }, async (args) => handleSkills(args, env));

  server.tool('myco_spores', 'List or retrieve synced spores. op="list" filters durable observations; op="get" returns one full spore by id and optional machine_id from search retrieve hints. Cloud spores are read-only.', {
    op: z.enum(['list', 'get']).default('list').optional().describe('Operation; cloud spores are read-only'),
    id: z.string().optional().describe('Spore id for op="get"'),
    machine_id: z.string().optional().describe('Machine id from a search retrieve hint for disambiguation'),
    status: z.string().optional().describe('Filter by spore status'),
    observation_type: z.string().optional().describe('Filter by observation type'),
    agent_id: z.string().optional().describe('Filter by agent id'),
    search: z.string().optional().describe('Simple content substring filter'),
    limit: z.number().min(1).max(100).default(20).optional().describe('Maximum spores'),
    offset: z.number().min(0).default(0).optional().describe('Offset for paging'),
  }, async (args) => handleSpores(args, env));

  return server;
}
