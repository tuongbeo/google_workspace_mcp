/**
 * OAuth 2.0 Proxy cho Google Workspace — Simplified flow
 *
 * Flow:
 *   /register  → lưu Google OAuth client_id + client_secret vào DCR record
 *   /authorize → redirect tới Google OAuth với googleClientId từ DCR record
 *   /callback  → nhận code, exchange với Google NGAY (có đủ credentials từ DCR), lưu tokens, phát JWT
 *   /token     → đọc pending JWT đã tạo ở /callback và trả về cho Claude.ai
 *
 * Simplified from "deferred exchange" design: /callback now exchanges immediately,
 * eliminating client_secret resolution ambiguity in /token.
 */

import { Env, OAuthStateRecord, DCRClientRecord } from "./types";
import { signJWT, storeTokens } from "./jwt";

const GOOGLE_SCOPES = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.spaces",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/script.projects",
  "https://www.googleapis.com/auth/script.metrics",
  "https://www.googleapis.com/auth/script.deployments",
].join(" ");

const GOOGLE_AUTH_URL  = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ── OAuth Discovery ───────────────────────────────────────────────────────────

export function buildOAuthMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint:          `${baseUrl}/token`,
    registration_endpoint:   `${baseUrl}/register`,
    scopes_supported:             ["openid", "email", "profile"],
    response_types_supported:     ["code"],
    grant_types_supported:        ["authorization_code"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
    code_challenge_methods_supported:      ["S256", "plain"],
  };
}

export function buildResourceMetadata(baseUrl: string) {
  return {
    resource:                `${baseUrl}/mcp`,
    authorization_servers:   [baseUrl],
    scopes_supported:        ["openid", "email"],
    bearer_methods_supported: ["header"],
  };
}

// ── POST /register ────────────────────────────────────────────────────────────

export async function handleDCR(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch {}

  // Claude.ai sends client_id = Google OAuth Client ID, client_secret = Google OAuth Secret
  const providedClientId     = (body.client_id     as string) || "";
  const providedClientSecret = (body.client_secret as string) || "";

  const clientId     = providedClientId     || crypto.randomUUID();
  const clientSecret = providedClientSecret || crypto.randomUUID();
  const redirectUris = (body.redirect_uris as string[]) || [];

  const record: DCRClientRecord = {
    client_id:            clientId,
    client_secret:        clientSecret,
    redirect_uris:        redirectUris,
    client_name:          (body.client_name as string) || "MCP Client",
    created_at:           Date.now(),
    google_client_id:     providedClientId     || env.GOOGLE_OAUTH_CLIENT_ID     || "",
    google_client_secret: providedClientSecret || env.GOOGLE_OAUTH_CLIENT_SECRET || "",
  };

  await env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify(record), { expirationTtl: 90 * 24 * 3600 });

  console.log(`[DCR] registered client=${clientId}, hasGoogleId=${!!record.google_client_id}, hasGoogleSecret=${!!record.google_client_secret}`);

  return Response.json({
    client_id:                     clientId,
    client_secret:                 clientSecret,
    redirect_uris:                 redirectUris,
    grant_types:                   ["authorization_code"],
    response_types:                ["code"],
    token_endpoint_auth_method:    "client_secret_post",
    client_name:                   record.client_name,
  }, { status: 201 });
}

// ── GET /authorize ────────────────────────────────────────────────────────────

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const params   = new URL(request.url).searchParams;
  const clientId  = params.get("client_id")     || "";
  const redirectUri = params.get("redirect_uri") || "";
  const state     = params.get("state")          || crypto.randomUUID();
  const codeChallenge = params.get("code_challenge") || "";

  const clientRecord = await env.OAUTH_KV.get<DCRClientRecord>(`client:${clientId}`, "json");
  const googleClientId = clientRecord?.google_client_id || env.GOOGLE_OAUTH_CLIENT_ID || clientId;

  if (!googleClientId) {
    return Response.json({ error: "invalid_client", error_description: "No Google OAuth Client ID. Please provide it when adding this connector." }, { status: 400 });
  }

  const stateRecord: OAuthStateRecord = { clientId, redirectUri, state, codeChallenge, googleClientId };
  await env.OAUTH_KV.put(`oauth_state:${state}`, JSON.stringify(stateRecord), { expirationTtl: 600 });

  const googleParams = new URLSearchParams({
    client_id:     googleClientId,
    scope:         GOOGLE_SCOPES,
    redirect_uri:  `${env.PUBLIC_BASE_URL}/callback`,
    state,
    response_type: "code",
    access_type:   "offline",
    prompt:        "consent",
  });

  console.log(`[authorize] clientId=${clientId}, googleClientId=${googleClientId}`);
  return Response.redirect(`${GOOGLE_AUTH_URL}?${googleParams}`, 302);
}

// ── GET /callback — Exchange with Google immediately ─────────────────────────
// Simplified: do the full exchange here. We have all credentials from DCR record.
// After success, store proxy JWT as pending_jwt:${tempCode} for /token to collect.

export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url  = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state") || "";
  const error    = url.searchParams.get("error");

  if (error) {
    return new Response(
      `<html><body><h2>Authorization denied</h2><p>${error}: ${url.searchParams.get("error_description") || ""}</p></body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }
  if (!code) return new Response("Missing authorization code", { status: 400 });

  const stateRecord = await env.OAUTH_KV.get<OAuthStateRecord>(`oauth_state:${rawState}`, "json");
  if (!stateRecord) {
    return new Response("OAuth state expired. Please restart the authorization flow.", { status: 400 });
  }
  await env.OAUTH_KV.delete(`oauth_state:${rawState}`);

  // Resolve Google credentials: DCR record → env var fallback
  const clientRecord = await env.OAUTH_KV.get<DCRClientRecord>(`client:${stateRecord.clientId}`, "json");
  const googleClientId     = stateRecord.googleClientId || clientRecord?.google_client_id || env.GOOGLE_OAUTH_CLIENT_ID || "";
  const googleClientSecret = clientRecord?.google_client_secret || env.GOOGLE_OAUTH_CLIENT_SECRET || "";

  console.log(`[callback] state=${rawState}, googleClientId=${googleClientId ? "SET" : "MISSING"}, googleClientSecret=${googleClientSecret ? "SET" : "MISSING"}`);

  if (!googleClientId || !googleClientSecret) {
    return new Response(
      `<html><body><h2>Configuration Error</h2>
       <p>Google OAuth credentials not found. Please reconnect and ensure you provide both Client ID and Client Secret.</p>
       <p>Debug: clientId=${googleClientId ? "present" : "MISSING"}, secret=${googleClientSecret ? "present" : "MISSING"}</p>
       </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }

  // Exchange authorization code with Google
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      client_id:     googleClientId,
      client_secret: googleClientSecret,
      code,
      redirect_uri:  `${env.PUBLIC_BASE_URL}/callback`,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    console.error("[callback] Google token exchange failed:", errText);
    return new Response(
      `<html><body><h2>Authorization Error</h2>
       <p>Google token exchange failed (${tokenResponse.status}).</p>
       <p>Details: ${errText}</p>
       <p>Please check your Google OAuth credentials and try again.</p>
       </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }

  const googleTokens = await tokenResponse.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type: string;
  };

  if (!googleTokens.refresh_token) {
    console.error("[callback] Google did not return refresh_token");
    return new Response(
      `<html><body><h2>Authorization Error</h2>
       <p>Google did not return a refresh token.</p>
       <p>Please revoke this app's access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and try again.</p>
       </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }

  // Store Google tokens in TOKENS_KV
  const sub = crypto.randomUUID();
  await storeTokens(
    sub,
    googleTokens.access_token,
    googleTokens.refresh_token,
    googleTokens.expires_in || 3600,
    googleClientId,
    googleClientSecret,
    env.TOKENS_KV,
  );

  // Issue proxy JWT and store as pending for /token to collect (TTL 2 min)
  const proxyJWT = await signJWT({ sub }, env.JWT_SECRET, 30 * 24 * 3600);
  const tempCode = crypto.randomUUID();
  await env.OAUTH_KV.put(`pending_jwt:${tempCode}`, proxyJWT, { expirationTtl: 120 });

  console.log(`[callback] SUCCESS sub=${sub}, tempCode=${tempCode}`);

  const clientRedirect = new URL(stateRecord.redirectUri);
  clientRedirect.searchParams.set("code",  tempCode);
  clientRedirect.searchParams.set("state", rawState);
  return Response.redirect(clientRedirect.toString(), 302);
}

// ── POST /token — Return the pending JWT created at /callback ─────────────────

export async function handleToken(request: Request, env: Env): Promise<Response> {
  let body: Record<string, string> = {};
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    body = (await request.json()) as Record<string, string>;
  } else {
    const fd = await request.formData();
    fd.forEach((v, k) => { body[k] = v.toString(); });
  }

  const { grant_type, code } = body;

  if (grant_type !== "authorization_code") {
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }
  if (!code) {
    return Response.json({ error: "invalid_request", error_description: "Missing code" }, { status: 400 });
  }

  // Retrieve the proxy JWT that /callback created
  const proxyJWT = await env.OAUTH_KV.get(`pending_jwt:${code}`);
  if (!proxyJWT) {
    console.error(`[token] pending_jwt not found for code=${code}`);
    return Response.json({ error: "invalid_grant", error_description: "Code expired or already used. Please reconnect." }, { status: 400 });
  }
  await env.OAUTH_KV.delete(`pending_jwt:${code}`);

  console.log(`[token] SUCCESS — issued JWT`);
  return Response.json({
    access_token: proxyJWT,
    token_type:   "bearer",
    expires_in:   2592000,
  });
}
