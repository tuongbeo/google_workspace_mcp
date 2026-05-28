/**
 * Types for Google Workspace MCP Cloudflare Worker
 */

// Props injected into McpAgent by OAuthProvider after Google auth completes.
// Available as `this.props` inside GoogleWorkspaceAgent.
export interface OAuthProps {
  google_sub: string;  // Stable Google user ID (userinfo.sub)
  email:      string;  // Google account email
}

export interface Env {
  // ─── Google OAuth 2.0 credentials ─────────────────────────────────────────────
  GOOGLE_OAUTH_CLIENT_ID:     string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;

  // ─── Worker config ─────────────────────────────────────────────────────────────
  PUBLIC_BASE_URL: string;

  // ─── Cloudflare KV ─────────────────────────────────────────────────────────────
  OAUTH_KV:  KVNamespace;  // OAuth state (from OAuthProvider)
  TOKENS_KV: KVNamespace;  // Google access/refresh tokens
  CONFIG_KV: KVNamespace;  // Feature flags, config (optional)

  // ─── Durable Object (McpAgent) ────────────────────────────────────────────────
  GW_SERVER: DurableObjectNamespace;
  MCP_SERVER?: DurableObjectNamespace;  // used by specialized workers (office/plan/social)

  // ─── Google Custom Search (optional) ───────────────────────────────────────────
  GOOGLE_PSE_API_KEY?:    string;
  GOOGLE_PSE_ENGINE_ID?:  string;
}

export interface StoredTokenRecord {
  access_token:  string;
  refresh_token: string;
  expires_at:    number;
  scopes:        string;
  google_client_id?:     string;
  google_client_secret?: string;
}

export interface ProxyJWTPayload {
  sub: string;
  iat: number;
  exp: number;
}

export interface OAuthStateRecord {
  clientId:     string;
  redirectUri:  string;
  state:        string;
  codeChallenge: string;
  googleClientId?: string;
}

export interface DCRClientRecord {
  client_id:     string;
  client_secret: string;
  redirect_uris: string[];
  client_name:   string;
  created_at:    number;
  google_client_id?:     string;
  google_client_secret?: string;
}
