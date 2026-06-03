/**
 * auth/google.ts — Delegating OAuth Handler
 *
 * Delegates Google authentication to the centralized google-auth worker.
 * Each MCP worker (workspace/office/plan/social) uses this handler —
 * they never talk to Google OAuth directly.
 *
 * Flow:
 *   GET /authorize       → redirect to google-auth /delegate/authorize
 *   GET /callback-delegate ← google-auth redirects back with one-time code
 *                          → POST /delegate/verify → {sub, email}
 *                          → completeAuthorization → issue MCP JWT
 */

import { Hono } from "hono";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env, OAuthProps } from "../types";

type HonoEnv = { Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } };

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
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Google Workspace MCP — Auth Error</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    display:flex;align-items:center;justify-content:center;
    min-height:100vh;background:#ffffff;color:#111827}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:40px 48px;
    box-shadow:0 1px 4px rgba(0,0,0,.06);max-width:480px;width:100%;text-align:center}
  .icon{font-size:32px;margin-bottom:16px}
  h2{font-size:18px;font-weight:600;color:#dc2626;margin-bottom:10px}
  p{font-size:15px;color:#374151;line-height:1.6}
  .hint{margin-top:16px;font-size:13px;color:#6b7280}
</style></head>
<body><div class="card">
  <div class="icon">⚠️</div>
  <h2>Authentication Error</h2>
  <p>${message}</p>
  <p class="hint">Please try disconnecting and reconnecting the connector in Claude.ai.</p>
</div></body></html>`;
}


