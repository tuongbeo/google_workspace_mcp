/**
 * MCP Google Workspace — Cloudflare Workers Entry Point
 *
 * Routes:
 *   GET  /health                                → health check
 *   GET  /.well-known/oauth-authorization-server → OAuth discovery
 *   GET  /.well-known/oauth-protected-resource   → Resource metadata
 *   POST /register                               → Dynamic Client Registration
 *   GET  /authorize                              → OAuth authorize (redirect sang Google)
 *   GET  /callback                               → OAuth callback từ Google
 *   POST /token                                  → Exchange auth code → proxy JWT
 *   ALL  /mcp                                    → MCP Streamable HTTP endpoint (stateless)
 */

import { Hono } from "hono";
import { Env } from "./types";
import {
  buildOAuthMetadata,
  buildResourceMetadata,
  handleDCR,
  handleAuthorize,
  handleCallback,
  handleToken,
} from "./oauth";
import { handleMcpRequest } from "./mcp-agent";
import { verifyJWT } from "./jwt";

const app = new Hono<{ Bindings: Env }>();

// ── Health Check ──────────────────────────────────────────────────────────────
app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "mcp-google-workspace",
    version: "1.0.0",
    transport: "streamable-http",
    stateless: true,
    timestamp: new Date().toISOString(),
  })
);

// ── OAuth Discovery ───────────────────────────────────────────────────────────
app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json(buildOAuthMetadata(c.env.PUBLIC_BASE_URL))
);

app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json(buildResourceMetadata(c.env.PUBLIC_BASE_URL))
);

// ── Dynamic Client Registration ───────────────────────────────────────────────
app.post("/register", async (c) => handleDCR(c.req.raw, c.env));

// ── OAuth Flow ────────────────────────────────────────────────────────────────
app.get("/authorize", async (c) => handleAuthorize(c.req.raw, c.env));
app.get("/callback", async (c) => handleCallback(c.req.raw, c.env));
app.post("/token", async (c) => handleToken(c.req.raw, c.env));

// ── MCP Endpoint (Streamable HTTP — stateless) ────────────────────────────────
app.all("/mcp", async (c) => {
  const env = c.env;
  const auth = c.req.header("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();

  // Không có token → 401 kèm WWW-Authenticate để Claude.ai trigger OAuth discovery
  if (!token) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": [
          `Bearer realm="${env.PUBLIC_BASE_URL}"`,
          `resource_metadata_url="${env.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`,
        ].join(", "),
      },
    });
  }

  // Validate proxy JWT
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) {
    return new Response(
      JSON.stringify({
        error: "invalid_token",
        error_description: "Token is invalid or expired. Please re-authorize.",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Delegate sang MCP handler
  return handleMcpRequest(c.req.raw, env);
});

// ── 404 Fallback ──────────────────────────────────────────────────────────────
app.notFound((c) =>
  c.json(
    {
      error: "not_found",
      available_endpoints: [
        "GET /health",
        "GET /.well-known/oauth-authorization-server",
        "GET /.well-known/oauth-protected-resource",
        "POST /register",
        "GET /authorize",
        "GET /callback",
        "POST /token",
        "ALL /mcp",
      ],
    },
    404
  )
);

export default app;
