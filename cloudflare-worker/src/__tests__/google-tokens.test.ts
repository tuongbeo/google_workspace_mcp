import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { storeTokens, getValidAccessToken, makeGetCreds } from "../google-tokens";
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

type MockKV = ReturnType<typeof createMockKV>;

function record(overrides: Partial<StoredTokenRecord> = {}): StoredTokenRecord {
  return {
    access_token:  "access-1",
    refresh_token: "refresh-1",
    expires_at:    Math.floor(Date.now() / 1000) + 3600, // far from expiry by default
    scopes:        "",
    google_client_id:     "client-id",
    google_client_secret: "client-secret",
    ...overrides,
  };
}

function mockFetchResponse(ok: boolean, body: unknown) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("google-tokens", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── storeTokens ──────────────────────────────────────────────────────────

  describe("storeTokens", () => {
    it("writes a token record under the namespaced key with the expected TTL", async () => {
      const kv = createMockKV();
      const before = Math.floor(Date.now() / 1000);

      await storeTokens("sub-1", "at-1", "rt-1", 3600, "cid", "csecret", kv as any, "office");

      expect(kv.put).toHaveBeenCalledTimes(1);
      const [key, value, opts] = kv.put.mock.calls[0];
      expect(key).toBe("tokens:office:sub-1");
      expect(opts).toEqual({ expirationTtl: 90 * 24 * 3600 });

      const stored = JSON.parse(value as string) as StoredTokenRecord;
      expect(stored.access_token).toBe("at-1");
      expect(stored.refresh_token).toBe("rt-1");
      expect(stored.google_client_id).toBe("cid");
      expect(stored.google_client_secret).toBe("csecret");
      expect(stored.expires_at).toBeGreaterThanOrEqual(before + 3600);
    });

    it("defaults to the workspace namespace when none is given", async () => {
      const kv = createMockKV();
      await storeTokens("sub-1", "at-1", "rt-1", 3600, "cid", "csecret", kv as any);
      expect(kv.put.mock.calls[0][0]).toBe("tokens:workspace:sub-1");
    });
  });

  // ── getValidAccessToken: no-refresh-needed paths ────────────────────────

  describe("getValidAccessToken — cached token still valid", () => {
    it("throws when there is no stored token", async () => {
      const kv = createMockKV();
      await expect(getValidAccessToken("sub-1", kv as any)).rejects.toThrow(/No Google token/);
    });

    it("returns the cached access token when far from expiry (seconds-based expires_at)", async () => {
      const rec = record({ access_token: "cached-at", expires_at: Math.floor(Date.now() / 1000) + 3600 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const token = await getValidAccessToken("sub-1", kv as any);

      expect(token).toBe("cached-at");
      expect(kv.put).not.toHaveBeenCalled(); // no refresh attempted
    });

    it("correctly normalizes milliseconds-based expires_at (google-auth format)", async () => {
      const farFutureMs = Date.now() + 3600 * 1000;
      const rec = record({ access_token: "cached-at-ms", expires_at: farFutureMs });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const token = await getValidAccessToken("sub-1", kv as any);

      expect(token).toBe("cached-at-ms");
      expect(kv.put).not.toHaveBeenCalled();
    });
  });

  // ── getValidAccessToken: refresh required, validation paths ────────────

  describe("getValidAccessToken — refresh required", () => {
    function nearExpiryRecord(overrides: Partial<StoredTokenRecord> = {}) {
      return record({
        expires_at: Math.floor(Date.now() / 1000) + 60, // inside the 10-min threshold
        ...overrides,
      });
    }

    it("throws when near expiry with no client credentials and no fallback", async () => {
      const rec = nearExpiryRecord({ google_client_id: undefined, google_client_secret: undefined });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      await expect(getValidAccessToken("sub-1", kv as any)).rejects.toThrow(/No Google credentials/);
    });

    it("falls back to the provided client id/secret when the record lacks its own", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse(true, { access_token: "new-at", expires_in: 3600 })));
      const rec = nearExpiryRecord({ google_client_id: undefined, google_client_secret: undefined });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const promise = getValidAccessToken("sub-1", kv as any, "fallback-id", "fallback-secret");
      await vi.runAllTimersAsync();
      const token = await promise;

      expect(token).toBe("new-at");
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const body = fetchMock.mock.calls[0][1].body as string;
      expect(body).toContain("client_id=fallback-id");
      expect(body).toContain("client_secret=fallback-secret");
    });

    it("throws when near expiry with no refresh token", async () => {
      const rec = nearExpiryRecord({ refresh_token: null });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      await expect(getValidAccessToken("sub-1", kv as any)).rejects.toThrow(/No refresh token/);
    });
  });

  // ── getValidAccessToken: locking ────────────────────────────────────────

  describe("getValidAccessToken — refresh locking", () => {
    it("returns the current (possibly stale) token without fetching when a refresh lock is held", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const rec = record({
        access_token: "stale-but-locked",
        expires_at: Math.floor(Date.now() / 1000) + 60,
      });
      const kv = createMockKV({
        "tokens:workspace:sub-1": JSON.stringify(rec),
        "lock:refresh:workspace:sub-1": "1",
      });

      const token = await getValidAccessToken("sub-1", kv as any);

      expect(token).toBe("stale-but-locked");
      expect(fetch).not.toHaveBeenCalled();
    });

    it("acquires and releases the lock around a successful refresh", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse(true, { access_token: "fresh-at", expires_in: 3600 })));
      const rec = record({ expires_at: Math.floor(Date.now() / 1000) + 60 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const promise = getValidAccessToken("sub-1", kv as any);
      await vi.runAllTimersAsync();
      await promise;

      // Lock acquired (put) then released (delete) — order matters.
      const putKeys = kv.put.mock.calls.map((c: any[]) => c[0]);
      expect(putKeys).toContain("lock:refresh:workspace:sub-1");
      expect(kv.delete).toHaveBeenCalledWith("lock:refresh:workspace:sub-1");
      // Lock must no longer be present afterward.
      expect(kv.store.has("lock:refresh:workspace:sub-1")).toBe(false);
    });

    it("releases the lock even when refresh ultimately fails", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse(false, { error: "invalid_grant" })));
      // Expired long enough ago to be outside the 5-minute grace window.
      const rec = record({ expires_at: Math.floor(Date.now() / 1000) - 3600 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const assertion = expect(getValidAccessToken("sub-1", kv as any)).rejects.toThrow();
      await vi.runAllTimersAsync();
      await assertion;

      expect(kv.store.has("lock:refresh:workspace:sub-1")).toBe(false);
    });
  });

  // ── refreshWithRetry (exercised via getValidAccessToken) ────────────────

  describe("getValidAccessToken — refresh retry/backoff", () => {
    it("succeeds on first attempt and persists the updated record", async () => {
      const fetchMock = vi.fn(async () => mockFetchResponse(true, {
        access_token: "new-at", expires_in: 1800, refresh_token: "new-rt",
      }));
      vi.stubGlobal("fetch", fetchMock);
      const rec = record({ expires_at: Math.floor(Date.now() / 1000) + 60 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const promise = getValidAccessToken("sub-1", kv as any);
      await vi.runAllTimersAsync();
      const token = await promise;

      expect(token).toBe("new-at");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const stored = JSON.parse(kv.store.get("tokens:workspace:sub-1")!) as StoredTokenRecord;
      expect(stored.access_token).toBe("new-at");
      expect(stored.refresh_token).toBe("new-rt");
    });

    it("keeps the old refresh token when Google doesn't rotate it", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse(true, { access_token: "new-at", expires_in: 1800 })));
      const rec = record({ refresh_token: "original-rt", expires_at: Math.floor(Date.now() / 1000) + 60 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const promise = getValidAccessToken("sub-1", kv as any);
      await vi.runAllTimersAsync();
      await promise;

      const stored = JSON.parse(kv.store.get("tokens:workspace:sub-1")!) as StoredTokenRecord;
      expect(stored.refresh_token).toBe("original-rt");
    });

    it("retries transient errors with backoff and succeeds once Google recovers", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(false, { error: "server_error" }))
        .mockResolvedValueOnce(mockFetchResponse(false, { error: "server_error" }))
        .mockResolvedValueOnce(mockFetchResponse(true, { access_token: "recovered-at", expires_in: 3600 }));
      vi.stubGlobal("fetch", fetchMock);
      const rec = record({ expires_at: Math.floor(Date.now() / 1000) + 60 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const promise = getValidAccessToken("sub-1", kv as any);
      await vi.runAllTimersAsync();
      const token = await promise;

      expect(token).toBe("recovered-at");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("does not retry on invalid_grant — deletes the stored token immediately", async () => {
      const fetchMock = vi.fn(async () => mockFetchResponse(false, { error: "invalid_grant" }));
      vi.stubGlobal("fetch", fetchMock);
      // Outside the grace window so the permanent failure actually surfaces.
      const rec = record({ expires_at: Math.floor(Date.now() / 1000) - 3600 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const assertion = expect(getValidAccessToken("sub-1", kv as any)).rejects.toThrow(/invalid_grant/);
      await vi.runAllTimersAsync();
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(1); // no retries for permanent failures
      expect(kv.store.has("tokens:workspace:sub-1")).toBe(false); // token wiped
    });

    it("exhausts retries and throws the last transient error when outside the grace window", async () => {
      const fetchMock = vi.fn(async () => mockFetchResponse(false, { error: "server_error" }));
      vi.stubGlobal("fetch", fetchMock);
      const rec = record({ expires_at: Math.floor(Date.now() / 1000) - 3600 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const assertion = expect(getValidAccessToken("sub-1", kv as any)).rejects.toThrow(/refresh failed/);
      await vi.runAllTimersAsync();
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(4); // initial attempt + 3 retries
    });
  });

  // ── getValidAccessToken: 5-minute stale-token grace window ──────────────

  describe("getValidAccessToken — stale-token grace period", () => {
    it("returns the stale access token when refresh fails within 5 minutes of expiry", async () => {
      const fetchMock = vi.fn(async () => mockFetchResponse(false, { error: "server_error" }));
      vi.stubGlobal("fetch", fetchMock);
      // Expired 2 minutes ago — inside the 300s grace window.
      const rec = record({ access_token: "grace-token", expires_at: Math.floor(Date.now() / 1000) - 120 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const promise = getValidAccessToken("sub-1", kv as any);
      await vi.runAllTimersAsync();
      const token = await promise;

      expect(token).toBe("grace-token");
    });

    it("does NOT apply the grace window for a permanent (invalid_grant) failure — the token is definitively dead", async () => {
      const fetchMock = vi.fn(async () => mockFetchResponse(false, { error: "invalid_grant" }));
      vi.stubGlobal("fetch", fetchMock);
      const rec = record({ access_token: "grace-token-2", expires_at: Math.floor(Date.now() / 1000) - 60 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      // Attach the rejection assertion before advancing fake timers, so the
      // handler is registered before the promise actually rejects — otherwise
      // vitest flags it as an unhandled rejection even though it IS awaited below.
      const assertion = expect(getValidAccessToken("sub-1", kv as any)).rejects.toThrow(/invalid_grant/);
      await vi.runAllTimersAsync();
      // Handing back a stale token here would just trade a clear
      // "re-authenticate" error for a confusing 401 deeper in whatever tool
      // call triggered this — invalid_grant means there is nothing to
      // recover, so the error must propagate instead of being masked.
      await assertion;
      expect(kv.store.has("tokens:workspace:sub-1")).toBe(false);
    });

    it("rejects once the token has been stale for more than 5 minutes", async () => {
      const fetchMock = vi.fn(async () => mockFetchResponse(false, { error: "server_error" }));
      vi.stubGlobal("fetch", fetchMock);
      const rec = record({ expires_at: Math.floor(Date.now() / 1000) - 301 });
      const kv = createMockKV({ "tokens:workspace:sub-1": JSON.stringify(rec) });

      const assertion = expect(getValidAccessToken("sub-1", kv as any)).rejects.toThrow();
      await vi.runAllTimersAsync();
      await assertion;
    });
  });

  // ── namespace isolation ──────────────────────────────────────────────────

  describe("getValidAccessToken — namespace isolation", () => {
    it("reads from the namespaced key and does not see tokens stored under a different namespace", async () => {
      const rec = record({ access_token: "office-token" });
      const kv = createMockKV({ "tokens:office:sub-1": JSON.stringify(rec) });

      await expect(getValidAccessToken("sub-1", kv as any, undefined, undefined, "workspace"))
        .rejects.toThrow(/No Google token/);

      const token = await getValidAccessToken("sub-1", kv as any, undefined, undefined, "office");
      expect(token).toBe("office-token");
    });
  });

  // ── makeGetCreds ──────────────────────────────────────────────────────────

  describe("makeGetCreds", () => {
    it("builds a getCreds function scoped to the given sub/env/namespace", async () => {
      const rec = record({ access_token: "office-at" });
      const kv = createMockKV({ "tokens:office:sub-1": JSON.stringify(rec) });
      const env = { TOKENS_KV: kv as any, GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret" };

      const getCreds = makeGetCreds("sub-1", env, "office");
      const creds = await getCreds();

      expect(creds).toEqual({ accessToken: "office-at" });
    });
  });
});
