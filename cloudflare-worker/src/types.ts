/**
 * Types for Google Workspace MCP Cloudflare Worker
 */

/** Shared credentials accessor type. Used by every tool registration function. */
export type GetCredsFunc = () => Promise<{ accessToken: string }>;

// Props injected into McpAgent by OAuthProvider after Google auth completes.
// Available as `this.props` inside each McpAgent (e.g. OfficeAgent).
// Declared as `type` (not `interface`) so it structurally satisfies McpAgent's
// `Record<string, unknown>` props constraint — interfaces don't get TS's
// implicit index signature inference that type literals do. The explicit
// index signature below guarantees the constraint is met either way.
export type OAuthProps = {
  google_sub: string;  // Stable Google user ID (userinfo.sub)
  email:      string;  // Google account email
  [key: string]: unknown;
};

export interface Env {
  // ─── Worker config ─────────────────────────────────────────────────────────────
  PUBLIC_BASE_URL: string;

  // ─── Cloudflare KV ─────────────────────────────────────────────────────────────
  OAUTH_KV:  KVNamespace;  // OAuth state (from OAuthProvider)
  TOKENS_KV: KVNamespace;  // Google access/refresh tokens (shared with google-auth)
  CONFIG_KV: KVNamespace;  // Feature flags, config (optional)

  // ─── Durable Object (McpAgent) ────────────────────────────────────────────────
  MCP_SERVER?: DurableObjectNamespace;  // used by office (and any future self-registered tenant sub-workers)

  // ─── Centralized Auth (google-auth.tuongbeo.workers.dev) ─────────────────────
  GOOGLE_AUTH_BASE_URL:      string;  // https://google-auth.tuongbeo.workers.dev
  GOOGLE_AUTH_SERVICE_TOKEN: string;  // Bearer token for /delegate/verify

  // ─── Google Custom Search (optional) ───────────────────────────────────────────
  GOOGLE_PSE_API_KEY?:    string;
  GOOGLE_PSE_ENGINE_ID?:  string;

  // ─── Sub-worker config (office — set via wrangler `vars`) ───────────────────
  // Must match the `namespace` passed to createWorker() in that worker's entry
  // point, and the `tokens:{namespace}:{sub}` KV keys used by google-tokens.ts.
  TOKEN_NAMESPACE?: string;
  // Optional per-deployment tool scoping.
  TOOLS_PRESET?: string;  // "all" | "docs" | "sheets" | "slides" | "drive" | "forms" | "appsscript" | "tasks"
}

export interface StoredTokenRecord {
  access_token:  string;
  refresh_token: string | null;
  expires_at:    number;   // seconds (legacy) or ms (google-auth) — normalized in getValidAccessToken
  scopes?:       string;
  email?:        string;   // google-auth stores this
  server_name?:  string;   // google-auth stores this
  updated_at?:   number;   // google-auth stores this
}
