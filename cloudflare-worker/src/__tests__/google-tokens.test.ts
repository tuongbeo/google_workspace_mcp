import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getValidAccessToken, makeGetCreds } from "../google-tokens";
import type { StoredTokenRecord } from "../types";

// ─── Mock KVNamespace ─────────────────────────────────────────────────────────

function createMockKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

const AUTH_BASE_URL  = "https://auth.example.com";
const SERVICE_TOKEN  = "svc_test_token";

function record(overrides: Partial<StoredTokenRecord> = {}): StoredTokenRecord {
  return {
    access_token:  "access-1",
    refresh_token: "refresh-1",
    expires_at:    Math.floor(Date.now() / 1000) + 3600, // far from expiry by default
    scopes:        "",
    ...overrides,
  };
}

/** A well-formed POST /delegate/refresh JSON response. */
function mockDelegateRefreshResponse(body: Record<string, unknown>, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("google-tokens", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── getValidAccessToken: no-refresh-needed paths ────────────────────────

  describe("getValidAccessToken — cached token still valid", () => {
    it("throws when there is no stored token", async () => {
      const kv = createMockKV();
      await expect(getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN))
        .rejects.toThrow(/No Google token/);
    });

    it("returns the cached access token when far from expiry (seconds-based expires_at) — no network call", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const rec = record({ access_token: "cached-at", expires_at: Math.floor(Date.now() / 1000) + 3600 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const token = await getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN);

      expect(token).toBe("cached-at");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("correctly normalizes milliseconds-based expires_at (google-auth format)", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const farFutureMs = Date.now() + 3600 * 1000;
      const rec = record({ access_token: "cached-at-ms", expires_at: farFutureMs });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const token = await getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN);

      expect(token).toBe("cached-at-ms");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ── getValidAccessToken: refresh required — calls google-auth ──────────

  describe("getValidAccessToken — refresh required", () => {
    function nearExpiryRecord(overrides: Partial<StoredTokenRecord> = {}) {
      return record({
        expires_at: Math.floor(Date.now() / 1000) + 60, // inside the 10-min threshold
        ...overrides,
      });
    }

    it("throws when near expiry with no refresh token, without calling google-auth", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const rec = nearExpiryRecord({ refresh_token: null });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      await expect(getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN))
        .rejects.toThrow(/No refresh token/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("calls POST {authBaseUrl}/delegate/refresh with Bearer service token and {sub, server_name}", async () => {
      const fetchMock = vi.fn(async (_url: string, _init: RequestInit & { headers: Record<string, string>; body: string }) =>
        mockDelegateRefreshResponse({ error: "ok", access_token: "new-at", expires_at: Date.now() + 3600_000 }));
      vi.stubGlobal("fetch", fetchMock);
      const rec = nearExpiryRecord();
      const kv = createMockKV({ "tokens:office:sub-1": JSON.stringify(rec) });

      const token = await getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN, "office");

      expect(token).toBe("new-at");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${AUTH_BASE_URL}/delegate/refresh`);
      expect(init.headers.Authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
      const body = JSON.parse(init.body);
      expect(body).toEqual({ sub: "sub-1", server_name: "office" });
    });

    it("does not write to TOKENS_KV itself — google-auth is the sole writer now", async () => {
      const fetchMock = vi.fn(async () => mockDelegateRefreshResponse({ error: "ok", access_token: "new-at", expires_at: Date.now() + 3600_000 }));
      vi.stubGlobal("fetch", fetchMock);
      const rec = nearExpiryRecord();
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      await getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN);

      expect(kv.put).not.toHaveBeenCalled();
    });
  });

  // ── getValidAccessToken: permanent failures (no grace window) ───────────

  describe("getValidAccessToken — permanent failures", () => {
    it("throws immediately on reauth_required (Google invalid_grant, relayed by google-auth)", async () => {
      const fetchMock = vi.fn(async () => mockDelegateRefreshResponse({ error: "reauth_required" }, 401));
      vi.stubGlobal("fetch", fetchMock);
      // Outside the grace window too, to prove reauth_required short-circuits it either way.
      const rec = record({ expires_at: Math.floor(Date.now() / 1000) - 3600 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      await expect(getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN))
        .rejects.toThrow(/reauth_required/);
    });

    it("throws immediately on not_found (record vanished between local read and the call)", async () => {
      const fetchMock = vi.fn(async () => mockDelegateRefreshResponse({ error: "not_found" }, 404));
      vi.stubGlobal("fetch", fetchMock);
      const rec = record({ expires_at: Math.floor(Date.now() / 1000) - 3600 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      await expect(getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN))
        .rejects.toThrow(/not_found/);
    });
  });

  // ── getValidAccessToken: 5-minute stale-token grace window ──────────────
  // config_error / transient are google-auth's own ops issue or a network blip —
  // not the user's fault — so a still-fresh-ish cached token may be used briefly.

  describe("getValidAccessToken — stale-token grace period", () => {
    it("returns the stale access token when google-auth reports transient failure within 5 minutes of expiry", async () => {
      const fetchMock = vi.fn(async () => mockDelegateRefreshResponse({ error: "transient" }, 502));
      vi.stubGlobal("fetch", fetchMock);
      // Expired 2 minutes ago — inside the 300s grace window.
      const rec = record({ access_token: "grace-token", expires_at: Math.floor(Date.now() / 1000) - 120 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const token = await getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN);

      expect(token).toBe("grace-token");
    });

    it("returns the stale access token when google-auth reports config_error (its own OAuth client is misconfigured)", async () => {
      const fetchMock = vi.fn(async () => mockDelegateRefreshResponse({ error: "config_error" }, 500));
      vi.stubGlobal("fetch", fetchMock);
      const rec = record({ access_token: "grace-token-cfg", expires_at: Math.floor(Date.now() / 1000) - 120 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const token = await getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN);

      expect(token).toBe("grace-token-cfg");
    });

    it("rejects once the token has been stale for more than 5 minutes", async () => {
      const fetchMock = vi.fn(async () => mockDelegateRefreshResponse({ error: "transient" }, 502));
      vi.stubGlobal("fetch", fetchMock);
      const rec = record({ expires_at: Math.floor(Date.now() / 1000) - 301 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      await expect(getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN)).rejects.toThrow();
    });
  });

  // ── getValidAccessToken: malformed / unreachable google-auth responses ──
  // Anything that isn't a well-formed {error: string} JSON body must fall into
  // the transient/grace-window path, not be treated as a hard failure.

  describe("getValidAccessToken — malformed or unreachable google-auth responses", () => {
    it("treats a network failure as transient (grace window applies)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
      const rec = record({ access_token: "grace-token-net", expires_at: Math.floor(Date.now() / 1000) - 120 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const token = await getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN);
      expect(token).toBe("grace-token-net");
    });

    it("treats a non-JSON response body as transient", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: false, status: 502, json: async () => { throw new Error("not json"); },
      } as unknown as Response)));
      const rec = record({ access_token: "grace-token-nonjson", expires_at: Math.floor(Date.now() / 1000) - 120 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const token = await getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN);
      expect(token).toBe("grace-token-nonjson");
    });

    it("treats a JSON body missing the `error` field as transient (e.g. an old/mismatched deploy)", async () => {
      const fetchMock = vi.fn(async () => mockDelegateRefreshResponse({ unexpected: "shape" }, 404));
      vi.stubGlobal("fetch", fetchMock);
      const rec = record({ access_token: "grace-token-shape", expires_at: Math.floor(Date.now() / 1000) - 120 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const token = await getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN);
      expect(token).toBe("grace-token-shape");
    });
  });

  // ── namespace isolation ──────────────────────────────────────────────────

  describe("getValidAccessToken — namespace isolation", () => {
    it("reads from the namespaced key and does not see tokens stored under a different namespace", async () => {
      const rec = record({ access_token: "office-token" });
      const kv = createMockKV({ "tokens:office:sub-1": JSON.stringify(rec) });

      await expect(getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN, "workspace"))
        .rejects.toThrow(/No Google token/);

      const token = await getValidAccessToken("sub-1", kv as any, AUTH_BASE_URL, SERVICE_TOKEN, "office");
      expect(token).toBe("office-token");
    });
  });

  // ── makeGetCreds ──────────────────────────────────────────────────────────

  describe("makeGetCreds", () => {
    it("builds a getCreds function scoped to the given sub/env/namespace", async () => {
      const rec = record({ access_token: "office-at" });
      const kv = createMockKV({ "tokens:office:sub-1": JSON.stringify(rec) });
      const env = { TOKENS_KV: kv as any, GOOGLE_AUTH_BASE_URL: AUTH_BASE_URL, GOOGLE_AUTH_SERVICE_TOKEN: SERVICE_TOKEN };

      const getCreds = makeGetCreds("sub-1", env, "office");
      const creds = await getCreds();

      expect(creds).toEqual({ accessToken: "office-at" });
    });
  });
});
