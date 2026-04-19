import type { TeamSyncClient } from '../team-sync.js';
import type { RouteRequest, RouteResponse } from '../router.js';

export interface CollectiveHandlerDeps {
  getTeamClient: () => TeamSyncClient | null;
}

export function createCollectiveHandlers(deps: CollectiveHandlerDeps) {
  async function requireTeamClient(): Promise<TeamSyncClient> {
    const client = deps.getTeamClient();
    if (!client) {
      throw new Error('Team sync is not connected');
    }
    return client;
  }

  async function handleStatus(_req: RouteRequest): Promise<RouteResponse> {
    try {
      const client = await requireTeamClient();
      return { body: await client.getCollectiveStatus() };
    } catch (error) {
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async function handleSearch(req: RouteRequest): Promise<RouteResponse> {
    try {
      const client = await requireTeamClient();
      const query = req.query.q;
      if (!query) {
        return { status: 400, body: { error: 'Missing q parameter' } };
      }
      const project = req.query.project;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      return {
        body: await client.collectiveQuery('collective_search', {
          query,
          project,
          limit,
          types: req.query.types ? req.query.types.split(',').map((value) => value.trim()).filter(Boolean) : undefined,
          status: req.query.status || undefined,
          observation_type: req.query.observation_type || undefined,
          since: req.query.since ? Number(req.query.since) : undefined,
          until: req.query.until ? Number(req.query.until) : undefined,
          session_id: req.query.session_id || undefined,
          source_path: req.query.source_path || undefined,
          name: req.query.name || undefined,
        }),
      };
    } catch (error) {
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async function handleProjects(_req: RouteRequest): Promise<RouteResponse> {
    try {
      const client = await requireTeamClient();
      return {
        body: await client.collectiveQuery('collective_projects', {}),
      };
    } catch (error) {
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async function handleProject(req: RouteRequest): Promise<RouteResponse> {
    try {
      const client = await requireTeamClient();
      const project = req.query.project;
      if (!project) {
        return { status: 400, body: { error: 'Missing project parameter' } };
      }
      const includeDigest = req.query.include_digest === 'true';
      return {
        body: await client.collectiveQuery('collective_project', { project, include_digest: includeDigest }),
      };
    } catch (error) {
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async function handleSettings(_req: RouteRequest): Promise<RouteResponse> {
    try {
      const client = await requireTeamClient();
      return { body: await client.getCollectiveSettings() };
    } catch (error) {
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  return {
    handleStatus,
    handleSearch,
    handleProjects,
    handleProject,
    handleSettings,
  };
}
