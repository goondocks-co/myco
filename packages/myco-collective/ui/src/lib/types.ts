export interface ProjectRecord {
  id: string;
  name: string;
  worker_url: string;
  api_key_hash: string;
  capabilities: string[];
  package_version: string | null;
  schema_version: number | null;
  last_seen: number | null;
  registered_at: number;
}

export interface HealthResponse {
  status: string;
  collective_name: string;
  project_count: number;
  admin_token_hash: string | null;
  mcp_token_hash: string | null;
}

export interface AuthVerifyResponse {
  authenticated: boolean;
  collective_name: string;
  project_count: number;
}

export interface CollectiveAccessResponse {
  collective_name: string;
  mcp_endpoint: string;
  mcp_token: string | null;
  admin_token_hash: string | null;
  mcp_token_hash: string | null;
}

export interface ProjectsResponse {
  projects: ProjectRecord[];
}

export interface SettingsRecord {
  value: unknown;
  description: string | null;
  updated_at: number;
  updated_by: string | null;
}

export interface SettingsResponse {
  settings_overrides: Record<string, unknown>;
  settings_records: Record<string, SettingsRecord>;
  setting_definitions: Array<{
    key: string;
    description: string;
    value_type: 'boolean' | 'integer' | 'number' | 'enum';
    example: unknown;
    minimum?: number;
    maximum?: number;
    enum_values?: string[];
  }>;
  capabilities: string[];
}

export interface SearchResultRecord {
  id?: string;
  score?: number;
  table?: string;
  title?: string;
  preview?: string;
  path?: string;
  description?: string;
  observation_type?: string;
  status?: string;
  session_id?: string;
  started_at?: number;
  url?: string;
  project?: {
    id: string;
    name: string;
    worker_url: string;
  };
  [key: string]: unknown;
}

export interface SearchResponse {
  results: SearchResultRecord[];
  errors?: Array<{
    project: {
      id: string;
      name: string;
      worker_url: string;
    };
    error: string;
    status?: number;
  }>;
}
