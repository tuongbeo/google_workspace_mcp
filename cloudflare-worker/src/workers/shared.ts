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
import type { McpAgent } from "agents/mcp";
import type { Env, OAuthProps } from "../types";
import { createDelegatingHandler } from "../auth/google";

interface WorkerConfig {
  /** Short service name, e.g. "mcp-office". Used in /health response. */
  service: string;
  /** The McpAgent subclass to serve at /mcp. */
  agent: typeof McpAgent<Env, Record<string, never>, OAuthProps>;
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

  // The agent's token namespace is actually sourced from env.TOKEN_NAMESPACE
  // (Durable Objects are constructed by the platform, not by this factory, so
  // `config.namespace` can't be injected into the agent directly). Surface both
  // here so a mismatch between the wrangler `vars` and this entry point's config
  // — the exact drift that would silently misroute token storage — shows up in
  // health checks instead of failing silently.
  router.get("/health", (c) => {
    const envNamespace = c.env.TOKEN_NAMESPACE;
    return c.json({
      status: envNamespace && envNamespace !== namespace ? "namespace_mismatch" : "ok",
      service,
      version: "1.0.0",
      transport: "websocket-durable-object",
      namespace: { configured: namespace, env: envNamespace ?? null },
      timestamp: new Date().toISOString(),
    });
  });

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

  // RFC 8414 §3.1 path-suffix style: /.well-known/oauth-authorization-server/:tenant
  // Claude fetches this URL when issuer = https://host/:tenant (not https://host).
  // Must be in the base router (not tenantRouter) because path starts with /.well-known/.
  router.get("/.well-known/oauth-authorization-server/:tenant", (c) => {
    const tenant = c.req.param("tenant");
    const origin = new URL(c.req.url).origin;
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Cache-Control", "public, max-age=300");
    return c.json({
      issuer:                                `${origin}/${tenant}`,
      authorization_endpoint:                `${origin}/${tenant}/authorize`,
      token_endpoint:                        `${origin}/${tenant}/token`,
      registration_endpoint:                 `${origin}/${tenant}/register`,
      scopes_supported:                      ["openid", "email"],
      response_types_supported:              ["code"],
      grant_types_supported:                 ["authorization_code", "refresh_token"],
      code_challenge_methods_supported:      ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  // RFC 8414 §3.1 path-suffix style: /.well-known/openid-configuration/:tenant
  // Some clients try this as fallback. Return same metadata as oauth-authorization-server.
  router.get("/.well-known/openid-configuration/:tenant", (c) => {
    const tenant = c.req.param("tenant");
    const origin = new URL(c.req.url).origin;
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Cache-Control", "public, max-age=300");
    return c.json({
      issuer:                                `${origin}/${tenant}`,
      authorization_endpoint:                `${origin}/${tenant}/authorize`,
      token_endpoint:                        `${origin}/${tenant}/token`,
      registration_endpoint:                 `${origin}/${tenant}/register`,
      scopes_supported:                      ["openid", "email"],
      response_types_supported:              ["code"],
      grant_types_supported:                 ["authorization_code", "refresh_token"],
      code_challenge_methods_supported:      ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
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
      if (
        pathname === "/health" ||
        pathname.startsWith("/.well-known/")
      ) {
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

  // Tenant router handles /:tenant/authorize, /:tenant/callback-delegate,
  // and /:tenant/.well-known/* (OAuth discovery for tenant-specific auth).
  // All bypass OAuthProvider — they are not MCP OAuth flows.
  const tenantRouter = new Hono<{ Bindings: Env }>();

  // ── GET /:tenant/.well-known/oauth-protected-resource ─────────────────────
  // RFC 9728 resource discovery — tells Claude which authorization server to use.
  // Claude fetches this to discover /:tenant/authorize endpoint.

  tenantRouter.get("/:tenant/.well-known/oauth-protected-resource", (c) => {
    const tenant = c.req.param("tenant");
    const base   = new URL(c.req.url).origin;
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Cache-Control", "public, max-age=300");
    return c.json({
      resource:                 `${base}/${tenant}/mcp`,
      authorization_servers:    [`${base}/${tenant}`],
      scopes_supported:         ["openid", "email"],
      bearer_methods_supported: ["header"],
    });
  });

  // ── GET /:tenant/.well-known/oauth-authorization-server ───────────────────
  // OAuth 2.0 Authorization Server Metadata (RFC 8414) — Claude reads this
  // to discover authorize/token/register endpoints for this tenant.

  tenantRouter.get("/:tenant/.well-known/oauth-authorization-server", (c) => {
    const tenant = c.req.param("tenant");
    const base   = new URL(c.req.url).origin;
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Cache-Control", "public, max-age=300");
    return c.json({
      issuer:                                `${base}/${tenant}`,
      authorization_endpoint:                `${base}/${tenant}/authorize`,
      token_endpoint:                        `${base}/${tenant}/token`,
      registration_endpoint:                 `${base}/${tenant}/register`,
      scopes_supported:                      ["openid", "email"],
      response_types_supported:              ["code"],
      grant_types_supported:                 ["authorization_code", "refresh_token"],
      code_challenge_methods_supported:      ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  // ── GET /:tenant/token — proxy to base /token (OAuthProvider handles it) ──
  // Claude POSTs to /:tenant/token after getting the code — rewrite to /token.

  tenantRouter.post("/:tenant/token", async (c) => {
    const url       = new URL(c.req.url);
    const rewritten = new Request(url.origin + "/token" + url.search, c.req.raw);
    return base.fetch(rewritten, c.env, c.executionCtx);
  });

  // ── GET /:tenant/register — proxy to base /register ───────────────────────

  tenantRouter.post("/:tenant/register", async (c) => {
    const url       = new URL(c.req.url);
    const rewritten = new Request(url.origin + "/register" + url.search, c.req.raw);
    return base.fetch(rewritten, c.env, c.executionCtx);
  });

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
      if (segments.length >= 1 && isTenantPath(segments[0])) {
        const tenant  = segments[0];
        const subPath = segments.length >= 2
          ? "/" + segments.slice(1).join("/")
          : "/";

        // Discovery + token + register: all bypass OAuthProvider, handled by tenantRouter
        if (
          subPath.startsWith("/.well-known/") ||
          (subPath === "/token"    && request.method === "POST") ||
          (subPath === "/register" && request.method === "POST") ||
          subPath === "/authorize" ||
          subPath.startsWith("/callback-delegate")
        ) {
          return tenantRouter.fetch(request, env, ctx);
        }

        if (subPath === "/mcp" || subPath.startsWith("/mcp/")) {
          const rewritten = new Request(
            url.origin + "/mcp" + url.search,
            request,
          );
          console.log(`[tenant/${tenant}] /mcp → rewrite to /mcp, method=${request.method}`);
          const response = await base.fetch(rewritten, env, ctx);
          console.log(`[tenant/${tenant}] base response status=${response.status}`);

          const wwwAuth = response.headers.get("WWW-Authenticate");
          console.log(`[tenant/${tenant}] WWW-Authenticate=${wwwAuth?.slice(0,80)}`);
          if (response.status === 401 && wwwAuth) {
            const tenantMetaUrl = `${url.origin}/${tenant}/.well-known/oauth-protected-resource`;
            const patched = wwwAuth.replace(
              /resource_metadata="[^"]*"/,
              `resource_metadata="${tenantMetaUrl}"`,
            );
            console.log(`[tenant/${tenant}] patched header=${patched.slice(0,80)}`);
            const newHeaders = new Headers(response.headers);
            newHeaders.set("WWW-Authenticate", patched);
            return new Response(response.body, {
              status:     response.status,
              statusText: response.statusText,
              headers:    newHeaders,
            });
          }
          return response;
        }
      }

      // All other paths → base worker
      return base.fetch(request, env, ctx);
    },
  };
}

function tenantErrorPage(message: string): string {
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
