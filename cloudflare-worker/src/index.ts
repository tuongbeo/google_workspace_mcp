/**
 * Google Workspace MCP Server — Entry Point v3.0
 *
 * Architecture: OAuthProvider + McpAgent (Durable Object)
 *   - OAuthProvider handles all OAuth protocol (DCR, authorize, token, refresh)
 *   - GoogleWorkspaceAgent (McpAgent/DO) handles MCP over WebSocket + hibernation
 *   - No idle timeout, no session timer, no hand-rolled JWT
 *
 * Routes (managed by OAuthProvider):
 *   POST /register                           → Dynamic Client Registration
 *   GET  /authorize                          → OAuth start → Google
 *   GET  /callback                           → OAuth callback from Google
 *   POST /token                              → Token exchange & refresh
 *   ALL  /mcp                                → McpAgent Durable Object
 *
 * Routes (manual):
 *   GET  /health                             → health check
 *   GET  /.well-known/oauth-protected-resource
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env } from "./types";
import { GoogleWorkspaceAgent } from "./mcp-worker";
import { createDelegatingHandler } from "./auth/google";

// ── Manual routes (health, manifest, protected-resource) ──────────────────────
const router = new Hono<{ Bindings: Env }>();

router.get("/health", (c) => c.json({
  status: "ok",
  service: "mcp-google-workspace",
  version: "3.0.0",
  transport: "websocket-durable-object",
  timestamp: new Date().toISOString(),
}));

router.get("/.well-known/oauth-protected-resource", (c) => {
  const base = c.env.PUBLIC_BASE_URL;
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({
    resource:                 `${base}/mcp`,
    authorization_servers:    [base],
    scopes_supported:         ["openid", "email"],
    bearer_methods_supported: ["header"],
  });
});

// ── OAuthProvider wraps McpAgent + GoogleHandler ───────────────────────────────
const oauthProvider = new OAuthProvider({
  apiRoute:                    "/mcp",
  apiHandler:                  GoogleWorkspaceAgent.serve("/mcp", { binding: "GW_SERVER" }),
  defaultHandler:              createDelegatingHandler("office"),
  authorizeEndpoint:           "/authorize",
  tokenEndpoint:               "/token",
  clientRegistrationEndpoint:  "/register",
});

// ── Main export ────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Manual routes: health, tools-manifest, protected-resource metadata
    if (
      url.pathname === "/health" ||
      url.pathname === "/.well-known/oauth-protected-resource"
    ) {
      return router.fetch(request, env, ctx);
    }

    // Everything else — OAuth (authorize, callback, token, register) + MCP
    // — handled entirely by OAuthProvider. No interception, no hand-rolled logic.
    // This mirrors ClearSpec exactly: OAuthProvider owns all OAuth state and
    // token lifecycle including refresh_token grant. Intercepting /token consumed
    // the request body stream making OAuthProvider receive an empty body → invalid_grant.
    return oauthProvider.fetch(request, env, ctx);
  },
};

// Export DO class (required by Cloudflare)
export { GoogleWorkspaceAgent };
