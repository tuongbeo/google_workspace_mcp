/**
 * Google REST API client helpers.
 * Dùng Google API v1/v3/v4 trực tiếp qua Bearer token.
 */

const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

export async function googleFetch(
  url: string,
  accessToken: string,
  method = "GET",
  body?: unknown,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error(`Google API request timed out after ${timeoutMs}ms [${method} ${url}]`);
    }
    throw e;
  }

  if (!response.ok) {
    let errorDetail = "";
    try { errorDetail = await response.text(); } catch { errorDetail = `HTTP ${response.status}`; }
    throw new Error(`Google API error [${method} ${url}] → ${response.status}: ${errorDetail}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

/**
 * Escape a value for safe embedding inside a single-quoted Drive `q` search
 * literal. Per Drive query syntax, backslashes must be escaped before quotes
 * (escaping quotes first would double-escape the backslashes we just added).
 */
export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Best-effort SSRF guard for tool parameters that cause this Worker to fetch
 * an arbitrary caller-supplied URL server-side (e.g. importing file content
 * from a URL). Blocks non-http(s) schemes and obvious private/loopback/
 * link-local targets. This cannot fully prevent DNS-rebinding style attacks
 * (Workers' fetch() resolves DNS itself, after this check runs), but it stops
 * the common cases: internal hostnames, loopback, and cloud metadata IPs.
 */
export function assertSafeExternalUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL scheme "${parsed.protocol}" is not allowed — only http/https URLs may be fetched.`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`URL host "${host}" is not allowed.`);
  }
  // IPv4 literal checks (loopback, private ranges, link-local incl. cloud metadata, unspecified).
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [parseInt(ipv4[1], 10), parseInt(ipv4[2], 10)];
    const isPrivate =
      a === 127 || a === 10 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
    if (isPrivate) throw new Error(`URL host "${host}" resolves to a private/loopback address and is not allowed.`);
  }
  // IPv6 loopback/link-local/unique-local checks.
  if (host === "::1" || host === "[::1]" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    throw new Error(`URL host "${host}" resolves to a private/loopback address and is not allowed.`);
  }
}

// ── Gmail API ─────────────────────────────────────────────────────────────────

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export async function gmailRequest(
  accessToken: string,
  path: string,
  method = "GET",
  body?: unknown
): Promise<unknown> {
  return googleFetch(`${GMAIL_BASE}${path}`, accessToken, method, body);
}

// ── Google Calendar API ───────────────────────────────────────────────────────

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

export async function calendarRequest(
  accessToken: string,
  path: string,
  method = "GET",
  body?: unknown
): Promise<unknown> {
  return googleFetch(`${CALENDAR_BASE}${path}`, accessToken, method, body);
}

// ── Google Drive API ──────────────────────────────────────────────────────────

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

export async function driveRequest(
  accessToken: string,
  path: string,
  method = "GET",
  body?: unknown
): Promise<unknown> {
  return googleFetch(`${DRIVE_BASE}${path}`, accessToken, method, body);
}

// ── Google Docs API ───────────────────────────────────────────────────────────

const DOCS_BASE = "https://docs.googleapis.com/v1/documents";

/**
 * Google Docs API request.
 * Parameter order matches the other API helpers (path before method).
 */
export async function docsRequest(
  accessToken: string,
  documentId: string,
  path = "",
  method = "GET",
  body?: unknown
): Promise<unknown> {
  return googleFetch(`${DOCS_BASE}/${documentId}${path}`, accessToken, method, body);
}

// ── Google Sheets API ─────────────────────────────────────────────────────────

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export async function sheetsRequest(
  accessToken: string,
  spreadsheetId: string,
  path = "",
  method = "GET",
  body?: unknown
): Promise<unknown> {
  return googleFetch(`${SHEETS_BASE}/${spreadsheetId}${path}`, accessToken, method, body);
}

// ── Google Slides API ─────────────────────────────────────────────────────────

const SLIDES_BASE = "https://slides.googleapis.com/v1/presentations";

export async function slidesRequest(
  accessToken: string,
  presentationId: string,
  endpoint: string,  // "" | ":batchUpdate" | "/pages/{pageId}" | "/pages/{pageId}/thumbnail"
  method = "GET",
  body?: unknown
): Promise<unknown> {
  return googleFetch(`${SLIDES_BASE}/${presentationId}${endpoint}`, accessToken, method, body);
}

// ── Google Apps Script API ────────────────────────────────────────────────────

const APPSSCRIPT_BASE = "https://script.googleapis.com/v1";

export async function appsScriptRequest(
  accessToken: string,
  path: string,
  method = "GET",
  body?: unknown
): Promise<unknown> {
  return googleFetch(`${APPSSCRIPT_BASE}${path}`, accessToken, method, body);
}
