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
