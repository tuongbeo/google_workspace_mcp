/**
 * Shared worker factory — eliminates copy-paste across office/plan/social entry points.
 *
 * Each sub-worker only differs in:
 *   - service name (for logging / health)
 *   - McpAgent subclass
 *   - OAuth scopes
 *   - token namespace
 *
 * Usage:
 *   export default createWorker({
 *     service: "mcp-office",
 *     agent:   OfficeAgent,
 *     scopes:  SCOPES_OFFICE,
 *     namespace: "office",
 *   });
 *   export { OfficeAgent };
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env, OAuthProps } from "../types";
import { createDelegatingHandler } from "../auth/google";

interface WorkerConfig {
  /** Short service name, e.g. "mcp-office". Used in /health response. */
  service: string;
  /** The McpAgent subclass to serve at /mcp. Must have a static .serve() method. */
  agent: { serve: (path: string, opts: { binding: string }) => unknown };
  /**
   * Server name registered in google-auth's mcp_servers table.
   * Used to route /delegate/authorize correctly.
   * e.g. "office" | "plan" | "social"
   */
  serverName: string;
  /** Token storage namespace, e.g. "office". Must match the agent's makeGetCreds call. */
  namespace: string;
}

/**
 * Build a Cloudflare Worker default export for a sub-worker.
 * Returns an object suitable for `export default`.
 */
export function createWorker(config: WorkerConfig) {
  const { service, agent, serverName, namespace } = config;

  const router = new Hono<{ Bindings: Env }>();

  router.get("/health", (c) =>
    c.json({
      status: "ok",
      service,
      version: "1.0.0",
      transport: "websocket-durable-object",
      timestamp: new Date().toISOString(),
    })
  );

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

  const oauthProvider = new OAuthProvider({
    apiRoute:                   "/mcp",
    apiHandler:                 agent.serve("/mcp", { binding: "MCP_SERVER" }),
    defaultHandler:             createDelegatingHandler(serverName),
    authorizeEndpoint:          "/authorize",
    tokenEndpoint:              "/token",
    clientRegistrationEndpoint: "/register",
  });

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === "/health" || pathname === "/.well-known/oauth-protected-resource") {
        return router.fetch(request, env, ctx);
      }
      return oauthProvider.fetch(request, env, ctx);
    },
  };
}

// ─── withTenantRouting ────────────────────────────────────────────────────────
//
// Wraps a base worker (from createWorker) to additionally serve multi-tenant
// routes at /:tenant/{authorize,callback-delegate,mcp}.
//
// Security:
//   - Tenant names (slugs) are validated: lowercase letters, numbers, hyphens only,
//     and must not collide with base-worker reserved paths.
//   - KV state keys are tenant-scoped: delegate_mcp_state:{tenant}:{stateId}
//     to prevent cross-tenant state replay.
//   - /:tenant/mcp rewrites pathname to /mcp so OAuthProvider performs auth check.
//   - /:tenant/authorize and /:tenant/callback-delegate bypass OAuthProvider
//     (they are Google OAuth flows, not MCP OAuth flows).
//
// Usage:
//   export default withTenantRouting(createWorker({...}), config);

const RESERVED_PATHS = new Set([
  "health", "mcp", "authorize", "callback-delegate",
  "register", "token", ".well-known",
]);
const TENANT_SLUG_REGEX = /^[a-z0-9-]+$/;

function isTenantPath(segment: string): boolean {
  return TENANT_SLUG_REGEX.test(segment) && !RESERVED_PATHS.has(segment);
}

export function withTenantRouting(
  base: ReturnType<typeof createWorker>,
  config: WorkerConfig,
): { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> } {
  const { serverName } = config;

  // Tenant router handles /:tenant/authorize and /:tenant/callback-delegate.
  // These bypass OAuthProvider — they are Google OAuth flows, not MCP flows.
  const tenantRouter = new Hono<{ Bindings: Env }>();

  // ── GET /:tenant/authorize → delegate to google-auth ─────────────────────

  tenantRouter.get("/:tenant/authorize", async (c) => {
    const tenant  = c.req.param("tenant");
    const url     = new URL(c.req.url);
    const clientId    = url.searchParams.get("client_id") || "";
    const redirectUri = url.searchParams.get("redirect_uri") || "";

    // Auto-register MCP client (same pattern as createDelegatingHandler)
    if (clientId && redirectUri) {
      const existing = await c.env.OAUTH_KV.get(`client:${clientId}`);
      if (!existing) {
        await c.env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify({
          clientId,
          redirectUris: [redirectUri],
          grantTypes:   ["authorization_code", "refresh_token"],
          responseTypes: ["code"],
          registrationDate: Math.floor(Date.now() / 1000),
          tokenEndpointAuthMethod: "none",
        }));
      }
    }

    const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    if (!oauthReqInfo.clientId) {
      return c.text("Invalid OAuth request — missing client_id", 400);
    }

    // Tenant-scoped state key prevents cross-tenant replay
    const stateId = crypto.randomUUID();
    await c.env.OAUTH_KV.put(
      `delegate_mcp_state:${tenant}:${stateId}`,
      JSON.stringify(oauthReqInfo),
      { expirationTtl: 600 },
    );

    const workerBase  = url.origin;
    const callbackUrl = `${workerBase}/${tenant}/callback-delegate`;

    const delegateUrl = new URL(`${c.env.GOOGLE_AUTH_BASE_URL}/delegate/authorize`);
    delegateUrl.searchParams.set("server",       tenant);
    delegateUrl.searchParams.set("callback_url", callbackUrl);
    delegateUrl.searchParams.set("state",        stateId);
    if (clientId) delegateUrl.searchParams.set("client_id", clientId);

    console.log(`[tenant/${tenant}] authorize → google-auth, state=${stateId}`);
    return c.redirect(delegateUrl.toString());
  });

  // ── GET /:tenant/callback-delegate ← google-auth redirects here ──────────

  tenantRouter.get("/:tenant/callback-delegate", async (c) => {
    const tenant       = c.req.param("tenant");
    const delegateCode = c.req.query("code");
    const stateId      = c.req.query("state");
    const error        = c.req.query("error");

    if (error) {
      return c.html(tenantErrorPage(`Authorization denied: ${error}`), 400);
    }
    if (!delegateCode || !stateId) {
      return c.html(tenantErrorPage("Missing code or state from google-auth."), 400);
    }

    // Restore Claude.ai's original OAuth request (tenant-scoped key)
    const savedState = await c.env.OAUTH_KV.get(`delegate_mcp_state:${tenant}:${stateId}`);
    if (!savedState) {
      return c.html(tenantErrorPage("OAuth state expired. Please reconnect."), 400);
    }
    const oauthReqInfo = JSON.parse(savedState);
    await c.env.OAUTH_KV.delete(`delegate_mcp_state:${tenant}:${stateId}`);

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
        console.error(`[tenant/${tenant}] verify failed ${res.status}: ${body}`);
        return c.html(tenantErrorPage(`Auth verification failed (${res.status}). Please reconnect.`), 400);
      }
      verifyResult = await res.json() as { sub: string; email: string; role: string };
    } catch (err) {
      console.error(`[tenant/${tenant}] verify network error:`, err);
      return c.html(tenantErrorPage("Could not reach auth server. Please try again."), 502);
    }

    const { sub, email } = verifyResult;
    console.log(`[tenant/${tenant}] verify OK sub=${sub} email=${email}`);

    const props: OAuthProps = { google_sub: sub, email };
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId:  sub,
      scope:   oauthReqInfo.scope,
      props,
    });

    return c.redirect(redirectTo);
  });

  // ── Fetch dispatcher ──────────────────────────────────────────────────────

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url      = new URL(request.url);
      const segments = url.pathname.split("/").filter(Boolean); // ['tenant', 'mcp']

      // Check if first path segment looks like a tenant slug
      if (segments.length >= 2 && isTenantPath(segments[0])) {
        const tenant   = segments[0];
        const subPath  = "/" + segments.slice(1).join("/"); // '/mcp', '/authorize', etc.

        if (subPath === "/authorize" || subPath.startsWith("/callback-delegate")) {
          // Bypass OAuthProvider — these are Google OAuth flows, not MCP flows
          return tenantRouter.fetch(request, env, ctx);
        }

        if (subPath === "/mcp" || subPath.startsWith("/mcp/")) {
          // Rewrite /:tenant/mcp → /mcp so OAuthProvider handles auth + MCP correctly
          const rewritten = new Request(
            url.origin + "/mcp" + url.search,
            request,
          );
          console.log(`[tenant/${tenant}] /mcp → rewrite to /mcp`);
          return base.fetch(rewritten, env, ctx);
        }
      }

      // All other paths (including /health, /mcp, /authorize, /callback-delegate) → base worker
      return base.fetch(request, env, ctx);
    },
  };
}

function tenantErrorPage(message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Office MCP — Auth Error</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;background:#f8f9fa}.card{background:#fff;border-radius:12px;padding:40px;
box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:480px;text-align:center}
h2{color:#d93025;margin-bottom:12px}p{color:#555;line-height:1.6}</style></head>
<body><div class="card"><h2>Authentication Error</h2><p>${message}</p>
<p style="margin-top:16px;font-size:13px">Please try disconnecting and reconnecting the connector in Claude.ai.</p>
</div></body></html>`;
}
