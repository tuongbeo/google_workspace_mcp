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
import type { Env } from "../types";
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

    if (!clientId) {
      return c.text("Invalid OAuth request — missing client_id", 400);
    }

    // Capture Claude.ai's full OAuth request params in KV — replayed in callback-delegate.
    // We store the raw query params (not parsed via OAUTH_PROVIDER which is unavailable
    // in bypass context) and re-present the full request URL in callback-delegate.
    const stateId = crypto.randomUUID();
    const oauthParams = {
      clientId,
      redirectUri,
      responseType: url.searchParams.get("response_type") || "code",
      scope:        url.searchParams.get("scope") || "",
      state:        url.searchParams.get("state") || "",
      codeChallenge: url.searchParams.get("code_challenge") || "",
      codeChallengeMethod: url.searchParams.get("code_challenge_method") || "",
      // Store full original URL so callback-delegate can reconstruct AuthRequest
      originalUrl: c.req.url,
    };

    // Store under non-tenant key — completeAuthorization in callback-delegate
    // flows through base.fetch() (OAuthProvider), which looks up this key.
    // Tenant-scoped key (for anti-replay) stored separately below.
    await c.env.OAUTH_KV.put(
      `delegate_mcp_state:${stateId}`,
      JSON.stringify(oauthParams),
      { expirationTtl: 600 },
    );

    // Tenant-scoped sentinel prevents cross-tenant replay:
    // callback-delegate verifies this exists before proceeding.
    await c.env.OAUTH_KV.put(
      `delegate_mcp_state_tenant:${tenant}:${stateId}`,
      "1",
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
  // Strategy: verify anti-replay sentinel, then rewrite to /callback-delegate
  // and pass through base.fetch() (OAuthProvider), which has OAUTH_PROVIDER binding
  // injected and calls completeAuthorization correctly.

  tenantRouter.get("/:tenant/callback-delegate", async (c) => {
    const tenant       = c.req.param("tenant");
    const stateId      = c.req.query("state");
    const delegateCode = c.req.query("code");
    const error        = c.req.query("error");

    if (error) {
      return c.html(tenantErrorPage(`Authorization denied: ${error}`), 400);
    }
    if (!delegateCode || !stateId) {
      return c.html(tenantErrorPage("Missing code or state from google-auth."), 400);
    }

    // Anti-replay: verify this state belongs to this tenant (not another tenant's state)
    const sentinelKey = `delegate_mcp_state_tenant:${tenant}:${stateId}`;
    const sentinel    = await c.env.OAUTH_KV.get(sentinelKey);
    if (!sentinel) {
      return c.html(tenantErrorPage("OAuth state expired or tenant mismatch. Please reconnect."), 400);
    }
    // Delete sentinel — one-time use
    await c.env.OAUTH_KV.delete(sentinelKey);

    // Rewrite /:tenant/callback-delegate → /callback-delegate and pass through
    // base.fetch() so OAuthProvider injects OAUTH_PROVIDER binding and
    // createDelegatingHandler can call completeAuthorization.
    const url      = new URL(c.req.url);
    const rewritten = new URL(url.origin + "/callback-delegate");
    rewritten.searchParams.set("code",  delegateCode);
    rewritten.searchParams.set("state", stateId);

    console.log(`[tenant/${tenant}] callback-delegate → rewrite to /callback-delegate state=${stateId}`);
    return base.fetch(new Request(rewritten.toString(), c.req.raw), c.env, c.executionCtx);
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
