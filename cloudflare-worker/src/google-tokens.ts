/**
 * Google OAuth token storage & refresh.
 * Manages Google access/refresh tokens in TOKENS_KV.
 * Proxy JWT is now handled by @cloudflare/workers-oauth-provider.
 */

import { StoredTokenRecord } from "./types";

const KV_TOKEN_PREFIX = "token:";
const KV_LOCK_PREFIX  = "lock:refresh:";
const KV_TOKEN_TTL    = 90 * 24 * 3600;   // 90 days
const REFRESH_THRESHOLD = 10 * 60;         // refresh if < 10 min remaining

// ── Store tokens after OAuth callback ────────────────────────────────────────

export async function storeTokens(
  sub:                string,
  accessToken:        string,
  refreshToken:       string,
  expiresIn:          number,
  googleClientId:     string,
  googleClientSecret: string,
  kv:                 KVNamespace,
): Promise<void> {
  const record: StoredTokenRecord = {
    access_token:          accessToken,
    refresh_token:         refreshToken,
    expires_at:            Math.floor(Date.now() / 1000) + expiresIn,
    scopes:                "",
    google_client_id:      googleClientId,
    google_client_secret:  googleClientSecret,
  };
  await kv.put(`${KV_TOKEN_PREFIX}${sub}`, JSON.stringify(record), {
    expirationTtl: KV_TOKEN_TTL,
  });
  console.log(`[tokens] stored for sub=${sub}, expires_in=${expiresIn}s`);
}

// ── Refresh with exponential backoff ─────────────────────────────────────────

async function refreshWithRetry(
  record:             StoredTokenRecord,
  sub:                string,
  googleClientId:     string,
  googleClientSecret: string,
  kv:                 KVNamespace,
  retries = 3,
): Promise<StoredTokenRecord> {
  let lastErr: Error = new Error("unknown");

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        client_id:     googleClientId,
        client_secret: googleClientSecret,
        refresh_token: record.refresh_token,
      }).toString(),
    });

    if (res.ok) {
      const t = await res.json() as {
        access_token: string; expires_in?: number; refresh_token?: string;
      };
      const updated: StoredTokenRecord = {
        access_token:         t.access_token,
        refresh_token:        t.refresh_token || record.refresh_token,
        expires_at:           Math.floor(Date.now() / 1000) + (t.expires_in || 3600),
        scopes:               record.scopes,
        google_client_id:     googleClientId,
        google_client_secret: googleClientSecret,
      };
      await kv.put(`${KV_TOKEN_PREFIX}${sub}`, JSON.stringify(updated), {
        expirationTtl: KV_TOKEN_TTL,
      });
      console.log(`[tokens] refreshed sub=${sub} (attempt ${attempt + 1})`);
      return updated;
    }

    const errText = await res.text();
    let errBody: { error?: string } = {};
    try { errBody = JSON.parse(errText); } catch {}

    if (errBody.error === "invalid_grant" || errBody.error === "invalid_client") {
      console.warn(`[tokens] permanent failure (${errBody.error}) for sub=${sub}`);
      await kv.delete(`${KV_TOKEN_PREFIX}${sub}`);
      throw new Error(`Google token refresh failed permanently: ${errBody.error}`);
    }

    console.warn(`[tokens] transient error (${res.status}) attempt ${attempt + 1}: ${errText}`);
    lastErr = new Error(`refresh failed (${res.status}): ${errText}`);
  }

  throw lastErr;
}

// ── Get valid access token (refresh if needed) ────────────────────────────────

export async function getValidAccessToken(
  sub:                   string,
  kv:                    KVNamespace,
  fallbackClientId?:     string,
  fallbackClientSecret?: string,
): Promise<string> {
  const raw = await kv.get(`${KV_TOKEN_PREFIX}${sub}`);
  if (!raw) throw new Error(`No Google token for sub=${sub}. Re-authenticate.`);

  const record = JSON.parse(raw) as StoredTokenRecord;
  const now    = Math.floor(Date.now() / 1000);

  if (record.expires_at - now >= REFRESH_THRESHOLD) {
    return record.access_token;
  }

  const clientId     = record.google_client_id     || fallbackClientId;
  const clientSecret = record.google_client_secret || fallbackClientSecret;
  if (!clientId || !clientSecret) {
    throw new Error(`No Google credentials for sub=${sub}. Re-authenticate.`);
  }
  if (!record.refresh_token) {
    throw new Error(`No refresh token for sub=${sub}. Re-authenticate.`);
  }

  // Refresh locking — avoid concurrent refresh calls
  const lockKey = `${KV_LOCK_PREFIX}${sub}`;
  if (await kv.get(lockKey)) {
    console.log(`[tokens] refresh lock active for sub=${sub}, using current token`);
    return record.access_token;
  }
  await kv.put(lockKey, "1", { expirationTtl: 30 });

  try {
    const updated = await refreshWithRetry(record, sub, clientId, clientSecret, kv);
    return updated.access_token;
  } catch (err) {
    // 5-min grace: tool error is better than connector disconnect
    const staleSecs = now - record.expires_at;
    if (staleSecs >= 0 && staleSecs < 300) {
      console.warn(`[tokens] refresh failed, stale token (${staleSecs}s) for sub=${sub}`);
      return record.access_token;
    }
    throw err;
  } finally {
    await kv.delete(lockKey).catch(() => {});
  }
}
