/**
 * MCP access token auth for the Myco cloud MCP server.
 *
 * Tokens are stored in Workers KV (MYCO_SECRETS namespace) under the key 'mcp_access_token'.
 * KV provides AES-256-GCM encryption at rest — the Cloudflare-native approach for
 * runtime-managed secrets. This is separate from the worker's MYCO_TEAM_API_KEY auth
 * used for sync routes.
 */

export const MCP_TOKEN_KEY = 'mcp_access_token';

export function generateMcpToken(): string {
  return crypto.randomUUID();
}

export function getMcpTokenHash(token: string): string {
  // Non-cryptographic hash for change detection, returns 8 hex chars
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8);
}

export async function validateMcpToken(kv: KVNamespace, token: string): Promise<boolean> {
  const stored = await kv.get(MCP_TOKEN_KEY);
  if (!stored) return false;
  return stored === token;
}

export async function ensureMcpToken(kv: KVNamespace): Promise<string> {
  const existing = await kv.get(MCP_TOKEN_KEY);
  if (existing) return existing;
  const token = generateMcpToken();
  await kv.put(MCP_TOKEN_KEY, token);
  return token;
}

export async function rotateMcpToken(kv: KVNamespace): Promise<string> {
  const token = generateMcpToken();
  await kv.put(MCP_TOKEN_KEY, token);
  return token;
}

export async function authenticateMcpRequest(
  request: Request,
  kv: KVNamespace,
): Promise<Response | null> {
  const header = request.headers.get('Authorization');
  if (!header) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const valid = await validateMcpToken(kv, token);
  if (!valid) {
    return new Response(JSON.stringify({ error: 'Invalid MCP access token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}
