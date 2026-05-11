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
 *   POST /mcp                                    → MCP Streamable HTTP endpoint (stateless)
 *   GET  /mcp                                    → 405 (SSE not supported in stateless mode)
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
    transport: "streamable-http-stateless",
    timestamp: new Date().toISOString(),
  })
);

// ── OAuth Discovery ───────────────────────────────────────────────────────────
app.get("/.well-known/oauth-authorization-server", (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(buildOAuthMetadata(c.env.PUBLIC_BASE_URL));
});

app.get("/.well-known/oauth-protected-resource", (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(buildResourceMetadata(c.env.PUBLIC_BASE_URL));
});

// ── Dynamic Client Registration ───────────────────────────────────────────────
app.post("/register", async (c) => handleDCR(c.req.raw, c.env));

// ── OAuth Flow ────────────────────────────────────────────────────────────────
app.get("/authorize", async (c) => handleAuthorize(c.req.raw, c.env));
app.get("/callback", async (c) => handleCallback(c.req.raw, c.env));
app.post("/token", async (c) => handleToken(c.req.raw, c.env));

// ── MCP Endpoint (Streamable HTTP — stateless) ────────────────────────────────

// BUG-002 FIX: Handle OPTIONS preflight BEFORE auth check.
// Without this, browser-based MCP clients receive 401 on preflight and abort.
app.options("/mcp", (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
      "Access-Control-Max-Age": "86400",
    },
  });
});

// BUG-003 FIX: Reject GET /mcp (SSE long-poll) with 405 Method Not Allowed.
//
// Root cause of the "connection expired after 10-15 min" issue:
//   1. Claude.ai periodically sends GET /mcp to establish an SSE long-poll stream
//      for receiving server-initiated notifications.
//   2. The MCP transport (enableJsonResponse: true) handles GET by creating a
//      ReadableStream SSE response that is intended to stay open indefinitely.
//   3. After transport.handleRequest() returns, transport.close() is called to
//      clean up Protocol._transport so the next POST request can connect.
//   4. transport.close() calls cleanup() on all SSE streams, immediately closing
//      the ReadableStream. Claude.ai receives an SSE connection that opens and
//      closes instantly.
//   5. Claude.ai retries GET /mcp repeatedly. After ~10-15 min of failed SSE
//      attempts, it declares the connection "expired."
//
// Fix: Return 405 for GET /mcp. Per MCP Streamable HTTP spec §6.3.2, servers
// that do not support persistent SSE SHOULD respond with 405. Claude.ai will
// fall back to pure stateless POST mode with no SSE dependency.
app.get("/mcp", (c) => new Response(null, {
  status: 405,
  headers: {
    "Allow": "POST, OPTIONS",
    "Access-Control-Allow-Origin": "*",
  },
}));

// Also reject DELETE /mcp — session termination is not needed in stateless mode.
app.delete("/mcp", (c) => new Response(null, {
  status: 405,
  headers: { "Allow": "POST, OPTIONS" },
}));

app.all("/mcp", async (c) => {
  const env = c.env;
  const method = c.req.method;
  const auth = c.req.header("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();

  // Không có token → 401 kèm WWW-Authenticate để Claude.ai trigger OAuth discovery
  if (!token) {
    console.log(`[route] ${method} /mcp — no token → 401`);
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
    console.warn(`[route] ${method} /mcp — invalid/expired JWT → 401`);
    return new Response(
      JSON.stringify({
        error: "invalid_token",
        error_description: "Token is invalid or expired. Please re-authorize.",
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": [
            `Bearer realm="${env.PUBLIC_BASE_URL}"`,
            `error="invalid_token"`,
            `resource_metadata_url="${env.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`,
          ].join(", "),
        },
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
        "POST /mcp",
      ],
    },
    404
  )
);

export default app;
