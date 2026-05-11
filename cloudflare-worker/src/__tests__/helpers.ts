/**
 * Shared test helpers: MockKV, mockEnv, fetch mocker
 */
import { vi } from "vitest";

export class MockKV {
  private store = new Map<string, string>();
  async get(key: string, type?: string): Promise<any> {
    const val = this.store.get(key);
    if (val === undefined) return null;
    if (type === "json") { try { return JSON.parse(val); } catch { return null; } }
    return val;
  }
  async put(key: string, value: string, _opts?: any): Promise<void> { this.store.set(key, String(value)); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  _set(key: string, value: string) { this.store.set(key, value); }
  _get(key: string) { return this.store.get(key); }
  _has(key: string) { return this.store.has(key); }
  _clear() { this.store.clear(); }
}

export function makeMockEnv(overrides: Record<string, any> = {}) {
  return {
    OAUTH_KV:  overrides.OAUTH_KV  ?? new MockKV(),
    TOKENS_KV: overrides.TOKENS_KV ?? new MockKV(),
    CONFIG_KV: overrides.CONFIG_KV ?? new MockKV(),
    JWT_SECRET:      overrides.JWT_SECRET      ?? "test-secret-minimum-32-characters!",
    PUBLIC_BASE_URL: overrides.PUBLIC_BASE_URL ?? "https://test.workers.dev",
    GOOGLE_OAUTH_CLIENT_ID:     overrides.GOOGLE_OAUTH_CLIENT_ID     ?? "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: overrides.GOOGLE_OAUTH_CLIENT_SECRET ?? "google-client-secret",
  } as any;
}

export function mockFetchSequence(responses: Array<{ body: unknown; status?: number }>) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const r of responses) {
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    spy.mockResolvedValueOnce(new Response(text, { status: r.status ?? 200, headers: { "Content-Type": "application/json" } }));
  }
  return spy;
}

export const GOOGLE_TOKEN_RESPONSE = {
  access_token: "ya29.access-token",
  refresh_token: "1//refresh-token",
  expires_in: 3599,
  token_type: "Bearer",
};

export const GOOGLE_USERINFO = {
  sub: "112258372811300970435",
  email: "user@example.com",
};
