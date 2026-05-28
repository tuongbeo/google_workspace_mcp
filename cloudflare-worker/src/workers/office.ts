/**
 * Office Worker — Entry Point
 *
 * Serves: Docs, Sheets, Slides, Drive, Forms, AppsScript tools (~90 tools)
 * Domain: office.tuongbeo.workers.dev
 * Scopes: SCOPES_OFFICE
 * Namespace: "office"
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env } from "../types";
import { OfficeAgent } from "./agents/office-agent";
import { createGoogleHandler } from "../auth/google";
import { SCOPES_OFFICE } from "../auth/scopes";

const router = new Hono<{ Bindings: Env }>();

router.get("/health", (c) => c.json({
  status: "ok",
  service: "mcp-office",
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
  apiHandler:                 OfficeAgent.serve("/mcp", { binding: "MCP_SERVER" }),
  defaultHandler:             createGoogleHandler(SCOPES_OFFICE, "office"),
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

export { OfficeAgent };
