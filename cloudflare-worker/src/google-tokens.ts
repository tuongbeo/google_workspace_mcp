/**
 * Google OAuth token storage & refresh.
 * Reads/writes Google access/refresh tokens in TOKENS_KV.
 * Proxy JWT is now handled by @cloudflare/workers-oauth-provider.
 *
 * Refreshing is centralized in google-auth (POST /delegate/refresh) — this
 * worker holds no Google OAuth client secret. google-auth mints every token
 * via its own resolveCredentials() (Client A1/B or a per-tenant BYOC client),
 * so it's the only place that can correctly refresh one; a worker refreshing
 * with its own separate client_id/secret would be refreshing with a client
 * Google never issued that refresh_token to, which fails with
 * unauthorized_client (this is exactly the bug this design fixes).
 */

import type { StoredTokenRecord, GetCredsFunc } from "./types";

// "tokens:" matches google-auth's TOKENS_PREFIX in auth/delegate.ts
// Key schema: tokens:{namespace}:{sub}  e.g. tokens:office:12345
const KV_TOKEN_PREFIX   = "tokens:";
const REFRESH_THRESHOLD = 10 * 60; // ask google-auth to refresh if < 10 min remaining

// ── Key helpers ───────────────────────────────────────────────────────────────

/** Canonical KV key for a stored token. Single source of truth for key schema. */
function tokenKey(namespace: string, sub: string): string {
  return `${KV_TOKEN_PREFIX}${namespace}:${sub}`;
}

// ── Centralized refresh via google-auth ──────────────────────────────────────

type DelegateRefreshResult =
  | { kind: "ok"; accessToken: string; expiresAt: number }
  | { kind: "reauth_required" | "not_found" }
  | { kind: "config_error" | "transient" };

/**
 * Calls google-auth's POST /delegate/refresh. Never throws — classifies every
 * outcome (including network errors and malformed/unreachable responses) so
 * getValidAccessToken() can decide whether to force re-auth or apply the
 * stale-token grace window below.
 */
async function callDelegateRefresh(
  namespace:    string,
  sub:          string,
  authBaseUrl:  string,
  serviceToken: string,
): Promise<DelegateRefreshResult> {
  let res: Response;
  try {
    res = await fetch(`${authBaseUrl}/delegate/refresh`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceToken}` },
      body:    JSON.stringify({ sub, server_name: namespace }),
      signal:  AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.warn(`[tokens] /delegate/refresh network error for ns=${namespace} sub=***${sub.slice(-4)}: ${e instanceof Error ? e.message : String(e)}`);
    return { kind: "transient" };
  }

  // Only trust the response as a structured reply if it actually parses as JSON
  // with a string `error` field — a not-yet-deployed route, a proxy error page,
  // or any other malformed body must fall into the transient/grace-window path
  // below, not be treated as a hard failure.
  let body: { error?: unknown; access_token?: unknown; expires_at?: unknown };
  try { body = await res.json(); }
  catch {
    console.warn(`[tokens] /delegate/refresh returned a non-JSON response (status ${res.status}) for ns=${namespace} sub=***${sub.slice(-4)}`);
    return { kind: "transient" };
  }
  if (typeof body.error !== "string") {
    console.warn(`[tokens] /delegate/refresh returned an unexpected body shape (status ${res.status}) for ns=${namespace} sub=***${sub.slice(-4)}`);
    return { kind: "transient" };
  }

  if (body.error === "ok" && typeof body.access_token === "string" && typeof body.expires_at === "number") {
    return { kind: "ok", accessToken: body.access_token, expiresAt: body.expires_at };
  }
  if (body.error === "reauth_required" || body.error === "not_found") {
    return { kind: body.error };
  }
  if (body.error === "config_error") {
    // google-auth's own OAuth client secret is wrong/rotated — not a per-user
    // problem, and not something retrying here can fix. Surface loudly.
    console.error(`[tokens] /delegate/refresh config_error for ns=${namespace} sub=***${sub.slice(-4)} — google-auth's OAuth client is misconfigured`);
    return { kind: "config_error" };
  }
  return { kind: "transient" };
}

// ── Get valid access token (refresh via google-auth if needed) ──────────────

export async function getValidAccessToken(
  sub:          string,
  kv:           KVNamespace,
  authBaseUrl:  string,
  serviceToken: string,
  namespace = "workspace",
): Promise<string> {
  const raw = await kv.get(tokenKey(namespace, sub));
  if (!raw) throw new Error(`No Google token for ns=${namespace} sub=${sub}. Re-authenticate.`);

  const record = JSON.parse(raw) as StoredTokenRecord;
  const nowSec = Math.floor(Date.now() / 1000);

  // Normalize expires_at: google-auth stores ms (Date.now()), legacy stores seconds.
  // Values > 1e12 are milliseconds (year 2001 in ms ≈ 9.8e11).
  const expiresAtSec = record.expires_at > 1e12
    ? Math.floor(record.expires_at / 1000)
    : record.expires_at;

  if (expiresAtSec - nowSec >= REFRESH_THRESHOLD) {
    return record.access_token;
  }
  if (!record.refresh_token) {
    throw new Error(`No refresh token for ns=${namespace} sub=${sub}. Re-authenticate.`);
  }

  const result = await callDelegateRefresh(namespace, sub, authBaseUrl, serviceToken);

  if (result.kind === "ok") return result.accessToken;

  if (result.kind === "reauth_required" || result.kind === "not_found") {
    throw new Error(`Google token refresh failed permanently (${result.kind}) for ns=${namespace} sub=${sub}. Re-authenticate.`);
  }

  // config_error / transient — not the user's fault (network blip, Google 5xx,
  // or an ops-side client misconfiguration on google-auth's end). Only apply the
  // grace window if the cached token is *already* past expiry and only briefly —
  // handing back a token past its 5-minute grace period would just trade a clear
  // "re-authenticate" error for a confusing 401 deeper in whatever tool call
  // triggered this.
  const staleSecs = nowSec - expiresAtSec;
  if (staleSecs >= 0 && staleSecs < 300) {
    console.warn(`[tokens] refresh failed (${result.kind}), using stale token (${staleSecs}s past expiry) for ns=${namespace} sub=***${sub.slice(-4)}`);
    return record.access_token;
  }
  throw new Error(`Google token refresh failed (${result.kind}) for ns=${namespace} sub=${sub}`);
}

// ── Agent helper ──────────────────────────────────────────────────────────────

/**
 * Factory: build a `getCreds` function for an MCP agent.
 * Eliminates the same 6-line block repeated in every agent init().
 *
 * Usage:
 *   const getCreds = makeGetCreds(this.props.google_sub, this.env, "office");
 */
export function makeGetCreds(
  sub:       string,
  env:       { TOKENS_KV: KVNamespace; GOOGLE_AUTH_BASE_URL: string; GOOGLE_AUTH_SERVICE_TOKEN: string },
  namespace = "workspace",
): GetCredsFunc {
  return async () => ({
    accessToken: await getValidAccessToken(
      sub,
      env.TOKENS_KV,
      env.GOOGLE_AUTH_BASE_URL,
      env.GOOGLE_AUTH_SERVICE_TOKEN,
      namespace,
    ),
  });
}
