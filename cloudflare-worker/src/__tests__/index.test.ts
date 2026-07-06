import { describe, it, expect, vi, beforeEach } from "vitest";

const oauthProviderFetch = vi.fn(async () => new Response("oauth-provider-response"));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  default: vi.fn().mockImplementation(() => ({ fetch: oauthProviderFetch })),
}));

vi.mock("../mcp-worker", () => ({
  GoogleWorkspaceAgent: { serve: vi.fn(() => ({ fetch: vi.fn() })) },
}));

vi.mock("../auth/google", () => ({
  createDelegatingHandler: vi.fn(() => ({})),
}));

describe("index.ts — request routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const env = { PUBLIC_BASE_URL: "https://office.lens.io.vn" } as any;
  const ctx = {} as ExecutionContext;

  it("serves /health from the manual router without touching OAuthProvider", async () => {
    const { default: worker } = await import("../index");
    const res = await worker.fetch(new Request("https://office.lens.io.vn/health"), env, ctx);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("mcp-google-workspace");
    expect(oauthProviderFetch).not.toHaveBeenCalled();
  });

  it("serves /.well-known/oauth-protected-resource from the manual router with CORS + cache headers", async () => {
    const { default: worker } = await import("../index");
    const res = await worker.fetch(
      new Request("https://office.lens.io.vn/.well-known/oauth-protected-resource"), env, ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    const body = await res.json() as any;
    expect(body.resource).toBe("https://office.lens.io.vn/mcp");
    expect(body.authorization_servers).toEqual(["https://office.lens.io.vn"]);
    expect(oauthProviderFetch).not.toHaveBeenCalled();
  });

  it("delegates every other path to OAuthProvider.fetch", async () => {
    const { default: worker } = await import("../index");
    const req = new Request("https://office.lens.io.vn/mcp");

    const res = await worker.fetch(req, env, ctx);

    expect(oauthProviderFetch).toHaveBeenCalledTimes(1);
    expect(oauthProviderFetch).toHaveBeenCalledWith(req, env, ctx);
    expect(await res.text()).toBe("oauth-provider-response");
  });

  it("delegates /authorize, /token, and /register to OAuthProvider.fetch", async () => {
    const { default: worker } = await import("../index");

    for (const path of ["/authorize", "/token", "/register", "/callback-delegate"]) {
      await worker.fetch(new Request(`https://office.lens.io.vn${path}`), env, ctx);
    }

    expect(oauthProviderFetch).toHaveBeenCalledTimes(4);
  });
});
