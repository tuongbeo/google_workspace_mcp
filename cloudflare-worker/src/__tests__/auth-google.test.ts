import { describe, it, expect, vi, afterEach } from "vitest";
import { createDelegatingHandler } from "../auth/google";

function createMockKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: unknown) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
  };
}

function createEnv(opts: {
  oauthKv?: ReturnType<typeof createMockKV>;
  parseAuthRequest?: (req: Request) => Promise<{ clientId?: string; scope?: string }>;
  completeAuthorization?: (opts: unknown) => Promise<{ redirectTo: string }>;
} = {}) {
  const oauthKv = opts.oauthKv ?? createMockKV();
  return {
    OAUTH_KV: oauthKv as any,
    OAUTH_PROVIDER: {
      parseAuthRequest: opts.parseAuthRequest ?? (async () => ({ clientId: "client-1", scope: "openid email" })),
      completeAuthorization: opts.completeAuthorization ?? (async () => ({ redirectTo: "https://claude.ai/callback?code=xyz" })),
    } as any,
    GOOGLE_AUTH_BASE_URL: "https://auth.lens.io.vn",
    GOOGLE_AUTH_SERVICE_TOKEN: "service-token",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createDelegatingHandler — GET /authorize", () => {
  it("auto-registers a new OAuth client and redirects to google-auth", async () => {
    const kv = createMockKV();
    const env = createEnv({ oauthKv: kv });
    const app = createDelegatingHandler("office");

    const res = await app.request(
      "/authorize?client_id=client-1&redirect_uri=https://claude.ai/cb",
      {}, env,
    );

    expect(kv.put).toHaveBeenCalledWith(
      "client:client-1",
      expect.stringContaining('"redirectUris":["https://claude.ai/cb"]'),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe("https://auth.lens.io.vn/delegate/authorize");
    expect(location.searchParams.get("server")).toBe("office");
    expect(location.searchParams.get("callback_url")).toMatch(/\/callback-delegate$/);
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("does not re-register a client that's already known", async () => {
    const kv = createMockKV({ "client:client-1": JSON.stringify({ clientId: "client-1" }) });
    const env = createEnv({ oauthKv: kv });
    const app = createDelegatingHandler("office");

    await app.request("/authorize?client_id=client-1&redirect_uri=https://claude.ai/cb", {}, env);

    expect(kv.put).not.toHaveBeenCalledWith("client:client-1", expect.anything());
  });

  it("skips client auto-registration entirely when client_id or redirect_uri is missing", async () => {
    const kv = createMockKV();
    const env = createEnv({ oauthKv: kv });
    const app = createDelegatingHandler("office");

    await app.request("/authorize", {}, env);

    const clientPuts = kv.put.mock.calls.filter((c: any[]) => String(c[0]).startsWith("client:"));
    expect(clientPuts).toHaveLength(0);
  });

  it("returns 400 when the OAuth request has no client_id after parsing", async () => {
    const env = createEnv({ parseAuthRequest: async () => ({}) });
    const app = createDelegatingHandler("office");

    const res = await app.request("/authorize", {}, env);

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/missing client_id/);
  });

  it("saves the parsed OAuth request under a fresh state id with a 600s TTL", async () => {
    const kv = createMockKV();
    const env = createEnv({
      oauthKv: kv,
      parseAuthRequest: async () => ({ clientId: "client-1", scope: "openid email" }),
    });
    const app = createDelegatingHandler("office");

    const res = await app.request("/authorize", {}, env);

    const stateCall = kv.put.mock.calls.find((c: any[]) => String(c[0]).startsWith("delegate_mcp_state:"));
    expect(stateCall).toBeDefined();
    expect(stateCall![2]).toEqual({ expirationTtl: 600 });
    expect(JSON.parse(stateCall![1] as string)).toEqual({ clientId: "client-1", scope: "openid email" });

    const location = new URL(res.headers.get("Location")!);
    const stateIdInKey = stateCall![0].split(":")[1];
    expect(location.searchParams.get("state")).toBe(stateIdInKey);
  });
});

describe("createDelegatingHandler — GET /callback-delegate", () => {
  it("shows an error page when google-auth reports an authorization error", async () => {
    const app = createDelegatingHandler("office");
    const res = await app.request("/callback-delegate?error=access_denied", {}, createEnv());

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Authorization denied: access_denied/);
  });

  it("shows an error page when code or state is missing", async () => {
    const app = createDelegatingHandler("office");
    const res = await app.request("/callback-delegate?code=abc", {}, createEnv());

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Missing code or state/);
  });

  it("shows an error page when the saved state has expired", async () => {
    const app = createDelegatingHandler("office");
    const res = await app.request("/callback-delegate?code=abc&state=unknown-state", {}, createEnv());

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/OAuth state expired/);
  });

  it("deletes the saved state after reading it (one-time use)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, json: async () => ({ sub: "user-1", email: "user@example.com" }),
    } as unknown as Response)));
    const kv = createMockKV({ "delegate_mcp_state:st-1": JSON.stringify({ clientId: "c1", scope: "openid" }) });
    const app = createDelegatingHandler("office");

    await app.request("/callback-delegate?code=abc&state=st-1", {}, createEnv({ oauthKv: kv }));

    expect(kv.delete).toHaveBeenCalledWith("delegate_mcp_state:st-1");
  });

  it("shows an error page when google-auth's verify call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 401, text: async () => "invalid code",
    } as unknown as Response)));
    const kv = createMockKV({ "delegate_mcp_state:st-1": JSON.stringify({ clientId: "c1", scope: "openid" }) });
    const app = createDelegatingHandler("office");

    const res = await app.request("/callback-delegate?code=abc&state=st-1", {}, createEnv({ oauthKv: kv }));

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Auth verification failed \(401\)/);
  });

  it("shows a 502 error page when google-auth is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const kv = createMockKV({ "delegate_mcp_state:st-1": JSON.stringify({ clientId: "c1", scope: "openid" }) });
    const app = createDelegatingHandler("office");

    const res = await app.request("/callback-delegate?code=abc&state=st-1", {}, createEnv({ oauthKv: kv }));

    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/Could not reach auth server/);
  });

  it("calls the verify endpoint with the delegate code and service token bearer auth", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, json: async () => ({ sub: "user-1", email: "user@example.com" }),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);
    const kv = createMockKV({ "delegate_mcp_state:st-1": JSON.stringify({ clientId: "c1", scope: "openid" }) });
    const app = createDelegatingHandler("office");

    await app.request("/callback-delegate?code=my-code&state=st-1", {}, createEnv({ oauthKv: kv }));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.lens.io.vn/delegate/verify",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer service-token" }),
        body: JSON.stringify({ code: "my-code" }),
      }),
    );
  });

  it("on success, completes authorization with google_sub/email props and redirects to the returned URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, json: async () => ({ sub: "user-42", email: "user42@example.com" }),
    } as unknown as Response)));
    const savedRequest = { clientId: "c1", scope: "openid email" };
    const kv = createMockKV({ "delegate_mcp_state:st-1": JSON.stringify(savedRequest) });
    const completeAuthorization = vi.fn(async () => ({ redirectTo: "https://claude.ai/callback?code=final" }));
    const app = createDelegatingHandler("office");

    const res = await app.request(
      "/callback-delegate?code=abc&state=st-1", {}, createEnv({ oauthKv: kv, completeAuthorization }),
    );

    expect(completeAuthorization).toHaveBeenCalledWith({
      request:  savedRequest,
      userId:   "user-42",
      scope:    savedRequest.scope,
      metadata: {},
      props:    { google_sub: "user-42", email: "user42@example.com" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://claude.ai/callback?code=final");
  });
});
