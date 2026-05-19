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

const GOOGLE_AUTH_URL     = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL    = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

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

type HonoEnv = { Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } };

const app = new Hono<HonoEnv>();

// ── GET /authorize → save Claude.ai's request → redirect to Google ────────────

app.get("/authorize", async (c) => {
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
  googleUrl.searchParams.set("scope",         GOOGLE_SCOPES);
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

export { app as GoogleHandler };
