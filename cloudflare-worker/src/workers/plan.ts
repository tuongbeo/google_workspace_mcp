/**
 * Plan Worker — Entry Point
 *
 * Serves: Gmail, Calendar, Tasks, Search tools (~33 tools)
 * Domain: plan.tuongbeo.workers.dev
 * Scopes: SCOPES_PLAN
 * Namespace: "plan"
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env } from "../types";
import { PlanAgent } from "./agents/plan-agent";
import { createGoogleHandler } from "../auth/google";
import { SCOPES_PLAN } from "../auth/scopes";

const router = new Hono<{ Bindings: Env }>();

router.get("/health", (c) => c.json({
  status: "ok",
  service: "mcp-plan",
  version: "1.0.0",
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

const oauthProvider = new OAuthProvider({
  apiRoute:                   "/mcp",
  apiHandler:                 PlanAgent.serve("/mcp", { binding: "MCP_SERVER" }),
  defaultHandler:             createGoogleHandler(SCOPES_PLAN, "plan"),
  authorizeEndpoint:          "/authorize",
  tokenEndpoint:              "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname === "/health" ||
      url.pathname === "/.well-known/oauth-protected-resource"
    ) {
      return router.fetch(request, env, ctx);
    }
    return oauthProvider.fetch(request, env, ctx);
  },
};

export { PlanAgent };
