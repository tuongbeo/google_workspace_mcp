import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `vi.mock` factories are hoisted above static imports, so anything they
// reference must be initialized via `vi.hoisted` (hoisted together with them)
// rather than a plain top-level `const`.
const { oauthProviderFetch, OAuthProviderCtor } = vi.hoisted(() => {
  const oauthProviderFetch = vi.fn(async (_req: Request) => new Response("oauth-provider-response"));
  return {
    oauthProviderFetch,
    OAuthProviderCtor: vi.fn().mockImplementation(() => ({ fetch: oauthProviderFetch })),
  };
});

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  default: OAuthProviderCtor,
}));

import { createWorker, withTenantRouting } from "../workers/shared";

function createMockKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: unknown) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
  };
}

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    PUBLIC_BASE_URL: "https://office.lens.io.vn",
    GOOGLE_AUTH_BASE_URL: "https://auth.lens.io.vn",
    OAUTH_KV: createMockKV(),
    TOKEN_NAMESPACE: "office",
    ...overrides,
  } as any;
}

const dummyAgent = { serve: vi.fn(() => ({ fetch: vi.fn() })) } as any;
const baseConfig = { service: "mcp-office", agent: dummyAgent, serverName: "office", namespace: "office" };
const ctx = {} as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createWorker — /health", () => {
  it("reports ok and echoes the configured namespace when env matches", async () => {
    const worker = createWorker(baseConfig);
    const res = await worker.fetch(
      new Request("https://office.lens.io.vn/health"), createEnv({ TOKEN_NAMESPACE: "office" }), ctx,
    );

    const body = await res.json() as any;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("mcp-office");
    expect(body.namespace).toEqual({ configured: "office", env: "office" });
  });

  it("flags a namespace_mismatch when env.TOKEN_NAMESPACE differs from the configured namespace", async () => {
    const worker = createWorker(baseConfig);
    const res = await worker.fetch(
      new Request("https://office.lens.io.vn/health"), createEnv({ TOKEN_NAMESPACE: "workspace" }), ctx,
    );

    const body = await res.json() as any;
    expect(body.status).toBe("namespace_mismatch");
    expect(body.namespace).toEqual({ configured: "office", env: "workspace" });
  });

  it("reports ok when env.TOKEN_NAMESPACE is unset (nothing to mismatch)", async () => {
    const worker = createWorker(baseConfig);
    const res = await worker.fetch(
      new Request("https://office.lens.io.vn/health"), createEnv({ TOKEN_NAMESPACE: undefined }), ctx,
    );

    const body = await res.json() as any;
    expect(body.status).toBe("ok");
    expect(body.namespace).toEqual({ configured: "office", env: null });
  });
});

describe("createWorker — discovery endpoints", () => {
  it("serves /.well-known/oauth-protected-resource using PUBLIC_BASE_URL with CORS + cache headers", async () => {
    const worker = createWorker(baseConfig);
    const res = await worker.fetch(
      new Request("https://office.lens.io.vn/.well-known/oauth-protected-resource"), createEnv(), ctx,
    );

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = await res.json() as any;
    expect(body.resource).toBe("https://office.lens.io.vn/mcp");
    expect(body.authorization_servers).toEqual(["https://office.lens.io.vn"]);
  });

  it("serves per-tenant /.well-known/oauth-authorization-server/:tenant metadata", async () => {
    const worker = createWorker(baseConfig);
    const res = await worker.fetch(
      new Request("https://office.lens.io.vn/.well-known/oauth-authorization-server/acme"), createEnv(), ctx,
    );

    const body = await res.json() as any;
    expect(body.issuer).toBe("https://office.lens.io.vn/acme");
    expect(body.authorization_endpoint).toBe("https://office.lens.io.vn/acme/authorize");
    expect(body.token_endpoint).toBe("https://office.lens.io.vn/acme/token");
  });
});

describe("createWorker — dispatch to OAuthProvider", () => {
  it("delegates non-manual paths (e.g. /mcp, /authorize) to OAuthProvider.fetch", async () => {
    const worker = createWorker(baseConfig);
    const req = new Request("https://office.lens.io.vn/mcp");

    const res = await worker.fetch(req, createEnv(), ctx);

    expect(oauthProviderFetch).toHaveBeenCalledWith(req, expect.anything(), ctx);
    expect(await res.text()).toBe("oauth-provider-response");
  });
});

describe("withTenantRouting — reserved paths fall through to base", () => {
  it("does not treat reserved first segments (health, mcp, authorize, ...) as tenant slugs", async () => {
    const baseFetch = vi.fn(async (_req: Request) => new Response("base-response"));
    const base = { fetch: baseFetch };
    const worker = withTenantRouting(base as any, baseConfig);

    await worker.fetch(new Request("https://office.lens.io.vn/mcp"), createEnv(), ctx);

    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("does not treat an invalid slug (uppercase/special chars) as a tenant", async () => {
    const baseFetch = vi.fn(async (_req: Request) => new Response("base-response"));
    const base = { fetch: baseFetch };
    const worker = withTenantRouting(base as any, baseConfig);

    await worker.fetch(new Request("https://office.lens.io.vn/ACME/mcp"), createEnv(), ctx);

    expect(baseFetch).toHaveBeenCalledTimes(1);
  });
});

describe("withTenantRouting — /:tenant/authorize", () => {
  it("returns 400 when client_id is missing", async () => {
    const base = { fetch: vi.fn() };
    const worker = withTenantRouting(base as any, baseConfig);

    const res = await worker.fetch(new Request("https://office.lens.io.vn/acme/authorize"), createEnv(), ctx);

    expect(res.status).toBe(400);
  });

  it("auto-registers a new client and stores both the shared state and a tenant-scoped anti-replay sentinel", async () => {
    const kv = createMockKV();
    const base = { fetch: vi.fn() };
    const worker = withTenantRouting(base as any, baseConfig);

    const res = await worker.fetch(
      new Request("https://office.lens.io.vn/acme/authorize?client_id=c1&redirect_uri=https://claude.ai/cb"),
      createEnv({ OAUTH_KV: kv }), ctx,
    );

    expect(kv.put).toHaveBeenCalledWith("client:c1", expect.stringContaining('"redirectUris":["https://claude.ai/cb"]'));

    const stateCall = kv.put.mock.calls.find((c: any[]) => String(c[0]).startsWith("delegate_mcp_state:"));
    expect(stateCall).toBeDefined();
    const stateId = stateCall![0].split(":")[1];

    expect(kv.put).toHaveBeenCalledWith(`delegate_mcp_state_tenant:acme:${stateId}`, "1", { expirationTtl: 600 });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.searchParams.get("server")).toBe("acme");
    expect(location.searchParams.get("callback_url")).toBe("https://office.lens.io.vn/acme/callback-delegate");
    expect(location.searchParams.get("state")).toBe(stateId);
  });
});

describe("withTenantRouting — /:tenant/callback-delegate (anti-replay)", () => {
  it("shows an error page for a denied authorization", async () => {
    const base = { fetch: vi.fn() };
    const worker = withTenantRouting(base as any, baseConfig);

    const res = await worker.fetch(
      new Request("https://office.lens.io.vn/acme/callback-delegate?error=access_denied"), createEnv(), ctx,
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Authorization denied: access_denied/);
  });

  it("rejects when no anti-replay sentinel exists for this tenant/state pair", async () => {
    const base = { fetch: vi.fn() };
    const worker = withTenantRouting(base as any, baseConfig);

    const res = await worker.fetch(
      new Request("https://office.lens.io.vn/acme/callback-delegate?code=c1&state=unknown-state"), createEnv(), ctx,
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/OAuth state expired or tenant mismatch/);
    expect(base.fetch).not.toHaveBeenCalled();
  });

  it("rejects cross-tenant replay: a sentinel stored for tenant A is not valid for tenant B's callback", async () => {
    const kv = createMockKV({ "delegate_mcp_state_tenant:tenant-a:st-1": "1" });
    const base = { fetch: vi.fn() };
    const worker = withTenantRouting(base as any, baseConfig);

    const res = await worker.fetch(
      new Request("https://office.lens.io.vn/tenant-b/callback-delegate?code=c1&state=st-1"),
      createEnv({ OAUTH_KV: kv }), ctx,
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/OAuth state expired or tenant mismatch/);
    expect(base.fetch).not.toHaveBeenCalled();
  });

  it("on a valid sentinel: deletes it (one-time use) and rewrites to /callback-delegate via base.fetch", async () => {
    const kv = createMockKV({ "delegate_mcp_state_tenant:acme:st-1": "1" });
    const baseFetch = vi.fn(async (_req: Request) => new Response("ok"));
    const base = { fetch: baseFetch };
    const worker = withTenantRouting(base as any, baseConfig);

    await worker.fetch(
      new Request("https://office.lens.io.vn/acme/callback-delegate?code=my-code&state=st-1"),
      createEnv({ OAUTH_KV: kv }), ctx,
    );

    expect(kv.delete).toHaveBeenCalledWith("delegate_mcp_state_tenant:acme:st-1");
    expect(baseFetch).toHaveBeenCalledTimes(1);
    const rewrittenReq = baseFetch.mock.calls[0][0] as Request;
    const rewrittenUrl = new URL(rewrittenReq.url);
    expect(rewrittenUrl.pathname).toBe("/callback-delegate");
    expect(rewrittenUrl.searchParams.get("code")).toBe("my-code");
    expect(rewrittenUrl.searchParams.get("state")).toBe("st-1");
  });
});

describe("withTenantRouting — /:tenant/mcp proxying and WWW-Authenticate patching", () => {
  it("rewrites /:tenant/mcp to /mcp and forwards to base.fetch", async () => {
    const baseFetch = vi.fn(async (_req: Request) => new Response("mcp-ok", { status: 200 }));
    const base = { fetch: baseFetch };
    const worker = withTenantRouting(base as any, baseConfig);

    await worker.fetch(new Request("https://office.lens.io.vn/acme/mcp"), createEnv(), ctx);

    const rewrittenReq = baseFetch.mock.calls[0][0] as Request;
    expect(new URL(rewrittenReq.url).pathname).toBe("/mcp");
  });

  it("patches resource_metadata in WWW-Authenticate to the tenant-specific discovery URL on a 401", async () => {
    const baseFetch = vi.fn(async (_req: Request) => new Response("unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://office.lens.io.vn/.well-known/oauth-protected-resource"' },
    }));
    const base = { fetch: baseFetch };
    const worker = withTenantRouting(base as any, baseConfig);

    const res = await worker.fetch(new Request("https://office.lens.io.vn/acme/mcp"), createEnv(), ctx);

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://office.lens.io.vn/acme/.well-known/oauth-protected-resource"',
    );
  });

  it("passes through a 401 with no WWW-Authenticate header unchanged", async () => {
    const baseFetch = vi.fn(async (_req: Request) => new Response("unauthorized", { status: 401 }));
    const base = { fetch: baseFetch };
    const worker = withTenantRouting(base as any, baseConfig);

    const res = await worker.fetch(new Request("https://office.lens.io.vn/acme/mcp"), createEnv(), ctx);

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("passes through non-401 responses unchanged", async () => {
    const baseFetch = vi.fn(async (_req: Request) => new Response("ok", { status: 200 }));
    const base = { fetch: baseFetch };
    const worker = withTenantRouting(base as any, baseConfig);

    const res = await worker.fetch(new Request("https://office.lens.io.vn/acme/mcp"), createEnv(), ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("withTenantRouting — token/register proxying", () => {
  it("rewrites POST /:tenant/token to /token and forwards to base.fetch", async () => {
    const baseFetch = vi.fn(async (_req: Request) => new Response("token-ok"));
    const base = { fetch: baseFetch };
    const worker = withTenantRouting(base as any, baseConfig);

    await worker.fetch(new Request("https://office.lens.io.vn/acme/token", { method: "POST" }), createEnv(), ctx);

    const rewrittenReq = baseFetch.mock.calls[0][0] as Request;
    expect(new URL(rewrittenReq.url).pathname).toBe("/token");
  });

  it("rewrites POST /:tenant/register to /register and forwards to base.fetch", async () => {
    const baseFetch = vi.fn(async (_req: Request) => new Response("register-ok"));
    const base = { fetch: baseFetch };
    const worker = withTenantRouting(base as any, baseConfig);

    await worker.fetch(new Request("https://office.lens.io.vn/acme/register", { method: "POST" }), createEnv(), ctx);

    const rewrittenReq = baseFetch.mock.calls[0][0] as Request;
    expect(new URL(rewrittenReq.url).pathname).toBe("/register");
  });
});
