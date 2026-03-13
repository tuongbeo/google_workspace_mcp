/**
 * OAuth 2.0 Proxy cho Google Workspace.
 *
 * Google OAuth 2.0 flow:
 * - Authorization: https://accounts.google.com/o/oauth2/v2/auth
 * - Token: https://oauth2.googleapis.com/token
 * - Userinfo: https://www.googleapis.com/oauth2/v2/userinfo
 *
 * Flow:
 * 1. Claude.ai → GET /mcp → 401 + WWW-Authenticate
 * 2. Discover /.well-known/oauth-authorization-server
 * 3. POST /register (Dynamic Client Registration)
 * 4. GET /authorize → redirect sang Google OAuth
 * 5. User đồng ý → GET /callback
 * 6. Worker đổi code → Google tokens → issue proxy JWT
 * 7. POST /token → trả proxy JWT
 * 8. GET/POST /mcp với Bearer <proxy JWT>
 */

import { Env, OAuthStateRecord, AuthCodeRecord, DCRClientRecord } from "./types";
import { signJWT, storeTokens } from "./jwt";

// Google OAuth scopes — tất cả các services
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.spaces",
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/contacts",
].join(" ");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ── OAuth Discovery Metadata ──────────────────────────────────────────────────

export function buildOAuthMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    scopes_supported: ["openid", "email", "profile"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      "client_secret_basic",
      "none",
    ],
    code_challenge_methods_supported: ["S256", "plain"],
  };
}

export function buildResourceMetadata(baseUrl: string) {
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: ["openid", "email"],
    bearer_methods_supported: ["header"],
  };
}

// ── POST /register — Dynamic Client Registration ─────────────────────────────

export async function handleDCR(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // body không bắt buộc
  }

  const clientId = crypto.randomUUID();
  const clientSecret = crypto.randomUUID();
  const redirectUris = (body.redirect_uris as string[]) || [];

  const record: DCRClientRecord = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: redirectUris,
    client_name: (body.client_name as string) || "MCP Client",
    created_at: Date.now(),
  };

  await env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify(record), {
    expirationTtl: 604800, // 7 ngày
  });

  return Response.json(
    {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      client_name: record.client_name,
    },
    { status: 201 }
  );
}

// ── GET /authorize — Redirect sang Google OAuth ───────────────────────────────

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;

  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const state = params.get("state") || crypto.randomUUID();
  const codeChallenge = params.get("code_challenge") || "";

  const clientRecord = await env.OAUTH_KV.get<DCRClientRecord>(`client:${clientId}`, "json");
  if (!clientRecord) {
    return Response.json({ error: "invalid_client" }, { status: 400 });
  }

  const stateRecord: OAuthStateRecord = { clientId, redirectUri, state, codeChallenge };
  await env.OAUTH_KV.put(`oauth_state:${state}`, JSON.stringify(stateRecord), {
    expirationTtl: 600, // 10 phút
  });

  // Google OAuth authorize URL
  const googleParams = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    scope: GOOGLE_SCOPES,
    redirect_uri: `${env.PUBLIC_BASE_URL}/callback`,
    state: state,
    response_type: "code",
    access_type: "offline",   // bắt buộc để lấy refresh_token
    prompt: "consent",        // bắt buộc để luôn trả refresh_token
  });

  return Response.redirect(`${GOOGLE_AUTH_URL}?${googleParams}`, 302);
}

// ── GET /callback — Nhận code từ Google, đổi lấy token ───────────────────────

export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(
      `<html><body>
        <h2>Authorization denied</h2>
        <p>Error: ${error}</p>
        <p>${url.searchParams.get("error_description") || ""}</p>
        <p>Please close this window and try again.</p>
      </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }

  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  const stateRecord = await env.OAUTH_KV.get<OAuthStateRecord>(`oauth_state:${rawState}`, "json");
  if (!stateRecord) {
    return new Response(
      "OAuth state expired or invalid. Please restart the authorization flow.",
      { status: 400 }
    );
  }

  // Google token exchange
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: `${env.PUBLIC_BASE_URL}/callback`,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    console.error("Google token exchange failed:", errText);
    return new Response(`Token exchange failed: ${errText}`, { status: 502 });
  }

  const googleTokens = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type: string;
  };

  if (!googleTokens.refresh_token) {
    console.error("Google did not return refresh_token. Make sure prompt=consent and access_type=offline.");
    return new Response(
      `<html><body>
        <h2>Authorization Error</h2>
        <p>Google did not return a refresh token. Please disconnect and reconnect the integration.</p>
        <p>Make sure you are using a new Google OAuth authorization — existing authorizations may not return a refresh token.</p>
      </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }

  // Lưu Google tokens vào KV
  const sub = crypto.randomUUID();
  await storeTokens(
    sub,
    googleTokens.access_token,
    googleTokens.refresh_token,
    googleTokens.expires_in || 3600,
    "https://oauth2.googleapis.com",  // google token refresh base URL
    env.OAUTH_KV
  );

  // Issue proxy JWT — chỉ chứa sub, TTL 30 ngày
  const proxyJWT = await signJWT({ sub }, env.JWT_SECRET, 30 * 24 * 3600);

  // Lưu auth code tạm để Claude.ai đổi lấy JWT
  const authCode = crypto.randomUUID();
  const authCodeRecord: AuthCodeRecord = {
    proxy_jwt: proxyJWT,
    client_id: stateRecord.clientId,
    redirect_uri: stateRecord.redirectUri,
  };
  await env.OAUTH_KV.put(`auth_code:${authCode}`, JSON.stringify(authCodeRecord), {
    expirationTtl: 300, // 5 phút
  });

  await env.OAUTH_KV.delete(`oauth_state:${rawState}`);

  const clientRedirect = new URL(stateRecord.redirectUri);
  clientRedirect.searchParams.set("code", authCode);
  clientRedirect.searchParams.set("state", rawState);

  return Response.redirect(clientRedirect.toString(), 302);
}

// ── POST /token — Đổi auth code lấy proxy JWT ────────────────────────────────

export async function handleToken(request: Request, env: Env): Promise<Response> {
  let body: Record<string, string> = {};

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    body = (await request.json()) as Record<string, string>;
  } else {
    const formData = await request.formData();
    formData.forEach((value, key) => { body[key] = value.toString(); });
  }

  const { grant_type, code, client_id } = body;

  if (grant_type !== "authorization_code") {
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  if (!code) {
    return Response.json({ error: "invalid_request", error_description: "Missing code" }, { status: 400 });
  }

  const authCodeRecord = await env.OAUTH_KV.get<AuthCodeRecord>(`auth_code:${code}`, "json");
  if (!authCodeRecord) {
    return Response.json({ error: "invalid_grant", error_description: "Code expired or invalid" }, { status: 400 });
  }

  if (client_id && authCodeRecord.client_id !== client_id) {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }

  await env.OAUTH_KV.delete(`auth_code:${code}`);

  return Response.json({
    access_token: authCodeRecord.proxy_jwt,
    token_type: "bearer",
    expires_in: 2592000,  // 30 ngày
  });
}
