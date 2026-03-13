/**
 * Types for Google Workspace MCP Cloudflare Worker
 */

export interface Env {
  // ─── Google OAuth 2.0 ────────────────────────────────────────────────────────
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;

  // ─── Worker config ────────────────────────────────────────────────────────────
  PUBLIC_BASE_URL: string; // https://googleworkspace.pilacorp.workers.dev
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
}

export interface AuthCodeRecord {
  proxy_jwt: string;
  client_id: string;
  redirect_uri: string;
}

export interface DCRClientRecord {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  client_name: string;
  created_at: number;
}
