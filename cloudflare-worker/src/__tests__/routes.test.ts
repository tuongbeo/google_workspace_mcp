/**
 * Test suite: index.ts + mcp-agent.ts
 * Coverage: HTTP routes, MCP authentication, connection expiry scenarios
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { MockKV, makeMockEnv, mockFetchSequence, GOOGLE_TOKEN_RESPONSE, GOOGLE_USERINFO } from "./helpers";
import { signJWT, storeTokens } from "../jwt";

const BASE   = "https://test.workers.dev";
const SECRET = "test-secret-minimum-32-characters!";

afterEach(() => vi.restoreAllMocks());

async function getApp() {
  vi.resetModules();
  return (await import("../index")).default;
}

function makeInitPayload(id = 1) {
  return {
    jsonrpc: "2.0", method: "initialize", id,
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  };
}

async function makeAuthenticatedEnv() {
  const tokensKv = new MockKV();
  const oauthKv  = new MockKV();
  const sub = "user-stable-123";
  await storeTokens(sub, "access-token", "refresh-token", 3600, "gid", "gsec", tokensKv as any);
  const jwt = await signJWT({ sub }, SECRET, 30 * 86400);
  const env = makeMockEnv({ TOKENS_KV: tokensKv, OAUTH_KV: oauthKv, JWT_SECRET: SECRET });
  return { env, jwt, sub, tokensKv, oauthKv };
}

// ── OAuth discovery ───────────────────────────────────────────────────────────

describe("GET /.well-known/oauth-authorization-server", () => {
  it("TC-RT-01: returns 200 with grant_types including refresh_token", async () => {
    const app = await getApp();
    const env = makeMockEnv({ JWT_SECRET: SECRET });
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`), env);
    expect(res.status).toBe(200);
    const b = await res.json() as any;
    expect(b.grant_types_supported).toContain("refresh_token");
    expect(b.authorization_endpoint).toContain("/authorize");
  });
});

describe("GET /.well-known/oauth-protected-resource", () => {
  it("TC-RT-02: returns 200 with resource pointing to /mcp", async () => {
    const app = await getApp();
    const res = await app.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource`), makeMockEnv());
    expect(res.status).toBe(200);
    expect((await res.json() as any).resource).toBe(`${BASE}/mcp`);
  });
});

// ── MCP authentication ────────────────────────────────────────────────────────

describe("POST /mcp — authentication", () => {
  it("TC-RT-03: no token → 401 with WWW-Authenticate header", async () => {
    const app = await getApp();
    const req = new Request(`${BASE}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
    });
    const res = await app.fetch(req, makeMockEnv({ JWT_SECRET: SECRET }));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
    expect((await res.json() as any).error).toBe("unauthorized");
  });

  it("TC-RT-04: expired JWT → 401 invalid_token + WWW-Authenticate", async () => {
    const app = await getApp();
    const expiredJWT = await signJWT({ sub: "u" }, SECRET, -1);
    const req = new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${expiredJWT}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const res = await app.fetch(req, makeMockEnv({ JWT_SECRET: SECRET }));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
  });

  it("TC-RT-05: wrong secret JWT → 401", async () => {
    const app = await getApp();
    const jwt = await signJWT({ sub: "u" }, "wrong-secret-32-characters-long!!", 3600);
    const req = new Request(`${BASE}/mcp`, {
      method: "POST", headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }, body: "{}",
    });
    expect((await app.fetch(req, makeMockEnv({ JWT_SECRET: SECRET }))).status).toBe(401);
  });
});

describe("OPTIONS /mcp", () => {
  it("TC-RT-06: returns 204 with CORS headers (no auth required)", async () => {
    const app = await getApp();
    const res = await app.fetch(new Request(`${BASE}/mcp`, { method: "OPTIONS" }), makeMockEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });
});

describe("GET /mcp + DELETE /mcp", () => {
  it("TC-RT-07: GET /mcp → 405", async () => {
    const app = await getApp();
    expect((await app.fetch(new Request(`${BASE}/mcp`), makeMockEnv())).status).toBe(405);
  });

  it("TC-RT-08: DELETE /mcp → 405", async () => {
    const app = await getApp();
    expect((await app.fetch(new Request(`${BASE}/mcp`, { method: "DELETE" }), makeMockEnv())).status).toBe(405);
  });
});

// ── MCP connection expiry scenarios ──────────────────────────────────────────

describe("MCP connection — expiry scenarios", () => {
  async function mcpPost(app: any, jwt: string, body: object, env: any) {
    return app.fetch(new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    }), env);
  }

  it("TC-EXP-01: valid JWT + valid Google tokens → initialize returns 200 with serverInfo", async () => {
    const app = await getApp();
    const { env, jwt } = await makeAuthenticatedEnv();
    const res = await mcpPost(app, jwt, makeInitPayload(), env);
    expect(res.status).toBe(200);
    const b = await res.json() as any;
    expect(b.result?.serverInfo?.name).toBe("mcp-google-workspace");
  });

  it("TC-EXP-02: tools/list returns non-empty tool array", async () => {
    const app = await getApp();
    const { env, jwt } = await makeAuthenticatedEnv();
    const res = await mcpPost(app, jwt, { jsonrpc: "2.0", method: "tools/list", id: 2, params: {} }, env);
    expect(res.status).toBe(200);
    const b = await res.json() as any;
    expect(Array.isArray(b.result?.tools)).toBe(true);
    expect(b.result.tools.length).toBeGreaterThan(100); // 193 tools registered
  });

  it("TC-EXP-03: KEY — expired proxy JWT → 401 (triggers connection expired in Claude.ai)", async () => {
    const app = await getApp();
    const { env } = await makeAuthenticatedEnv();
    const expiredJWT = await signJWT({ sub: "user-stable-123" }, SECRET, -1);
    const res = await mcpPost(app, expiredJWT, makeInitPayload(), env);
    // This is what causes 'Connection has expired' — server returns 401
    expect(res.status).toBe(401);
    // WWW-Authenticate MUST be present on all 401s (RFC 6750)
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("TC-EXP-04: KEY — valid JWT but no Google tokens in KV → 401 (connection expired)", async () => {
    const app = await getApp();
    const sub = "ghost-user";
    const jwt = await signJWT({ sub }, SECRET, 30 * 86400);
    const env = makeMockEnv({ TOKENS_KV: new MockKV(), JWT_SECRET: SECRET }); // empty KV
    const res = await mcpPost(app, jwt, makeInitPayload(), env);
    // getValidAccessToken throws → 401
    expect(res.status).toBe(401);
  });

  it("TC-EXP-05: KEY — Google token auto-refresh keeps connection alive", async () => {
    const app = await getApp();
    const tokensKv = new MockKV();
    const sub = "refresh-user";
    // Token about to expire in < REFRESH_THRESHOLD (10 min)
    tokensKv._set(`token:${sub}`, JSON.stringify({
      access_token: "expiring-token", refresh_token: "g-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      scopes: "", google_client_id: "gid", google_client_secret: "gsec",
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "refreshed-token", expires_in: 3600 }), { status: 200 })
    );
    const jwt = await signJWT({ sub }, SECRET, 30 * 86400);
    const env = makeMockEnv({ TOKENS_KV: tokensKv, JWT_SECRET: SECRET });
    const res = await mcpPost(app, jwt, makeInitPayload(), env);
    // Connection stays alive after refresh
    expect(res.status).toBe(200);
    // KV updated with new token
    expect(JSON.parse(tokensKv._get(`token:${sub}`)!).access_token).toBe("refreshed-token");
  });

  it("TC-EXP-06: KEY — refresh_token grant extends connection before JWT expires", async () => {
    const app = await getApp();
    const tokensKv = new MockKV();
    const oauthKv  = new MockKV();
    const sub = "long-session-user";
    await storeTokens(sub, "access", "g-refresh", 3600, "gid", "gsec", tokensKv as any);
    const refreshJWT = await signJWT({ sub, type: "refresh" }, SECRET, 90 * 86400);
    const env = makeMockEnv({ TOKENS_KV: tokensKv, OAUTH_KV: oauthKv, JWT_SECRET: SECRET });

    // Claude.ai calls POST /token with refresh_token
    const tokenRes = await app.fetch(new Request(`${BASE}/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshJWT }),
    }), env);
    expect(tokenRes.status).toBe(200);
    const { access_token: newJWT } = await tokenRes.json() as any;

    // New JWT works for MCP
    const mcpRes = await mcpPost(app, newJWT, makeInitPayload(10), env);
    expect(mcpRes.status).toBe(200);
  });

  it("TC-EXP-07: KEY — double initialize (Claude.ai normal pattern) both succeed", async () => {
    const app = await getApp();
    const { env, jwt } = await makeAuthenticatedEnv();
    // First init
    const r1 = await mcpPost(app, jwt, makeInitPayload(1), env);
    expect(r1.status).toBe(200);
    // Second init (Claude.ai always does this)
    const r2 = await mcpPost(app, jwt, makeInitPayload(2), env);
    expect(r2.status).toBe(200); // fresh server per request = no "Already connected" error
  });

  it("TC-EXP-08: notifications/initialized returns 202", async () => {
    const app = await getApp();
    const { env, jwt } = await makeAuthenticatedEnv();
    const res = await mcpPost(app, jwt, { jsonrpc: "2.0", method: "notifications/initialized" }, env);
    expect(res.status).toBe(202);
  });
});

// ── Full end-to-end auth flow ─────────────────────────────────────────────────

describe("Full auth flow integration", () => {
  it("TC-FULL-01: register → authorize → callback → token → MCP initialize", async () => {
    const app = await getApp();
    const oauthKv  = new MockKV();
    const tokensKv = new MockKV();
    const env = makeMockEnv({ OAUTH_KV: oauthKv, TOKENS_KV: tokensKv, JWT_SECRET: SECRET });

    // Step 1: Register
    const regRes = await app.fetch(new Request(`${BASE}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "g-cid", client_secret: "g-sec", redirect_uris: ["https://claude.ai/cb"] }),
    }), env);
    expect(regRes.status).toBe(201);
    const { client_id } = await regRes.json() as any;

    // Step 2: Authorize → get Google redirect
    const authRes = await app.fetch(new Request(
      `${BASE}/authorize?client_id=${client_id}&redirect_uri=https://claude.ai/cb&state=st1`
    ), env);
    expect(authRes.status).toBe(302);
    expect(authRes.headers.get("Location")).toContain("accounts.google.com");

    // Step 3: Callback — simulate Google returning code
    mockFetchSequence([{ body: GOOGLE_TOKEN_RESPONSE }, { body: GOOGLE_USERINFO }]);
    const cbRes = await app.fetch(new Request(`${BASE}/callback?code=auth-code&state=st1`), env);
    expect(cbRes.status).toBe(302);
    const tempCode = new URL(cbRes.headers.get("Location")!).searchParams.get("code")!;

    // Step 4: Token exchange
    const tokRes = await app.fetch(new Request(`${BASE}/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: tempCode }),
    }), env);
    expect(tokRes.status).toBe(200);
    const { access_token, refresh_token } = await tokRes.json() as any;
    expect(access_token).toBeTruthy();
    expect(refresh_token).toBeTruthy();

    // Step 5: Use access_token for MCP initialize
    vi.restoreAllMocks();
    const mcpRes = await app.fetch(new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(makeInitPayload(1)),
    }), env);
    expect(mcpRes.status).toBe(200);
    const b = await mcpRes.json() as any;
    expect(b.result?.serverInfo?.name).toBe("mcp-google-workspace");

    // Bonus: tools are available
    const toolsRes = await app.fetch(new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2, params: {} }),
    }), env);
    expect(toolsRes.status).toBe(200);
    const tools = (await toolsRes.json() as any).result?.tools;
    expect(tools.length).toBeGreaterThan(100);
  });
});
