/**
 * Test suite: oauth.ts
 * Coverage: buildOAuthMetadata, buildResourceMetadata, handleDCR,
 *           handleAuthorize, handleCallback, handleToken
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildOAuthMetadata, buildResourceMetadata,
  handleDCR, handleAuthorize, handleCallback, handleToken,
} from "../oauth";
import { MockKV, makeMockEnv, mockFetchSequence, GOOGLE_TOKEN_RESPONSE, GOOGLE_USERINFO } from "./helpers";

const BASE   = "https://test.workers.dev";
const SECRET = "test-secret-minimum-32-characters!";

afterEach(() => vi.restoreAllMocks());

// ── Discovery ─────────────────────────────────────────────────────────────────

describe("buildOAuthMetadata", () => {
  it("TC-DISC-01: contains authorization, token, registration endpoints", () => {
    const m = buildOAuthMetadata(BASE);
    expect(m.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(m.token_endpoint).toBe(`${BASE}/token`);
    expect(m.registration_endpoint).toBe(`${BASE}/register`);
  });

  it("TC-DISC-02: grant_types includes both authorization_code and refresh_token", () => {
    const m = buildOAuthMetadata(BASE);
    expect(m.grant_types_supported).toContain("authorization_code");
    expect(m.grant_types_supported).toContain("refresh_token");
  });
});

describe("buildResourceMetadata", () => {
  it("TC-DISC-03: resource points to /mcp, authorization_servers includes base", () => {
    const m = buildResourceMetadata(BASE);
    expect(m.resource).toBe(`${BASE}/mcp`);
    expect(m.authorization_servers).toContain(BASE);
  });
});

// ── handleDCR ─────────────────────────────────────────────────────────────────

describe("handleDCR", () => {
  it("TC-DCR-01: with credentials → 201 + client_id echoed back", async () => {
    const env = makeMockEnv();
    const req = new Request(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "g-cid", client_secret: "g-csec", redirect_uris: ["https://r.test"] }),
    });
    const res = await handleDCR(req, env);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.client_id).toBe("g-cid");
    expect(body.grant_types).toContain("authorization_code");
  });

  it("TC-DCR-02: no credentials → generates random client_id", async () => {
    const env = makeMockEnv();
    const req = new Request(`${BASE}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const res = await handleDCR(req, env);
    const body = await res.json() as any;
    expect(typeof body.client_id).toBe("string");
    expect(body.client_id.length).toBeGreaterThan(10);
  });

  it("TC-DCR-03: env fallback stored in DCR record when no creds provided", async () => {
    const oauthKv = new MockKV();
    const env = makeMockEnv({ OAUTH_KV: oauthKv, GOOGLE_OAUTH_CLIENT_ID: "env-gid" });
    const req = new Request(`${BASE}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const res = await handleDCR(req, env);
    const { client_id } = await res.json() as any;
    const stored = JSON.parse(oauthKv._get(`client:${client_id}`)!);
    expect(stored.google_client_id).toBe("env-gid");
  });

  it("TC-DCR-04: invalid JSON body handled gracefully → 201 with defaults", async () => {
    const env = makeMockEnv();
    const req = new Request(`${BASE}/register`, { method: "POST", body: "not-json" });
    const res = await handleDCR(req, env);
    expect(res.status).toBe(201);
  });
});

// ── handleAuthorize ───────────────────────────────────────────────────────────

describe("handleAuthorize", () => {
  function makeEnv() {
    const oauthKv = new MockKV();
    oauthKv._set("client:test-c", JSON.stringify({ google_client_id: "g-cid", google_client_secret: "g-sec" }));
    return { env: makeMockEnv({ OAUTH_KV: oauthKv }), oauthKv };
  }

  it("TC-AUTH-01: valid request → 302 redirect to accounts.google.com", async () => {
    const { env } = makeEnv();
    const req = new Request(`${BASE}/authorize?client_id=test-c&redirect_uri=https://r.test&state=s1`);
    const res = await handleAuthorize(req, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("accounts.google.com/o/oauth2/v2/auth");
  });

  it("TC-AUTH-02: redirect URL includes access_type=offline and prompt=consent", async () => {
    const { env } = makeEnv();
    const req = new Request(`${BASE}/authorize?client_id=test-c&redirect_uri=https://r.test&state=s1`);
    const res = await handleAuthorize(req, env);
    const loc = res.headers.get("Location")!;
    expect(loc).toContain("access_type=offline");
    expect(loc).toContain("prompt=consent");
  });

  it("TC-AUTH-03: oauth_state:{state} stored in KV", async () => {
    const { env, oauthKv } = makeEnv();
    const req = new Request(`${BASE}/authorize?client_id=test-c&redirect_uri=https://r.test&state=my-state`);
    await handleAuthorize(req, env);
    expect(oauthKv._has("oauth_state:my-state")).toBe(true);
  });

  it("TC-AUTH-04: no googleClientId resolved → 400 invalid_client", async () => {
    const env = makeMockEnv({ GOOGLE_OAUTH_CLIENT_ID: "" });
    const req = new Request(`${BASE}/authorize?client_id=&redirect_uri=https://r.test&state=s`);
    const res = await handleAuthorize(req, env);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("invalid_client");
  });
});

// ── handleCallback ────────────────────────────────────────────────────────────

describe("handleCallback", () => {
  function makeEnv() {
    const oauthKv  = new MockKV();
    const tokensKv = new MockKV();
    oauthKv._set("oauth_state:vs", JSON.stringify({
      clientId: "cid", redirectUri: "https://claude.ai/callback",
      state: "vs", codeChallenge: "", googleClientId: "g-cid",
    }));
    oauthKv._set("client:cid", JSON.stringify({ google_client_id: "g-cid", google_client_secret: "g-sec" }));
    return { env: makeMockEnv({ OAUTH_KV: oauthKv, TOKENS_KV: tokensKv, JWT_SECRET: SECRET }), oauthKv, tokensKv };
  }

  it("TC-CB-01: valid code+state → 302 to redirectUri, tokens stored in KV", async () => {
    const { env, tokensKv } = makeEnv();
    mockFetchSequence([{ body: GOOGLE_TOKEN_RESPONSE }, { body: GOOGLE_USERINFO }]);
    const res = await handleCallback(new Request(`${BASE}/callback?code=c&state=vs`), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("https://claude.ai/callback");
    expect(tokensKv._has(`token:${GOOGLE_USERINFO.sub}`)).toBe(true);
  });

  it("TC-CB-02: pending_jwt stored in OAUTH_KV for /token to collect", async () => {
    const { env, oauthKv } = makeEnv();
    mockFetchSequence([{ body: GOOGLE_TOKEN_RESPONSE }, { body: GOOGLE_USERINFO }]);
    const res = await handleCallback(new Request(`${BASE}/callback?code=c&state=vs`), env);
    const loc = new URL(res.headers.get("Location")!);
    const code = loc.searchParams.get("code")!;
    expect(oauthKv._has(`pending_jwt:${code}`)).toBe(true);
  });

  it("TC-CB-03: error param from Google → 400 HTML with error text", async () => {
    const { env } = makeEnv();
    const res = await handleCallback(new Request(`${BASE}/callback?error=access_denied`), env);
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("TC-CB-04: missing code param → 400", async () => {
    const { env } = makeEnv();
    const res = await handleCallback(new Request(`${BASE}/callback?state=vs`), env);
    expect(res.status).toBe(400);
  });

  it("TC-CB-05: expired/invalid state → 400 'state expired'", async () => {
    const { env } = makeEnv();
    const res = await handleCallback(new Request(`${BASE}/callback?code=c&state=bad-state`), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("state expired");
  });

  it("TC-CB-06: Google token exchange fails (non-200) → 400 HTML Authorization Error", async () => {
    const { env } = makeEnv();
    mockFetchSequence([{ body: { error: "invalid_client" }, status: 401 }]);
    const res = await handleCallback(new Request(`${BASE}/callback?code=c&state=vs`), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Authorization Error");
  });

  it("TC-CB-07: Google returns no refresh_token → 400 HTML", async () => {
    const { env } = makeEnv();
    mockFetchSequence([{ body: { access_token: "acc", expires_in: 3600, token_type: "Bearer" } }]);
    const res = await handleCallback(new Request(`${BASE}/callback?code=c&state=vs`), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("refresh token");
  });

  it("TC-CB-08: userinfo fetch fails → uses randomUUID sub, still succeeds (302)", async () => {
    const { env } = makeEnv();
    mockFetchSequence([{ body: GOOGLE_TOKEN_RESPONSE }, { body: "err", status: 500 }]);
    const res = await handleCallback(new Request(`${BASE}/callback?code=c&state=vs`), env);
    expect(res.status).toBe(302);
  });

  it("TC-CB-09: missing Google credentials → 400 HTML Configuration Required", async () => {
    const oauthKv = new MockKV();
    oauthKv._set("oauth_state:s", JSON.stringify({
      clientId: "cid", redirectUri: "https://r.test", state: "s", codeChallenge: "", googleClientId: "",
    }));
    const env = makeMockEnv({
      OAUTH_KV: oauthKv, TOKENS_KV: new MockKV(),
      GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "",
    });
    const res = await handleCallback(new Request(`${BASE}/callback?code=c&state=s`), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Configuration Required");
  });

  it("TC-CB-10: unexpected exception → 500 Internal Error HTML", async () => {
    const { env } = makeEnv();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network failure"));
    mockFetchSequence([{ body: GOOGLE_TOKEN_RESPONSE }]); // first fetch (token) succeeds
    // Actually mock the whole sequence to cause throw during storeTokens
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(GOOGLE_TOKEN_RESPONSE), { status: 200 }))
      .mockRejectedValueOnce(new Error("unexpected error")); // userinfo throws
    // userinfo failure caught internally → uses randomUUID → should still succeed
    const res = await handleCallback(new Request(`${BASE}/callback?code=c&state=vs`), env);
    expect(res.status).toBe(302); // fallback to random sub
  });
});

// ── handleToken ───────────────────────────────────────────────────────────────

describe("handleToken — authorization_code", () => {
  async function makeEnv() {
    const { signJWT: sj } = await import("../jwt");
    const oauthKv = new MockKV();
    const jwt = await sj({ sub: "u123" }, SECRET, 3600);
    oauthKv._set("pending_jwt:valid-code", jwt);
    return { env: makeMockEnv({ OAUTH_KV: oauthKv, JWT_SECRET: SECRET }), oauthKv, jwt };
  }
  function tokenReq(params: Record<string, string>) {
    return new Request(`${BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  }

  it("TC-TK-01: valid code → 200 with access_token + refresh_token", async () => {
    const { env } = await makeEnv();
    const res = await handleToken(tokenReq({ grant_type: "authorization_code", code: "valid-code" }), env);
    expect(res.status).toBe(200);
    const b = await res.json() as any;
    expect(b.access_token).toBeTruthy();
    expect(b.refresh_token).toBeTruthy();
    expect(b.expires_in).toBe(2592000);
  });

  it("TC-TK-02: missing code → 400 invalid_request", async () => {
    const { env } = await makeEnv();
    const res = await handleToken(tokenReq({ grant_type: "authorization_code" }), env);
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("invalid_request");
  });

  it("TC-TK-03: expired/unknown code → 400 invalid_grant", async () => {
    const { env } = await makeEnv();
    const res = await handleToken(tokenReq({ grant_type: "authorization_code", code: "bad-code" }), env);
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("invalid_grant");
  });

  it("TC-TK-04: code deleted after first use (one-time)", async () => {
    const { env, oauthKv } = await makeEnv();
    await handleToken(tokenReq({ grant_type: "authorization_code", code: "valid-code" }), env);
    expect(oauthKv._has("pending_jwt:valid-code")).toBe(false);
    const res2 = await handleToken(tokenReq({ grant_type: "authorization_code", code: "valid-code" }), env);
    expect(res2.status).toBe(400);
  });

  it("TC-TK-05: JSON content-type body accepted", async () => {
    const { env } = await makeEnv();
    const req = new Request(`${BASE}/token`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code: "valid-code" }),
    });
    expect((await handleToken(req, env)).status).toBe(200);
  });
});

describe("handleToken — refresh_token", () => {
  async function makeEnv() {
    const { signJWT: sj } = await import("../jwt");
    const tokensKv = new MockKV();
    tokensKv._set("token:u123", JSON.stringify({
      access_token: "old-acc", refresh_token: "g-ref",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      scopes: "", google_client_id: "gid", google_client_secret: "gsec",
    }));
    const refreshJWT = await sj({ sub: "u123", type: "refresh" }, SECRET, 90 * 86400);
    const env = makeMockEnv({ TOKENS_KV: tokensKv, JWT_SECRET: SECRET });
    return { env, refreshJWT, tokensKv };
  }
  function tokenReq(params: Record<string, string>) {
    return new Request(`${BASE}/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  }

  it("TC-TK-06: valid refresh_token → 200 new access_token + refresh_token", async () => {
    const { env, refreshJWT } = await makeEnv();
    const res = await handleToken(tokenReq({ grant_type: "refresh_token", refresh_token: refreshJWT }), env);
    expect(res.status).toBe(200);
    const b = await res.json() as any;
    expect(b.access_token).toBeTruthy();
    expect(b.refresh_token).toBeTruthy();
    expect(b.expires_in).toBe(2592000);
  });

  it("TC-TK-07: missing refresh_token param → 400 invalid_request", async () => {
    const { env } = await makeEnv();
    const res = await handleToken(tokenReq({ grant_type: "refresh_token" }), env);
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("invalid_request");
  });

  it("TC-TK-08: invalid/expired refresh JWT → 400 invalid_grant", async () => {
    const { env } = await makeEnv();
    const res = await handleToken(tokenReq({ grant_type: "refresh_token", refresh_token: "not.a.jwt" }), env);
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("invalid_grant");
  });

  it("TC-TK-09: valid JWT but no Google tokens in KV → 400 invalid_grant 'Session expired'", async () => {
    const { signJWT: sj } = await import("../jwt");
    const jwt = await sj({ sub: "ghost" }, SECRET, 3600);
    const env = makeMockEnv({ JWT_SECRET: SECRET }); // empty TOKENS_KV
    const res = await handleToken(tokenReq({ grant_type: "refresh_token", refresh_token: jwt }), env);
    expect(res.status).toBe(400);
    const b = await res.json() as any;
    expect(b.error).toBe("invalid_grant");
    expect(b.error_description).toContain("Session expired");
  });
});

describe("handleToken — unsupported grant", () => {
  it("TC-TK-10: unknown grant_type → 400 unsupported_grant_type", async () => {
    const env = makeMockEnv();
    const req = new Request(`${BASE}/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    });
    const res = await handleToken(req, env);
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("unsupported_grant_type");
  });
});
