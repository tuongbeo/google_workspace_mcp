/**
 * Google OAuth token storage & refresh.
 * Manages Google access/refresh tokens in TOKENS_KV.
 * Proxy JWT is now handled by @cloudflare/workers-oauth-provider.
 */

import type { StoredTokenRecord, GetCredsFunc } from "./types";

// "tokens:" matches google-auth's TOKENS_PREFIX in auth/delegate.ts
// Key schema: tokens:{namespace}:{sub}  e.g. tokens:office:12345
const KV_TOKEN_PREFIX   = "tokens:";
const KV_LOCK_PREFIX    = "lock:refresh:";
const KV_TOKEN_TTL      = 90 * 24 * 3600; // 90 days
const REFRESH_THRESHOLD = 10 * 60;         // refresh if < 10 min remaining

// ── Key helpers ───────────────────────────────────────────────────────────────

/** Canonical KV key for a stored token. Single source of truth for key schema. */
function tokenKey(namespace: string, sub: string): string {
  return `${KV_TOKEN_PREFIX}${namespace}:${sub}`;
}

/** Canonical KV key for a refresh lock. */
function lockKey(namespace: string, sub: string): string {
  return `${KV_LOCK_PREFIX}${namespace}:${sub}`;
}

// ── Store tokens after OAuth callback ────────────────────────────────────────

export async function storeTokens(
  sub:                string,
  accessToken:        string,
  refreshToken:       string,
  expiresIn:          number,
  googleClientId:     string,
  googleClientSecret: string,
  kv:                 KVNamespace,
  namespace = "workspace",
): Promise<void> {
  const record: StoredTokenRecord = {
    access_token:          accessToken,
    refresh_token:         refreshToken,
    expires_at:            Math.floor(Date.now() / 1000) + expiresIn,
    scopes:                "",
    google_client_id:      googleClientId,
    google_client_secret:  googleClientSecret,
  };
  await kv.put(tokenKey(namespace, sub), JSON.stringify(record), {
    expirationTtl: KV_TOKEN_TTL,
  });
  console.log(`[tokens] stored for ns=${namespace} sub=***${sub.slice(-4)}, expires_in=${expiresIn}s`);
}

// ── Refresh with exponential backoff ─────────────────────────────────────────

async function refreshWithRetry(
  record:             StoredTokenRecord,
  sub:                string,
  googleClientId:     string,
  googleClientSecret: string,
  kv:                 KVNamespace,
  retries = 3,
  namespace = "workspace",
): Promise<StoredTokenRecord> {
  if (!record.refresh_token) throw new Error(`No refresh token for ns=${namespace} sub=***${sub.slice(-4)}. Re-authenticate.`);
  const refreshToken = record.refresh_token;
  let lastErr: Error = new Error("unknown");

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }

    let res: Response;
    try {
      res = await fetch("https://oauth2.googleapis.com/token", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type:    "refresh_token",
          client_id:     googleClientId,
          client_secret: googleClientSecret,
          refresh_token: refreshToken,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.warn(`[tokens] refresh network error attempt ${attempt + 1} for ns=${namespace} sub=***${sub.slice(-4)}: ${lastErr.message}`);
      continue;
    }

    if (res.ok) {
      const t = await res.json() as {
        access_token: string; expires_in?: number; refresh_token?: string;
      };
      const updated: StoredTokenRecord = {
        access_token:         t.access_token,
        refresh_token:        t.refresh_token || refreshToken,
        expires_at:           Math.floor(Date.now() / 1000) + (t.expires_in || 3600),
        scopes:               record.scopes,
        google_client_id:     googleClientId,
        google_client_secret: googleClientSecret,
      };
      // Defend against the lock's TOCTOU window: if another concurrent refresh
      // already wrote a *newer* record while this one was in flight, keep that
      // one instead of overwriting it with ours (which may carry a stale
      // refresh_token if Google rotated it only on the other branch).
      const current = await kv.get(tokenKey(namespace, sub));
      if (current) {
        try {
          const currentRecord = JSON.parse(current) as StoredTokenRecord;
          if (currentRecord.expires_at > updated.expires_at) {
            console.log(`[tokens] refresh race detected for ns=${namespace} sub=***${sub.slice(-4)} — keeping newer concurrent record`);
            return currentRecord;
          }
        } catch { /* fall through and write ours */ }
      }
      await kv.put(tokenKey(namespace, sub), JSON.stringify(updated), {
        expirationTtl: KV_TOKEN_TTL,
      });
      console.log(`[tokens] refreshed ns=${namespace} sub=***${sub.slice(-4)} (attempt ${attempt + 1})`);
      return updated;
    }

    const errText = await res.text();
    let errBody: { error?: string } = {};
    try { errBody = JSON.parse(errText); } catch {}

    if (errBody.error === "invalid_grant") {
      // The user genuinely revoked access (or the refresh token is dead) —
      // there is nothing to recover, so drop the stored record and require
      // a fresh OAuth grant.
      console.warn(`[tokens] permanent failure (invalid_grant) for ns=${namespace} sub=***${sub.slice(-4)}`);
      await kv.delete(tokenKey(namespace, sub));
      throw new Error(`Google token refresh failed permanently: invalid_grant`);
    }
    if (errBody.error === "invalid_client") {
      // Likely a misconfigured/rotated client_id or client_secret on *our*
      // side, not a per-user problem — the user's refresh_token itself may
      // still be valid at Google. Don't delete their stored record (that
      // would force every affected user to fully re-authenticate over a
      // config issue); just surface the error so it can be fixed centrally.
      console.error(`[tokens] invalid_client refreshing ns=${namespace} sub=***${sub.slice(-4)} — check GOOGLE_OAUTH_CLIENT_ID/SECRET, not deleting stored token`);
      throw new Error(`Google token refresh failed: invalid_client (check OAuth client configuration)`);
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
  namespace = "workspace",
): Promise<string> {
  const raw = await kv.get(tokenKey(namespace, sub));
  if (!raw) throw new Error(`No Google token for ns=${namespace} sub=${sub}. Re-authenticate.`);

  const record = JSON.parse(raw) as StoredTokenRecord;
  const nowSec = Math.floor(Date.now() / 1000);

  // Normalize expires_at: google-auth stores ms (Date.now()), legacy stores seconds.
  // Values > 1e12 are milliseconds (year 2001 in ms ≈ 9.8e11).
  const expiresAtSec = record.expires_at > 1e12
    ? Math.floor(record.expires_at / 1000)
    : record.expires_at;

  if (expiresAtSec - nowSec >= REFRESH_THRESHOLD) {
    return record.access_token;
  }

  const clientId     = record.google_client_id     || fallbackClientId;
  const clientSecret = record.google_client_secret || fallbackClientSecret;
  if (!clientId || !clientSecret) {
    throw new Error(`No Google credentials for ns=${namespace} sub=${sub}. Re-authenticate.`);
  }
  if (!record.refresh_token) {
    throw new Error(`No refresh token for ns=${namespace} sub=${sub}. Re-authenticate.`);
  }

  // Refresh locking — avoid concurrent refresh calls
  const lock = lockKey(namespace, sub);
  if (await kv.get(lock)) {
    console.log(`[tokens] refresh lock active for ns=${namespace} sub=***${sub.slice(-4)}, using current token`);
    return record.access_token;
  }
  // Cloudflare KV rejects expirationTtl below 60s.
  await kv.put(lock, "1", { expirationTtl: 60 });

  try {
    const updated = await refreshWithRetry(record, sub, clientId, clientSecret, kv, 3, namespace);
    return updated.access_token;
  } catch (err) {
    // Permanent failures mean the stored token is definitively dead (invalid_grant,
    // already deleted from KV) or our own client credentials are wrong
    // (invalid_client) — handing back the old access_token in either case would
    // just trade a clear "re-authenticate" error for a confusing 401 deeper in
    // whatever tool call triggered this. Only apply the grace window to
    // transient failures (network blips, Google 5xx) where the old token may
    // still have a few valid seconds left.
    const isPermanent = err instanceof Error && /permanently|invalid_client/.test(err.message);
    const staleSecs = Math.floor(Date.now() / 1000) - expiresAtSec;
    if (!isPermanent && staleSecs >= 0 && staleSecs < 300) {
      console.warn(`[tokens] refresh failed transiently, using stale token (${staleSecs}s past expiry) for ns=${namespace} sub=***${sub.slice(-4)}`);
      return record.access_token;
    }
    throw err;
  } finally {
    await kv.delete(lock).catch((e) => {
      console.warn(`[tokens] failed to release refresh lock for ns=${namespace} sub=***${sub.slice(-4)}: ${e}`);
    });
  }
}

// ── Agent helper ──────────────────────────────────────────────────────────────

/**
 * Factory: build a `getCreds` function for an MCP agent.
 * Eliminates the same 6-line block repeated in every agent init().
 *
 * Usage:
 *   const getCreds = makeGetCreds(this.props.google_sub, this.env, "office");
 */
export function makeGetCreds(
  sub:       string,
  env:       { TOKENS_KV: KVNamespace; GOOGLE_OAUTH_CLIENT_ID: string; GOOGLE_OAUTH_CLIENT_SECRET: string },
  namespace = "workspace",
): GetCredsFunc {
  return async () => ({
    accessToken: await getValidAccessToken(
      sub,
      env.TOKENS_KV,
      env.GOOGLE_OAUTH_CLIENT_ID,
      env.GOOGLE_OAUTH_CLIENT_SECRET,
      namespace,
    ),
  });
}
