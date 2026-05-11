/**
 * Test suite: jwt.ts — signJWT, verifyJWT, storeTokens, getValidAccessToken, extractSub
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signJWT, verifyJWT, storeTokens, getValidAccessToken, extractSub } from "../jwt";
import { MockKV } from "./helpers";

const SECRET = "test-secret-minimum-32-characters!";
const SUB    = "user-112258372811300970435";

// ── signJWT / verifyJWT ───────────────────────────────────────────────────────

describe("signJWT", () => {
  it("TC-JWT-01: returns 3-part dot-separated token", async () => {
    const token = await signJWT({ sub: SUB }, SECRET, 3600);
    expect(token.split(".")).toHaveLength(3);
  });

  it("TC-JWT-02: payload contains correct sub claim", async () => {
    const token = await signJWT({ sub: SUB }, SECRET, 3600);
    const raw = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(raw + "=".repeat((4 - raw.length % 4) % 4)));
    expect(payload.sub).toBe(SUB);
  });

  it("TC-JWT-03: exp is set to approximately now + expiresInSeconds", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signJWT({ sub: SUB }, SECRET, 600);
    const raw = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(raw + "=".repeat((4 - raw.length % 4) % 4)));
    expect(payload.exp).toBeGreaterThanOrEqual(before + 600);
    expect(payload.exp).toBeLessThanOrEqual(before + 610);
  });
});

describe("verifyJWT", () => {
  it("TC-JWT-04: valid token returns payload with sub", async () => {
    const token = await signJWT({ sub: SUB }, SECRET, 3600);
    const payload = await verifyJWT(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(SUB);
  });

  it("TC-JWT-05: expired token returns null", async () => {
    const token = await signJWT({ sub: SUB }, SECRET, -1);
    expect(await verifyJWT(token, SECRET)).toBeNull();
  });

  it("TC-JWT-06: wrong secret returns null", async () => {
    const token = await signJWT({ sub: SUB }, SECRET, 3600);
    expect(await verifyJWT(token, "wrong-secret-that-is-32-chars!!!")).toBeNull();
  });

  it("TC-JWT-07: token with fewer than 3 parts returns null", async () => {
    expect(await verifyJWT("not.valid", SECRET)).toBeNull();
  });

  it("TC-JWT-08: tampered payload (invalid base64) returns null", async () => {
    const token = await signJWT({ sub: SUB }, SECRET, 3600);
    const [h, , s] = token.split(".");
    expect(await verifyJWT(`${h}.!!!INVALID!!!.${s}`, SECRET)).toBeNull();
  });
});

// ── storeTokens ───────────────────────────────────────────────────────────────

describe("storeTokens", () => {
  it("TC-JWT-09: writes record under token:{sub} key", async () => {
    const kv = new MockKV();
    await storeTokens(SUB, "acc", "ref", 3600, "cid", "csec", kv as any);
    expect(kv._has(`token:${SUB}`)).toBe(true);
  });

  it("TC-JWT-10: stored record contains all required fields", async () => {
    const kv = new MockKV();
    await storeTokens(SUB, "acc", "ref", 3600, "cid", "csec", kv as any);
    const r = JSON.parse(kv._get(`token:${SUB}`)!);
    expect(r.access_token).toBe("acc");
    expect(r.refresh_token).toBe("ref");
    expect(r.google_client_id).toBe("cid");
    expect(r.google_client_secret).toBe("csec");
    expect(r.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3590);
  });
});

// ── getValidAccessToken ───────────────────────────────────────────────────────

describe("getValidAccessToken", () => {
  let kv: MockKV;
  beforeEach(() => { kv = new MockKV(); });
  afterEach(() => { vi.restoreAllMocks(); });

  function seed(overrides: Record<string, any> = {}) {
    const rec = {
      access_token: "current-access",
      refresh_token: "current-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      scopes: "",
      google_client_id: "g-cid",
      google_client_secret: "g-csec",
      ...overrides,
    };
    kv._set(`token:${SUB}`, JSON.stringify(rec));
    return rec;
  }

  it("TC-JWT-11: valid token not near expiry → returns access_token", async () => {
    seed();
    expect(await getValidAccessToken(SUB, kv as any)).toBe("current-access");
  });

  it("TC-JWT-12: no token in KV → throws re-auth error", async () => {
    await expect(getValidAccessToken(SUB, kv as any)).rejects.toThrow("re-authenticate");
  });

  it("TC-JWT-13: near expiry, no credentials → throws", async () => {
    seed({ expires_at: Math.floor(Date.now() / 1000) + 300, google_client_id: "", google_client_secret: "" });
    await expect(getValidAccessToken(SUB, kv as any, undefined, undefined)).rejects.toThrow("No Google credentials");
  });

  it("TC-JWT-14: near expiry, empty refresh_token → throws", async () => {
    seed({ expires_at: Math.floor(Date.now() / 1000) + 300, refresh_token: "" });
    await expect(getValidAccessToken(SUB, kv as any)).rejects.toThrow("no refresh token");
  });

  it("TC-JWT-15: refresh lock active → returns current token, no Google call", async () => {
    seed({ expires_at: Math.floor(Date.now() / 1000) + 300 });
    kv._set(`lock:refresh:${SUB}`, "1");
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await getValidAccessToken(SUB, kv as any)).toBe("current-access");
    expect(spy).not.toHaveBeenCalled();
  });

  it("TC-JWT-16: near expiry, refresh succeeds → returns new token, lock removed", async () => {
    seed({ expires_at: Math.floor(Date.now() / 1000) + 300 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), { status: 200 })
    );
    expect(await getValidAccessToken(SUB, kv as any)).toBe("new-access");
    expect(kv._has(`lock:refresh:${SUB}`)).toBe(false);
    expect(JSON.parse(kv._get(`token:${SUB}`)!).access_token).toBe("new-access");
  });

  it("TC-JWT-17: refresh fails with invalid_grant → deletes KV entry, throws", async () => {
    seed({ expires_at: Math.floor(Date.now() / 1000) + 300 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    );
    await expect(getValidAccessToken(SUB, kv as any)).rejects.toThrow("permanently failed");
    expect(kv._has(`token:${SUB}`)).toBe(false);
  });

  it("TC-JWT-18: transient 500 on attempt 0, succeeds on attempt 1 (retry logic)", async () => {
    seed({ expires_at: Math.floor(Date.now() / 1000) + 300 });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("internal error", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "retry-token", expires_in: 3600 }), { status: 200 }));
    expect(await getValidAccessToken(SUB, kv as any)).toBe("retry-token");
  }, 10_000);

  it("TC-JWT-19: all retries exhausted → throws last error", async () => {
    seed({ expires_at: Math.floor(Date.now() / 1000) + 300 });
    // Each retry reads the body once — need a fresh Response per call
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("rate limited", { status: 429 }))
    );
    await expect(getValidAccessToken(SUB, kv as any)).rejects.toThrow("Token refresh failed");
  }, 15_000);

  it("TC-JWT-20: fallback credentials used when record has none", async () => {
    seed({
      expires_at: Math.floor(Date.now() / 1000) + 300,
      google_client_id: "",
      google_client_secret: "",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "fallback-token", expires_in: 3600 }), { status: 200 })
    );
    const token = await getValidAccessToken(SUB, kv as any, "fallback-cid", "fallback-csec");
    expect(token).toBe("fallback-token");
  });
});

// ── extractSub ────────────────────────────────────────────────────────────────

describe("extractSub", () => {
  it("TC-JWT-21: valid Bearer token → returns sub", async () => {
    const token = await signJWT({ sub: SUB }, SECRET, 3600);
    const req = new Request("https://e.com", { headers: { Authorization: `Bearer ${token}` } });
    expect(await extractSub(req, SECRET)).toBe(SUB);
  });

  it("TC-JWT-22: no Authorization header → null", async () => {
    expect(await extractSub(new Request("https://e.com"), SECRET)).toBeNull();
  });

  it("TC-JWT-23: expired JWT → null", async () => {
    const token = await signJWT({ sub: SUB }, SECRET, -1);
    const req = new Request("https://e.com", { headers: { Authorization: `Bearer ${token}` } });
    expect(await extractSub(req, SECRET)).toBeNull();
  });

  it("TC-JWT-24: token has no sub claim → null", async () => {
    const token = await signJWT({ user: "no-sub" }, SECRET, 3600);
    const req = new Request("https://e.com", { headers: { Authorization: `Bearer ${token}` } });
    expect(await extractSub(req, SECRET)).toBeNull();
  });
});
