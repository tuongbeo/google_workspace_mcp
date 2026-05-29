/**
 * Google OAuth Handler — replaces hand-rolled oauth.ts
 *
 * Pattern: Cloudflare workers-oauth-provider + Google OAuth 2.0
 *
 * Flow:
 *   GET /authorize → parse Claude.ai's OAuth request → save state → redirect to Google
 *   GET /callback  → exchange code with Google → store Google tokens → completeAuthorization
 */

import { Hono } from "hono";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env, OAuthProps } from "../types";
import { storeTokens } from "../google-tokens";
import { SCOPES_WORKSPACE } from "./scopes";

const GOOGLE_AUTH_URL     = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL    = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

type HonoEnv = { Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } };

/**
 * Factory: create a Google OAuth handler for a specific set of scopes and token namespace.
 * @param scopes - OAuth scopes to request from Google
 * @param namespace - Token storage namespace (e.g. "workspace", "office", "plan", "social")
 */
export function createGoogleHandler(
  scopes: string[],
  namespace = "workspace",
): Hono<HonoEnv> {
  const scopeString = scopes.join(" ");
  const app = new Hono<HonoEnv>();

// ── GET /authorize → save Claude.ai's request → redirect to Google ────────────

  app.get("/authorize", async (c) => {
  const url = new URL(c.req.url);
  const clientId   = url.searchParams.get("client_id")   || "";
  const redirectUri = url.searchParams.get("redirect_uri") || "";

  // Claude.ai's Advanced Settings sends the Google OAuth client_id directly.
  // OAuthProvider requires every client_id to be pre-registered in OAUTH_KV.
  // Auto-register on first authorize if not already present.
  if (clientId && redirectUri) {
    const existing = await c.env.OAUTH_KV.get(`client:${clientId}`);
    if (!existing) {
      // Register as public client (no clientSecret stored).
      // Claude.ai uses PKCE (S256) which provides equivalent security for public clients.
      // We strip client_secret from /token requests in index.ts, so no secret validation needed.
      await c.env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify({
        clientId,
        redirectUris: [redirectUri],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        registrationDate: Math.floor(Date.now() / 1000),
        tokenEndpointAuthMethod: "none",
      }));
      console.log(`[auth] auto-registered public client ${clientId.slice(-20)}`);
    }
  }

  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request — missing client_id", 400);
  }

  // Save Claude.ai's OAuth request in KV (linked via state param)
  const stateId = crypto.randomUUID();
  await c.env.OAUTH_KV.put(
    `oauth_state:${stateId}`,
    JSON.stringify(oauthReqInfo),
    { expirationTtl: 600 },
  );

  const callbackUrl = new URL("/callback", c.req.url).href;
  const googleUrl   = new URL(GOOGLE_AUTH_URL);
  googleUrl.searchParams.set("client_id",     c.env.GOOGLE_OAUTH_CLIENT_ID);
  googleUrl.searchParams.set("redirect_uri",  callbackUrl);
  googleUrl.searchParams.set("response_type", "code");
  googleUrl.searchParams.set("scope",         scopeString);
  googleUrl.searchParams.set("state",         stateId);
  googleUrl.searchParams.set("access_type",   "offline");
  googleUrl.searchParams.set("prompt",        "consent");

  console.log(`[auth] authorize → Google, state=${stateId}`);
  return c.redirect(googleUrl.toString());
});

// ── GET /callback ← Google redirects here ────────────────────────────────────

  app.get("/callback", async (c) => {
  const code    = c.req.query("code");
  const stateId = c.req.query("state");
  const error   = c.req.query("error");

  if (error) {
    return c.html(errorPage(`Google OAuth denied: ${error}`), 400);
  }
  if (!code || !stateId) {
    return c.html(errorPage("Missing code or state parameter."), 400);
  }

  // Restore Claude.ai's original OAuth request
  const savedState = await c.env.OAUTH_KV.get(`oauth_state:${stateId}`);
  if (!savedState) {
    return c.html(errorPage("OAuth state expired. Please reconnect."), 400);
  }
  const oauthReqInfo = JSON.parse(savedState);
  await c.env.OAUTH_KV.delete(`oauth_state:${stateId}`);

  // Exchange code with Google
  const callbackUrl = new URL("/callback", c.req.url).href;
  const tokenRes    = await fetch(GOOGLE_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      client_id:     c.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: c.env.GOOGLE_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri:  callbackUrl,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("[auth] Google token exchange failed:", err);
    return c.html(errorPage(`Google token exchange failed (${tokenRes.status}).`), 400);
  }

  const googleTokens = await tokenRes.json() as {
    access_token: string; refresh_token?: string; expires_in?: number;
  };

  if (!googleTokens.refresh_token) {
    return c.html(errorPage(
      "Google did not return a refresh token. " +
      "Please revoke access at myaccount.google.com/permissions and reconnect."
    ), 400);
  }

  // Fetch stable Google user ID
  const userRes  = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${googleTokens.access_token}` },
  });
  if (!userRes.ok) {
    return c.html(errorPage("Could not fetch Google user info."), 400);
  }
  const userInfo = await userRes.json() as { sub: string; email: string };
  const sub      = userInfo.sub;

  console.log(`[auth] callback OK sub=${sub}, email=${userInfo.email}`);

  // Store Google tokens in TOKENS_KV (tool calls will use these)
  await storeTokens(
    sub,
    googleTokens.access_token,
    googleTokens.refresh_token,
    googleTokens.expires_in || 3600,
    c.env.GOOGLE_OAUTH_CLIENT_ID,
    c.env.GOOGLE_OAUTH_CLIENT_SECRET,
    c.env.TOKENS_KV,
    namespace,
  );

  // Complete OAuth: OAuthProvider issues MCP session token to Claude.ai
  const props: OAuthProps = { google_sub: sub, email: userInfo.email };
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request:  oauthReqInfo,
    userId:   sub,
    scope:    oauthReqInfo.scope,
    props,
  });

  return c.redirect(redirectTo);
  });

  return app;
} // end createGoogleHandler

// ── Backward-compatible export (Workspace full worker) ────────────────────────
export const GoogleHandler = createGoogleHandler(SCOPES_WORKSPACE, "workspace");

// ─── Delegating Handler — uses google-auth as centralized OAuth ───────────────

/**
 * Factory: create an OAuth handler that delegates Google auth to google-auth worker.
 *
 * Flow:
 *   GET /authorize  → save OAuthProvider state → redirect google-auth /delegate/authorize
 *   GET /callback-delegate ← google-auth redirects back with one-time code
 *                          → POST /delegate/verify → get {sub, email}
 *                          → completeAuthorization → issue MCP JWT
 *
 * @param serverName  Server name registered in google-auth's mcp_servers table
 *                    (e.g. "office", "plan", "social", "workspace")
 */
export function createDelegatingHandler(serverName: string): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  // ── GET /authorize → redirect to google-auth ─────────────────────────────

  app.get("/authorize", async (c) => {
    const url      = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id") || "";
    const redirectUri = url.searchParams.get("redirect_uri") || "";

    // Auto-register MCP client (same pattern as createGoogleHandler)
    if (clientId && redirectUri) {
      const existing = await c.env.OAUTH_KV.get(`client:${clientId}`);
      if (!existing) {
        await c.env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify({
          clientId,
          redirectUris: [redirectUri],
          grantTypes: ["authorization_code", "refresh_token"],
          responseTypes: ["code"],
          registrationDate: Math.floor(Date.now() / 1000),
          tokenEndpointAuthMethod: "none",
        }));
        console.log(`[delegate-auth/${serverName}] auto-registered client ${clientId.slice(-20)}`);
      }
    }

    const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    if (!oauthReqInfo.clientId) {
      return c.text("Invalid OAuth request — missing client_id", 400);
    }

    // Save Claude.ai's OAuth request in KV
    const stateId = crypto.randomUUID();
    await c.env.OAUTH_KV.put(
      `delegate_mcp_state:${stateId}`,
      JSON.stringify(oauthReqInfo),
      { expirationTtl: 600 },
    );

    // Callback URL on THIS worker — google-auth will redirect here after auth
    const workerBase  = new URL(c.req.url).origin;
    const callbackUrl = `${workerBase}/callback-delegate`;

    const delegateUrl = new URL(`${c.env.GOOGLE_AUTH_BASE_URL}/delegate/authorize`);
    delegateUrl.searchParams.set("server",       serverName);
    delegateUrl.searchParams.set("callback_url", callbackUrl);
    delegateUrl.searchParams.set("state",        stateId);

    console.log(`[delegate-auth/${serverName}] authorize → google-auth, state=${stateId}`);
    return c.redirect(delegateUrl.toString());
  });

  // ── GET /callback-delegate ← google-auth redirects here ──────────────────

  app.get("/callback-delegate", async (c) => {
    const delegateCode = c.req.query("code");
    const stateId      = c.req.query("state");
    const error        = c.req.query("error");

    if (error) {
      return c.html(errorPage(`Authorization denied: ${error}`), 400);
    }
    if (!delegateCode || !stateId) {
      return c.html(errorPage("Missing code or state from google-auth."), 400);
    }

    // Restore Claude.ai's original OAuth request
    const savedState = await c.env.OAUTH_KV.get(`delegate_mcp_state:${stateId}`);
    if (!savedState) {
      return c.html(errorPage("OAuth state expired. Please reconnect."), 400);
    }
    const oauthReqInfo = JSON.parse(savedState);
    await c.env.OAUTH_KV.delete(`delegate_mcp_state:${stateId}`);

    // Verify one-time code with google-auth → get {sub, email, role}
    let verifyResult: { sub: string; email: string; role: string };
    try {
      const res = await fetch(`${c.env.GOOGLE_AUTH_BASE_URL}/delegate/verify`, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${c.env.GOOGLE_AUTH_SERVICE_TOKEN}`,
        },
        body: JSON.stringify({ code: delegateCode }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error(`[delegate-auth/${serverName}] verify failed ${res.status}: ${body}`);
        return c.html(errorPage(`Auth verification failed (${res.status}). Please reconnect.`), 400);
      }
      verifyResult = await res.json() as { sub: string; email: string; role: string };
    } catch (err) {
      console.error(`[delegate-auth/${serverName}] verify network error:`, err);
      return c.html(errorPage("Could not reach auth server. Please try again."), 502);
    }

    const { sub, email } = verifyResult;
    console.log(`[delegate-auth/${serverName}] verify OK sub=${sub} email=${email}`);

    // Complete OAuth: OAuthProvider issues MCP session token to Claude.ai
    const props: OAuthProps = { google_sub: sub, email };
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId:  sub,
      scope:   oauthReqInfo.scope,
      props,
    });

    return c.redirect(redirectTo);
  });

  return app;
}

// ── Error page helper ─────────────────────────────────────────────────────────

function errorPage(message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Google Workspace MCP — Auth Error</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;background:#f8f9fa}.card{background:#fff;border-radius:12px;padding:40px;
box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:480px;text-align:center}
h2{color:#d93025;margin-bottom:12px}p{color:#555;line-height:1.6}</style></head>
<body><div class="card"><h2>Authentication Error</h2><p>${message}</p>
<p style="margin-top:16px;font-size:13px">Please try disconnecting and reconnecting the connector in Claude.ai.</p>
</div></body></html>`;
}


