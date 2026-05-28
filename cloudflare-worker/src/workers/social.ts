/**
 * Social Worker — Entry Point
 *
 * Serves: Google Chat, Contacts tools (~14 tools)
 * Domain: social.tuongbeo.workers.dev
 * Scopes: SCOPES_SOCIAL
 * Namespace: "social"
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env } from "../types";
import { SocialAgent } from "./agents/social-agent";
import { createGoogleHandler } from "../auth/google";
import { SCOPES_SOCIAL } from "../auth/scopes";

const router = new Hono<{ Bindings: Env }>();

router.get("/health", (c) => c.json({
  status: "ok",
  service: "mcp-social",
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
  apiHandler:                 SocialAgent.serve("/mcp", { binding: "MCP_SERVER" }),
  defaultHandler:             createGoogleHandler(SCOPES_SOCIAL, "social"),
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

export { SocialAgent };
