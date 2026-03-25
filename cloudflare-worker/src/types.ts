/**
 * Types for Google Workspace MCP Cloudflare Worker
 */

export interface Env {
  // ─── Google OAuth 2.0 (optional — per-connector credentials take priority) ───
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;

  // ─── Worker config ────────────────────────────────────────────────────────────
  PUBLIC_BASE_URL: string;
  JWT_SECRET: string;

  // ─── Cloudflare KV ───────────────────────────────────────────────────────────
  OAUTH_KV: KVNamespace;

  // ─── Google Custom Search (optional) ─────────────────────────────────────────
  GOOGLE_PSE_API_KEY?: string;
  GOOGLE_PSE_ENGINE_ID?: string;
}

export interface StoredTokenRecord {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scopes: string;
  // Per-connector Google credentials — dùng khi refresh token
  google_client_id?: string;
  google_client_secret?: string;
}

export interface ProxyJWTPayload {
  sub: string;
  iat: number;
  exp: number;
}

export interface OAuthStateRecord {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  googleClientId?: string; // propagate qua callback để lưu vào auth_code record
}

export interface AuthCodeRecord {
  google_code: string;   // raw Google auth code — exchange xảy ra tại /token
  client_id: string;
  redirect_uri: string;
}

export interface DCRClientRecord {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  client_name: string;
  created_at: number;
  google_client_id?: string;    // Google OAuth Client ID của connector này
  google_client_secret?: string;
}
