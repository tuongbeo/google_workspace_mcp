/**
 * Types for Google Workspace MCP Cloudflare Worker
 */

/** Shared credentials accessor type. Used by every tool registration function. */
export type GetCredsFunc = () => Promise<{ accessToken: string }>;

// Props injected into McpAgent by OAuthProvider after Google auth completes.
// Available as `this.props` inside GoogleWorkspaceAgent.
export interface OAuthProps {
  google_sub: string;  // Stable Google user ID (userinfo.sub)
  email:      string;  // Google account email
}

export interface Env {
  // ─── Google OAuth 2.0 credentials (used for token refresh fallback) ───────────
  GOOGLE_OAUTH_CLIENT_ID:     string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;

  // ─── Worker config ─────────────────────────────────────────────────────────────
  PUBLIC_BASE_URL: string;

  // ─── Cloudflare KV ─────────────────────────────────────────────────────────────
  OAUTH_KV:  KVNamespace;  // OAuth state (from OAuthProvider)
  TOKENS_KV: KVNamespace;  // Google access/refresh tokens (shared with google-auth)
  CONFIG_KV: KVNamespace;  // Feature flags, config (optional)

  // ─── Durable Object (McpAgent) ────────────────────────────────────────────────
  GW_SERVER:   DurableObjectNamespace;
  MCP_SERVER?: DurableObjectNamespace;  // used by office/plan/social workers

  // ─── Centralized Auth (google-auth.tuongbeo.workers.dev) ─────────────────────
  GOOGLE_AUTH_BASE_URL:      string;  // https://google-auth.tuongbeo.workers.dev
  GOOGLE_AUTH_SERVICE_TOKEN: string;  // Bearer token for /delegate/verify

  // ─── Google Custom Search (optional) ───────────────────────────────────────────
  GOOGLE_PSE_API_KEY?:    string;
  GOOGLE_PSE_ENGINE_ID?:  string;
}

export interface StoredTokenRecord {
  access_token:  string;
  refresh_token: string | null;
  expires_at:    number;   // seconds (legacy) or ms (google-auth) — normalized in getValidAccessToken
  scopes?:       string;
  email?:        string;   // google-auth stores this
  server_name?:  string;   // google-auth stores this
  updated_at?:   number;   // google-auth stores this
  google_client_id?:     string;
  google_client_secret?: string;
}
